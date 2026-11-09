import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Agent, emptyFs, type AgentOptions, type ModelSelection, type RunResult, type SDKCustomTool, type SDKCustomToolResult, type SDKJsonValue } from "@cursor/sdk";
import {
  DeveloperMessageItem,
  FunctionCallItem,
  FunctionCallOutputItem,
  InputTokenDetails,
  ModelMessageItem,
  OutputTokenDetails,
  SystemMessageItem,
  TokenUsage,
  UserMessageItem,
  type Endpoint,
  type InferenceInput,
  type InferenceOutput,
  type StructuredOutputFormat,
  type Tool,
} from "@mozaik-ai/core";
import Ajv from "ajv";
import type { GenerativeModel } from "../models";
import { AgentRun } from "../tracing";

/**
 * A Cursor model (any id from `Cursor.models.list()`, see cursor-models.ts) through the Cursor SDK (`@cursor/sdk`) as a Mozaik model. The SDK is an agent SDK, not a chat-completions API:
 * one `infer()` is one `Agent.prompt()` run in which Cursor drives the whole tool loop. Mozaik's tools are handed to it as
 * `local.customTools`, so Mozaik's own function_call loop (and its `function_call.*` events) never runs for this model and
 * `infer()` returns only the final ModelMessageItem. The SDK owns the endpoint and auth; `Agent.prompt` has no base URL option.
 */

export const CURSOR_CREDENTIAL_ENV = "CURSOR_API_KEY";
export const SUBMIT_RESULT_TOOL = "submit_result";
// The SDK spills MCP results over 40 KB to a /tmp file the model must `Read`, which these runs don't offer.
const MAX_TOOL_RESULT_CHARS = 30_000;

export type Prompt = (message: string, options: AgentOptions) => Promise<RunResult>;

const ajv = new Ajv({ allErrors: true, strict: false });

/** Instructions and the conversation so far as one prompt, since `Agent.prompt` takes a single string. */
export function flattenContext(input: InferenceInput) {
  const instructions: string[] = [];
  const turns: string[] = [];
  for (const item of input.context.getItems()) {
    if (item instanceof DeveloperMessageItem || item instanceof SystemMessageItem) instructions.push(item.content.text);
    else if (item instanceof UserMessageItem) turns.push(`## User\n\n${item.content.text}`);
    else if (item instanceof ModelMessageItem) turns.push(`## Assistant\n\n${item.content.text}`);
    else if (item instanceof FunctionCallItem) turns.push(`## Tool call ${item.name}\n\n${item.args}`);
    else if (item instanceof FunctionCallOutputItem) turns.push(`## Tool result\n\n${item.output.text}`);
  }
  const sections = [
    ...(instructions.length ? [`# Instructions\n\n${instructions.join("\n\n")}`] : []),
    ...(turns.length ? [`# Conversation\n\n${turns.join("\n\n")}`] : []),
  ];
  const tools = [...(input.tools ?? []).map((t) => t.name), ...(input.structuredOutput ? [SUBMIT_RESULT_TOOL] : [])];
  if (tools.length) sections.push(`# Tools\n\nYour tools are on the \`custom-user-tools\` MCP server: ${tools.map((t) => `\`${t}\``).join(", ")}.`);
  if (input.structuredOutput) {
    sections.push(
      `# Final answer\n\nWhen you are done, call the \`${SUBMIT_RESULT_TOOL}\` tool exactly once with your final answer as its arguments. ` +
        "Its arguments are the answer; text you write after it is ignored. If it reports an error, fix the arguments and call it again.",
    );
  }
  return sections.join("\n\n") || "(empty)";
}

const errorResult = (text: string): SDKCustomToolResult => ({ content: [{ type: "text", text }], isError: true });

const capped = (text: string) =>
  text.length > MAX_TOOL_RESULT_CHARS
    ? `${text.slice(0, MAX_TOOL_RESULT_CHARS / 2)}\n... [${text.length - MAX_TOOL_RESULT_CHARS} chars truncated] ...\n${text.slice(-MAX_TOOL_RESULT_CHARS / 2)}`
    : text;

function compileSchema(format: StructuredOutputFormat) {
  const validate = ajv.compile(format.schema);
  return (value: unknown) => (validate(value) ? undefined : ajv.errorsText(validate.errors, { dataVar: "result" }));
}

