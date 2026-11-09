import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Tool } from "@mozaik-ai/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAgentModels } from "./agent-models";
import { attrs, otlpCollector, spanTree, type OtlpSpan } from "./otlp-collector.test-helper";
import { AgentRun, parseRemote } from "./tracing";

const collector = otlpCollector();
const { requests } = collector;
beforeAll(() => collector.start());
afterAll(() => collector.stop());

const tool = (name: string, invoke: Tool["invoke"]): Tool => ({ type: "function", name, description: name, parameters: {}, strict: true, invoke });

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
    await run.step("workspace_setup", () => AgentRun.step("npm ci", async () => ({ ok: true })));
    await AgentRun.step("outside a run", async () => undefined);
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
    const byName = Object.fromEntries(spans.map((s) => [s.name, s]));
    expect(byName.workspace_setup.parentSpanId).toBe(root.spanId);
    expect(byName["npm ci"].parentSpanId).toBe(byName.workspace_setup.spanId);
    expect(byName["outside a run"]).toBeUndefined();
    expect(attrs(byOp.execute_tool.attributes)).toMatchObject({ "gen_ai.tool.name": "docker_exec", "gen_ai.tool.type": "function", "gen_ai.tool.call.id": "call_1" });
    expect(byOp.execute_tool.status?.code).toBe(2);
  });

  it("traces wrapped tools under the open chat span or else the root, with the call id from the endpoint or setToolCallId", async () => {
    requests.length = 0;
    const run = await AgentRun.start({ agentName: "review", model: "composer-2.5", provider: "cursor", vcs: { branch: "task/abcd1234" } });
    const runCommand = run.traceTool(tool("run_command", () => run.executeTool("docker_exec", async () => "TOOL OUTPUT", () => undefined)));
    const readFile = run.traceTool(tool("read_file", async () => "FILE CONTENTS"));
    const failing = run.traceTool(tool("edit_file", async () => Promise.reject(new Error("old text not found"))));

    // Mozaik's loop: one call at a time, the id announced right before it runs.
    run.setToolCallId("call_1");
    await readFile.invoke({ path: "a.ts" });
    run.setToolCallId("call_2");
    await expect(failing.invoke({})).rejects.toThrow("old text not found");
    // An endpoint running the loop inside a model turn (Cursor): parallel calls, each with its own id.
    await run.modelTurn(async () => {
      await Promise.all([
        AgentRun.withToolCallId("call_a", () => runCommand.invoke({ command: "ls" })),
        AgentRun.withToolCallId("call_b", () => readFile.invoke({ path: "b.ts" })),
      ]);
      return { tokenUsage: { inputTokens: 5, outputTokens: 2 } };
    });
    await run.end();

    const body = requests.map((r) => r.body).join("");
    expect(body).not.toContain("TOOL OUTPUT");
    expect(body).not.toContain("FILE CONTENTS");
    expect(body).not.toContain("a.ts");
    expect(spanTree(collector.sessionSpans())).toEqual([
      "chat composer-2.5",
      "  execute_tool read_file (call_b)",
      "  execute_tool run_command (call_a)",
      "    execute_tool docker_exec (call_a)",
      "execute_tool edit_file (call_2) [error]",
      "execute_tool read_file (call_1)",
    ]);
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
