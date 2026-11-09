import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentOptions, RunResult, SDKCustomTool } from "@cursor/sdk";
import { FunctionCallItem, ModelMessageItem, type InferenceOutput } from "@mozaik-ai/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { executeTask } from "./agent";
import type { ResolvedModel } from "./agent-models";
import type { CommandResult } from "./docker-sandbox";
import type { GenerativeModel } from "./models";
import { otlpCollector, spanTree } from "./otlp-collector.test-helper";
import { cursorModel } from "./providers/cursor";
import type { Task } from "./tasks";

// The real Mozaik runtime, agent wiring and coding tools; the model, workspace, sandbox and stores are fakes.
const fakes = vi.hoisted(() => ({
  dir: "",
  model: undefined as unknown as ResolvedModel,
  exec: vi.fn(async (): Promise<CommandResult> => ({ ok: false, exitCode: 1, timedOut: false, stdout: "COMMAND OUTPUT", stderr: "" })),
  updateTask: vi.fn(async (): Promise<Task | undefined> => undefined),
}));
vi.mock("./agent-models", () => ({ agentModels: { resolve: async () => fakes.model } }));
vi.mock("./activity-log", () => ({ addActivity: () => 1, updateActivity: () => {} }));
vi.mock("./docker-sandbox", () => ({
  DockerSandbox: class {
    start = async () => {};
    exec = fakes.exec;
    dispose = async () => {};
  },
}));
vi.mock("./egress", () => ({ openEgress: async () => undefined, closeEgress: async () => {} }));
vi.mock("./project-store", () => ({ getProject: async () => ({ allowedDomains: [] }) }));
vi.mock("./task-store", () => ({ listTasks: async () => [], updateTask: fakes.updateTask }));
vi.mock("./workspace", () => ({
  hasWorktree: () => true,
  ensureWorktree: async () => ({ dir: fakes.dir, branch: "task/abcd1234" }),
  taskVcs: async () => ({ branch: "task/abcd1234" }),
  syncWithMain: async () => [],
  changedSince: async () => [],
  headRevision: async () => "deadbeef",
  taskKey: () => "key",
  worktreeDir: () => fakes.dir,
}));
const collector = otlpCollector();
const cursorKey = process.env.CURSOR_API_KEY;
beforeAll(async () => {
  delete process.env.MOZAIK_API_KEY;
  process.env.CURSOR_API_KEY = "cursor-test-key";
  fakes.dir = await mkdtemp(path.join(tmpdir(), "agent-tracing-"));
  await writeFile(path.join(fakes.dir, "README.md"), "FILE CONTENTS\n");
  await collector.start();
});
afterAll(async () => {
  collector.stop();
  if (cursorKey === undefined) delete process.env.CURSOR_API_KEY;
  else process.env.CURSOR_API_KEY = cursorKey;
  await rm(fakes.dir, { recursive: true, force: true });
});
beforeEach(() => {
  collector.requests.length = 0;
  fakes.exec.mockClear();
});

const CALLS = [
  { callId: "call_read", name: "read_file", args: { path: "README.md" } },
  { callId: "call_run", name: "run_command", args: { command: "npm test" } },
  { callId: "call_missing", name: "read_file", args: { path: "missing.md" } },
];

const task: Task = { id: "t1", projectId: "p1", title: "Add a README", description: "", status: "in_progress", branch: "task/abcd1234", createdAt: "", updatedAt: "" };

/** A provider model whose endpoint asks for one tool call per inference, like OpenAI/Gemini/DeepSeek through Mozaik's loop. */
function mozaikModel(): ResolvedModel {
  let turn = 0;
  const endpoint = {
    async infer(): Promise<InferenceOutput> {
      const call = CALLS[turn++];
      const item = call ? FunctionCallItem.rehydrate({ ...call, args: JSON.stringify(call.args) }) : ModelMessageItem.rehydrate({ text: "Done." });
      return { items: [item], tokenUsage: undefined, rowResponse: null };
    },
  };
  const generative = { endpoint, specification: { name: "gpt-5.5", provider: "openai" } } as unknown as GenerativeModel;
  return { provider: "openai", model: "gpt-5.5", source: "settings", supported: true, generative };
}

/** A Cursor model whose fake Agent.prompt calls the same tools through the custom-tool bridge in one run. */
function cursorPathModel(): ResolvedModel {
  const prompt = vi.fn(async (_message: string, options: AgentOptions) => {
    const tools = options.local?.customTools as Record<string, SDKCustomTool>;
    for (const { callId, name, args } of CALLS) await tools[name].execute(args as never, { toolCallId: callId });
    return { id: "run-1", status: "finished", result: "Done." } as RunResult;
  });
  return { provider: "cursor", model: "composer-2.5", source: "settings", supported: true, generative: cursorModel({ id: "composer-2.5" }, prompt) };
}

async function traceOf(model: ResolvedModel) {
  fakes.model = model;
  executeTask(task);
  await vi.waitFor(() => expect(collector.requests).toHaveLength(1), { timeout: 5000 });
  const body = collector.requests[0].body;
  for (const secret of ["FILE CONTENTS", "COMMAND OUTPUT", "npm test", "README.md"]) expect(body).not.toContain(secret);
  return spanTree(collector.sessionSpans());
}

const TOOL_SPANS = [
  "execute_tool read_file (call_missing) [error]",
  "execute_tool read_file (call_read)",
  "execute_tool run_command (call_run)",
  "  execute_tool docker_exec (call_run) [error]",
];

describe("agent tool tracing", () => {
  it("gives each tool call in Mozaik's loop one execute_tool span under the root, next to the per-turn chat spans", async () => {
    const tree = await traceOf(mozaikModel());
    expect(tree).toEqual([...Array(4).fill("chat gpt-5.5"), ...TOOL_SPANS]);
    expect(fakes.exec).toHaveBeenCalledWith("npm test");
  });

  it("produces the same tool spans when Cursor runs the tool loop, one per call, nested under its one chat span", async () => {
    const tree = await traceOf(cursorPathModel());
    expect(tree).toEqual(["chat composer-2.5", ...TOOL_SPANS.map((line) => `  ${line}`)]);
    expect(fakes.exec).toHaveBeenCalledWith("npm test");
  });
});