/** Wraps Mozaik tools as Cursor custom tools that call `tool.invoke`, traced as `execute_tool` spans on the active run. */
export function toCustomTools(tools: Tool[] | undefined, structuredOutput: StructuredOutputFormat | undefined) {
  const customTools: Record<string, SDKCustomTool> = {};
  const check = structuredOutput && compileSchema(structuredOutput);
  let submitted: Record<string, SDKJsonValue> | undefined;

  for (const tool of tools ?? []) {
    customTools[tool.name] = {
      description: tool.description,
      inputSchema: tool.parameters as Record<string, SDKJsonValue>,
      async execute(args, { toolCallId }) {
        const invoke = async () => {
          const out = await tool.invoke(args);
          return capped(typeof out === "string" ? out : JSON.stringify(out));
        };
        const run = AgentRun.current();
        try {
          return await (run ? run.executeTool(tool.name, invoke, () => undefined, toolCallId) : invoke());
        } catch (error) {
          // Same text as Mozaik's DefaultFunctionCallRunner, so the model can recover from tool errors the same way.
          return errorResult(`Error calling tool: ${error}`);
        }
      },
    };
  }

  if (structuredOutput && check) {
    customTools[SUBMIT_RESULT_TOOL] = {
      description: `Submit your final answer${structuredOutput.name ? ` (${structuredOutput.name})` : ""}. Call exactly once, when you are done.`,
      inputSchema: structuredOutput.schema as Record<string, SDKJsonValue>,
      execute(args) {
        const error = check(args);
        if (error) return errorResult(`Invalid result: ${error}. Call ${SUBMIT_RESULT_TOOL} again with corrected arguments.`);
        submitted = args;
        return "Result received.";
      },
    };
  }

  return { customTools, submitted: () => submitted, check };
}

function toTokenUsage(usage: RunResult["usage"]) {
  if (!usage) return undefined;
  return new TokenUsage(
    usage.inputTokens,
    usage.outputTokens,
    usage.totalTokens,
    new InputTokenDetails(usage.cacheReadTokens ?? 0),
    new OutputTokenDetails(usage.reasoningTokens ?? 0),
  );
}

function parseJson(text: string | undefined) {
  try {
    return JSON.parse(text ?? "") as unknown;
  } catch {
    return undefined;
  }
}

/** Host directory where the SDK keeps this agent's state and transcripts. It never changes what the model sees (`local.fs` does). */
function agentDir() {
  const dir = process.env.CURSOR_AGENT_CWD?.trim() || path.join(tmpdir(), "aleks-factory-cursor-agent");
  mkdirSync(dir, { recursive: true });
  return dir;
}

const unusedMapper = () => {
  throw new Error("The Cursor endpoint talks to the Cursor SDK directly and has no request mapper");
};

export class CursorEndpoint implements Endpoint {
  readonly endpointMapper = { toRequest: unusedMapper, toResponse: unusedMapper };

  constructor(
    private readonly selection: ModelSelection,
    private readonly prompt: Prompt = (message, options) => Agent.prompt(message, options),
  ) {}

  async infer(input: InferenceInput): Promise<InferenceOutput> {
    const apiKey = process.env[CURSOR_CREDENTIAL_ENV]?.trim();
    if (!apiKey) throw new Error(`${CURSOR_CREDENTIAL_ENV} is not set; add a Cursor API key to use ${this.selection.id}`);
    const { customTools, submitted, check } = toCustomTools(input.tools, input.structuredOutput);

    const result = await this.prompt(flattenContext(input), {
      apiKey,
      model: this.selection,
      // Only the MCP family, which is how custom tools are called: `tools: []` would also remove them. No built-in shell,
      // edit or read tools, so all work goes through the factory's sandboxed tools.
      tools: ["mcp"],
      // An empty tree for the native file layer: no host files, shell, hooks or git status reach the model. settingSources
      // and mcpServers stay unset, so no ambient rules or MCP servers load; `custom-user-tools` is the only server.
      local: { cwd: agentDir(), fs: emptyFs(), customTools },
    });
    if (result.status !== "finished") throw new Error(`Cursor run ${result.status}: ${result.error?.message ?? "no details"}`);

    let text = result.result ?? "";
    if (check) {
      let answer: unknown = submitted();
      if (answer === undefined) {
        // Fallback for a model that wrote the JSON answer as text instead of calling submit_result.
        const parsed = parseJson(result.result);
        if (parsed === undefined || check(parsed)) throw new Error(`${this.selection.id} finished without calling ${SUBMIT_RESULT_TOOL} with a valid result`);
        answer = parsed;
      }
      text = JSON.stringify(answer);
    }
    return { items: [ModelMessageItem.rehydrate({ text })], tokenUsage: toTokenUsage(result.usage), rowResponse: result };
  }

  async *stream(): AsyncGenerator<never> {
    throw new Error("Streaming is not implemented for the Cursor provider");
  }
}

/** A Cursor model as a Mozaik model; `selection.params` (e.g. a catalog variant's) are sent explicitly on every run. */
export function cursorModel(selection: ModelSelection, prompt?: Prompt): GenerativeModel {
  return {
    endpoint: new CursorEndpoint(selection, prompt),
    specification: {
      name: selection.id,
      provider: "cursor",
      supportsReasoningEffort: false,
      supportedReasoningEfforts: [],
      supportsStreaming: false,
      // The catalog doesn't report limits, and Cursor manages the run's context itself; 0 means unknown.
      contextWindowSize: 0,
      maxOutputTokens: 0,
      // Every Cursor model runs through this endpoint: Cursor calls the tools inside infer() (true lets Mozaik hand them
      // over), and structured output is emulated with the submit_result custom tool since the SDK has no response_format.
      supportsFunctionCalling: true,
      supportsStructuredOutput: true,
      supportedContextItemTypes: ["user_message", "system_message", "developer_message", "model_message"],
    },
  };
}
