import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAgentModels } from "./agent-models";
import { AgentRun, parseRemote } from "./tracing";

type OtlpValue = { stringValue?: string; intValue?: string | number; boolValue?: boolean };
type OtlpAttribute = { key: string; value: OtlpValue };
type OtlpSpan = { name: string; parentSpanId?: string; spanId: string; attributes: OtlpAttribute[]; status?: { code?: number } };

const requests: { url?: string; headers: IncomingHttpHeaders; body: string }[] = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    requests.push({ url: req.url, headers: req.headers, body });
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.DASH0_OTLP_ENDPOINT = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  process.env.DASH0_AUTH_TOKEN = "test-token";
  process.env.DASH0_DATASET = "test-dataset";
});

afterAll(() => {
  delete process.env.DASH0_OTLP_ENDPOINT;
  delete process.env.DASH0_AUTH_TOKEN;
  delete process.env.DASH0_DATASET;
  server.close();
});

const attrs = (list: OtlpAttribute[]) =>
  Object.fromEntries(list.map(({ key, value }) => [key, value.stringValue ?? (value.intValue !== undefined ? Number(value.intValue) : value.boolValue)]));

describe("parseRemote", () => {
  it("parses ssh and https GitHub remotes", () => {
    expect(parseRemote("git@github.com:acme/widgets.git")).toEqual({ owner: "acme", name: "widgets", url: "https://github.com/acme/widgets" });
    expect(parseRemote("https://github.com/acme/widgets")).toEqual({ owner: "acme", name: "widgets", url: "https://github.com/acme/widgets" });
  });
});

