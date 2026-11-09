import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { diag, DiagConsoleLogger, DiagLogLevel, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace, type Attributes, type Span } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import type { Tool } from "@mozaik-ai/core";
import { version } from "../../package.json";
import { execFileAsync } from "./docker";
import type { AgentName } from "./factory-agents";

/**
 * OpenTelemetry tracing of agent sessions for Dash0 AI SDLC Insights, enabled when DASH0_OTLP_ENDPOINT and DASH0_AUTH_TOKEN are set.
 * Each agent run is one session (`gen_ai.conversation.id`) with its own tracer provider, so the session attributes are both resource
 * and span attributes. Only metadata is exported: never prompts, messages, tool arguments or tool output.
 */

export type VcsInfo = { branch: string; startingCommit?: string; remoteUrl?: string; pullRequestUrl?: string; issueUrl?: string };

export type AgentRunOptions = { agentName: AgentName; vcs: VcsInfo; model?: string; provider?: string };

type TokenUsage = { inputTokens: number; outputTokens: number };

const SERVICE_NAME = "software-factory";
const HARNESS_NAME = "mozaik";
// AI SDLC Insights only counts sessions from this instrumentation scope (the one Dash0's own agent plugin uses).
const SCOPE_NAME = "dash0-agent-plugin";

function exporterConfig() {
  const endpoint = process.env.DASH0_OTLP_ENDPOINT?.trim();
  const token = process.env.DASH0_AUTH_TOKEN?.trim();
  if (!endpoint || !token) return undefined;
  const dataset = process.env.DASH0_DATASET?.trim();
  return {
    url: `${endpoint.replace(/\/+$/, "").replace(/\/v1\/traces$/, "")}/v1/traces`,
    headers: { Authorization: `Bearer ${token}`, ...(dataset && { "Dash0-Dataset": dataset }) },
  };
}

const gitValue = (args: string[]) => execFileAsync("git", args).then(({ stdout }) => stdout.trim() || undefined, () => undefined);

let userName: Promise<string | undefined> | undefined;
let factoryRemote: Promise<string | undefined> | undefined;

/** Splits a GitHub remote (ssh or https) into owner, name and its https URL. */
export function parseRemote(remote: string) {
  const match = remote.trim().match(/^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)[:/](.+?)\/([^/]+?)(?:\.git)?\/?$/i);
  if (!match) return undefined;
  const [, host, owner, name] = match;
  return { owner, name, url: `https://${host}/${owner}/${name}` };
}

function vcsAttributes(vcs: VcsInfo, remoteUrl: string | undefined): Attributes {
  const repo = remoteUrl ? parseRemote(remoteUrl) : undefined;
  return {
    "dash0.gen_ai.vcs.provider.name": "github",
    "dash0.gen_ai.vcs.ref.head.name": vcs.branch,
    "dash0.gen_ai.vcs.ref.head.type": "branch",
    "dash0.gen_ai.vcs.ref.head.starting_commit": vcs.startingCommit,
    "dash0.gen_ai.vcs.repository.name": repo?.name,
    "dash0.gen_ai.vcs.repository.url.full": repo?.url,
    "dash0.gen_ai.vcs.owner.name": repo?.owner,
    "dash0.gen_ai.vcs.pull_request.url": vcs.pullRequestUrl,
    "dash0.gen_ai.vcs.issue.url": vcs.issueUrl,
  };
}

const defined = (attributes: Attributes) => Object.fromEntries(Object.entries(attributes).filter(([, v]) => v !== undefined)) as Attributes;

/** The tool span in flight, so spans started inside it (run_command's docker_exec) nest under it and share its call id. */
const activeTool = new AsyncLocalStorage<{ run: AgentRun; span: Span; callId: string }>();
/** The chat span in flight, so tools an endpoint runs inside its model turn (Cursor) nest under it. */
const activeChat = new AsyncLocalStorage<{ run: AgentRun; span: Span }>();
/** The call id an endpoint that runs the tool loop itself (Cursor) gave the tool call in flight. */
const endpointCallId = new AsyncLocalStorage<string>();
/** The non-model step in flight (workspace setup), so steps started inside it (npm ci) nest under it. */
const activeStep = new AsyncLocalStorage<{ run: AgentRun; span: Span }>();

export class AgentRun {
  readonly conversationId = randomUUID();
  private readonly provider?: TracerProvider;
  private readonly root: Span;
  private readonly attributes: Attributes;
  private pendingToolCallId?: string;
  private ended = false;

  private constructor(private readonly options: AgentRunOptions, config: ReturnType<typeof exporterConfig>, extra: Attributes) {
    this.attributes = defined({
      "service.name": SERVICE_NAME,
      "service.version": version,
      "gen_ai.harness.name": process.env.DASH0_HARNESS_NAME?.trim() || HARNESS_NAME,
      "gen_ai.agent.name": options.agentName,
      "gen_ai.provider.name": options.provider,
      "gen_ai.conversation.id": this.conversationId,
      ...extra,
    });
    if (config) {
      this.provider = new TracerProvider({
        resource: resourceFromAttributes(this.attributes),
        spanProcessors: [new BatchSpanProcessor({ exporter: new OTLPTraceExporter(config) })],
      });
    }
    this.root = this.startSpan(`invoke_agent ${options.agentName}`, SpanKind.INTERNAL, {
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.request.model": options.model,
    });
  }