describe("AgentRun", () => {
  it("exports a session with chat and docker_exec spans to Dash0 over OTLP/HTTP", async () => {
    const run = await AgentRun.start({
      agentName: "implement",
      model: "gpt-5.5",
      provider: "openai",
      vcs: { branch: "task/abcd1234", startingCommit: "deadbeef", remoteUrl: "git@github.com:acme/widgets.git", issueUrl: "http://localhost:3000/projects/p?task=t" },
    });
    await run.modelTurn(async () => ({ tokenUsage: { inputTokens: 120, outputTokens: 30 }, secret: "PROMPT BODY" }));
    run.setToolCallId("call_1");
    await run.executeTool("docker_exec", async () => ({ ok: false, exitCode: 2, stdout: "TOOL OUTPUT" }), (r) => (r.ok ? undefined : `exit ${r.exitCode}`));
    run.setAttributes({ "dash0.gen_ai.vcs.ref.head.merge_commit": "cafef00d" });
    await run.end();

    expect(requests).toHaveLength(1);
    const [{ url, headers, body }] = requests;
    expect(url).toBe("/v1/traces");
    expect(headers.authorization).toBe("Bearer test-token");
    expect(headers["dash0-dataset"]).toBe("test-dataset");
    expect(body).not.toContain("PROMPT BODY");
    expect(body).not.toContain("TOOL OUTPUT");

    const { resourceSpans } = JSON.parse(body);
    const resource = attrs(resourceSpans[0].resource.attributes);
    expect(resource).toMatchObject({ "service.name": "software-factory", "gen_ai.agent.name": "implement", "gen_ai.conversation.id": run.conversationId });
    expect(resourceSpans[0].scopeSpans[0].scope.name).toBe("dash0-agent-plugin");
    const spans: OtlpSpan[] = resourceSpans[0].scopeSpans[0].spans;
    const byOp = Object.fromEntries(spans.map((s) => [attrs(s.attributes)["gen_ai.operation.name"], s]));
    const root = byOp.invoke_agent;

    for (const span of spans) {
      expect(attrs(span.attributes)).toMatchObject({
        "service.name": "software-factory",
        "service.version": expect.any(String),
        "gen_ai.harness.name": "mozaik",
        "gen_ai.agent.name": "implement",
        "gen_ai.provider.name": "openai",
        "gen_ai.conversation.id": run.conversationId,
        "dash0.gen_ai.vcs.ref.head.name": "task/abcd1234",
        "dash0.gen_ai.vcs.ref.head.type": "branch",
        "dash0.gen_ai.vcs.ref.head.starting_commit": "deadbeef",
        "dash0.gen_ai.vcs.repository.name": "widgets",
        "dash0.gen_ai.vcs.repository.url.full": "https://github.com/acme/widgets",
        "dash0.gen_ai.vcs.owner.name": "acme",
        "dash0.gen_ai.vcs.provider.name": "github",
        "dash0.gen_ai.vcs.issue.url": "http://localhost:3000/projects/p?task=t",
      });
      expect(Object.keys(attrs(span.attributes))).not.toContain("gen_ai.input.messages");
    }
    expect(attrs(byOp.chat.attributes)).toMatchObject({ "gen_ai.request.model": "gpt-5.5", "gen_ai.usage.input_tokens": 120, "gen_ai.usage.output_tokens": 30 });
    expect(attrs(root.attributes)["dash0.gen_ai.vcs.ref.head.merge_commit"]).toBe("cafef00d");
    expect(byOp.chat.parentSpanId).toBe(root.spanId);
    expect(attrs(byOp.execute_tool.attributes)).toMatchObject({ "gen_ai.tool.name": "docker_exec", "gen_ai.tool.type": "function", "gen_ai.tool.call.id": "call_1" });
    expect(byOp.execute_tool.status?.code).toBe(2);
  });

  it("nests tools run inside a model turn under its chat span, with per-call ids even when calls run in parallel", async () => {
    requests.length = 0;
    const run = await AgentRun.start({ agentName: "review", model: "composer-2.5", provider: "cursor", vcs: { branch: "task/abcd1234" } });
    run.setToolCallId("stale");
    await run.modelTurn(async () => {
      expect(AgentRun.current()).toBe(run);
      await Promise.all([
        run.executeTool("run_command", () => run.executeTool("docker_exec", async () => "TOOL OUTPUT", () => undefined), () => undefined, "call_a"),
        run.executeTool("read_file", async () => "FILE CONTENTS", () => undefined, "call_b"),
      ]);
      return { tokenUsage: { inputTokens: 5, outputTokens: 2 } };
    });
    expect(AgentRun.current()).toBeUndefined();
    await run.executeTool("docker_exec", async () => "", () => undefined);
    await run.end();

    const body = requests.map((r) => r.body).join("");
    expect(body).not.toContain("TOOL OUTPUT");
    expect(body).not.toContain("FILE CONTENTS");
    const spans: OtlpSpan[] = JSON.parse(body).resourceSpans[0].scopeSpans[0].spans;
    const span = (name: string, index = 0) => spans.filter((s) => s.name === name)[index];
    const callId = (s: OtlpSpan) => attrs(s.attributes)["gen_ai.tool.call.id"];
    const chat = span("chat composer-2.5");
    const root = span("invoke_agent review");
    expect(span("execute_tool run_command").parentSpanId).toBe(chat.spanId);
    expect(span("execute_tool read_file").parentSpanId).toBe(chat.spanId);
    expect(callId(span("execute_tool run_command"))).toBe("call_a");
    expect(callId(span("execute_tool read_file"))).toBe("call_b");
    const dockerExecs = spans.filter((s) => s.name === "execute_tool docker_exec");
    const nested = dockerExecs.find((s) => s.parentSpanId === span("execute_tool run_command").spanId)!;
    const after = dockerExecs.find((s) => s.parentSpanId === root.spanId)!;
    expect(dockerExecs).toHaveLength(2);
    expect(callId(nested)).toBe("call_a");
    expect(after.parentSpanId).toBe(root.spanId);
    expect(callId(after)).toBe("stale");
  });

  it("reports each agent's configured model and provider on its own session", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tracing-models-"));
    const models = createAgentModels(path.join(dir, "agent-models.json"));
    await models.save({ implement: { provider: "anthropic", model: "claude-opus-5-5" }, review: { provider: "google", model: "gemini-3.1-pro-preview" } });
    requests.length = 0;
    for (const agentName of ["implement", "review"] as const) {
      const { model, provider } = await models.resolve(agentName);
      const run = await AgentRun.start({ agentName, model, provider, vcs: { branch: "task/abcd1234" } });
      await run.modelTurn(async () => ({ tokenUsage: { inputTokens: 1, outputTokens: 1 } }));
      await run.end();
    }
    await rm(dir, { recursive: true, force: true });

    const sessions = requests.map(({ body }) => {
      const spans: OtlpSpan[] = JSON.parse(body).resourceSpans[0].scopeSpans[0].spans;
      return Object.fromEntries(spans.map((s) => [attrs(s.attributes)["gen_ai.operation.name"], { name: s.name, ...attrs(s.attributes) }]));
    });
    expect(sessions).toHaveLength(2);
    expect(sessions[0].chat).toMatchObject({ name: "chat claude-opus-5-5", "gen_ai.agent.name": "implement", "gen_ai.provider.name": "anthropic", "gen_ai.request.model": "claude-opus-5-5" });
    expect(sessions[0].invoke_agent).toMatchObject({ "gen_ai.provider.name": "anthropic", "gen_ai.request.model": "claude-opus-5-5" });
    expect(sessions[1].chat).toMatchObject({ name: "chat gemini-3.1-pro-preview", "gen_ai.agent.name": "review", "gen_ai.provider.name": "google", "gen_ai.request.model": "gemini-3.1-pro-preview" });
  });
});