  /** Starts a session span tree; a no-op (non-recording spans) when Dash0 isn't configured. */
  static async start(options: AgentRunOptions) {
    const config = exporterConfig();
    if (!config) return new AgentRun(options, undefined, {});
    // Surfaces export failures (bad endpoint or token) without logging request contents.
    diag.setLogger(new DiagConsoleLogger(), { logLevel: DiagLogLevel.WARN, suppressOverrideMessage: true });
    const [user, fallbackRemote] = await Promise.all([
      (userName ??= gitValue(["config", "user.name"])),
      options.vcs.remoteUrl ? undefined : (factoryRemote ??= gitValue(["remote", "get-url", "origin"])),
    ]);
    return new AgentRun(options, config, { "user.name": user, ...vcsAttributes(options.vcs, options.vcs.remoteUrl ?? fallbackRemote) });
  }

  private startSpan(name: string, kind: SpanKind, attributes: Attributes, parent?: Span) {
    const tracer = this.provider?.getTracer(SCOPE_NAME, version) ?? trace.getTracer(SCOPE_NAME);
    const context = parent ? trace.setSpan(ROOT_CONTEXT, parent) : ROOT_CONTEXT;
    return tracer.startSpan(name, { kind, attributes: defined({ ...this.attributes, ...attributes }) }, context);
  }

  private async traced<T>(span: Span, fn: () => Promise<T>, onResult: (result: T) => void) {
    try {
      const result = await fn();
      onResult(result);
      return result;
    } catch (error) {
      fail(span, error);
      throw error;
    } finally {
      span.end();
    }
  }

  /** Runs `fn` (which invokes one traced tool) with the call id the endpoint assigned, for calls that may run concurrently. */
  static withToolCallId<T>(callId: string | undefined, fn: () => T) {
    return callId ? endpointCallId.run(callId, fn) : fn();
  }

  /** One model turn: a `chat` span with the model and token counts. Tools run inside it (Cursor) nest under it. */
  modelTurn<T extends { tokenUsage?: TokenUsage }>(fn: () => Promise<T>) {
    const model = this.options.model;
    const span = this.startSpan(`chat ${model ?? ""}`.trim(), SpanKind.CLIENT, { "gen_ai.operation.name": "chat", "gen_ai.request.model": model }, this.root);
    return this.traced(span, () => activeChat.run({ run: this, span }, fn), ({ tokenUsage }) => {
      if (!tokenUsage) return;
      span.setAttributes({ "gen_ai.usage.input_tokens": tokenUsage.inputTokens, "gen_ai.usage.output_tokens": tokenUsage.outputTokens });
    });
  }

  /** Records the id of the tool call Mozaik's loop is about to run (it runs one at a time), so the next tool span carries it. */
  setToolCallId(callId: string) {
    this.pendingToolCallId = callId;
  }

  /**
   * One tool execution: an `execute_tool` span under the tool span it runs in (sharing its call id), else under the open
   * chat span (an endpoint like Cursor running its tool loop inside the model turn), else under the session root, next to
   * the chat spans (Mozaik's loop runs tools between turns). Otherwise the call id is the endpoint's (`withToolCallId`),
   * else the one from `setToolCallId`. `failure` returns an error description for results that count as failed.
   */
  executeTool<T>(name: string, fn: () => Promise<T>, failure: (result: T) => string | undefined) {
    const store = activeTool.getStore();
    const parent = store?.run === this ? store : undefined;
    const chat = activeChat.getStore();
    let id = parent?.callId ?? endpointCallId.getStore();
    if (!id) {
      id = this.pendingToolCallId ?? randomUUID();
      this.pendingToolCallId = undefined;
    }
    const callId = id;
    const span = this.startSpan(`execute_tool ${name}`, SpanKind.INTERNAL, {
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": name,
      "gen_ai.tool.type": "function",
      "gen_ai.tool.call.id": callId,
    }, parent?.span ?? (chat?.run === this ? chat.span : this.root));
    return this.traced(span, () => activeTool.run({ run: this, span, callId }, fn), (result) => {
      const error = failure(result);
      if (error) fail(span, new Error(error));
    });
  }

  /**
   * The tracing layer at the tool boundary: the same tool with each invocation an `execute_tool` span, whichever path
   * (Mozaik's function-call loop or an endpoint like Cursor) invokes it. Thrown errors mark the span failed.
   */
  traceTool(tool: Tool): Tool {
    return { ...tool, invoke: (args) => this.executeTool(tool.name, () => tool.invoke(args), () => undefined) };
  }

  /** A non-model, non-tool step (e.g. workspace setup) as an internal span; steps started inside it nest under it. */
  step<T>(name: string, fn: () => Promise<T>) {
    const store = activeStep.getStore();
    const span = this.startSpan(name, SpanKind.INTERNAL, {}, store?.run === this ? store.span : this.root);
    return this.traced(span, () => activeStep.run({ run: this, span }, fn), () => {});
  }

  /** Runs `fn` as a step of the step in flight (e.g. `npm ci` inside workspace setup), or untraced outside one. */
  static step<T>(name: string, fn: () => Promise<T>) {
    return activeStep.getStore()?.run.step(name, fn) ?? fn();
  }

  /** Adds attributes learned during the run (e.g. the merge commit) to the session's root span. */
  setAttributes(attributes: Attributes) {
    this.root.setAttributes(defined(attributes));
  }

  /** Wraps a whole non-model step (e.g. merging) in the session's root span. */
  async run<T>(fn: () => Promise<T>) {
    try {
      const result = await fn();
      await this.end();
      return result;
    } catch (error) {
      await this.end(error);
      throw error;
    }
  }

  /** Ends the session and flushes its spans; `error` marks the session failed. */
  async end(error?: unknown) {
    if (this.ended) return;
    this.ended = true;
    if (error !== undefined) fail(this.root, error);
    this.root.end();
    await this.provider?.shutdown().catch((e) => console.error("[tracing] failed to flush spans", e));
  }
}

function fail(span: Span, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  span.setStatus({ code: SpanStatusCode.ERROR, message: message.slice(0, 500) });
  span.setAttribute("error.type", error instanceof Error ? error.name : "Error");
}
