import type { AgentOptions, RunResult, SDKCustomTool, SDKCustomToolResult } from "@cursor/sdk";
import { DeveloperMessageItem, ModelContext, ModelMessageItem, UserMessageItem, type InferenceInput, type Tool } from "@mozaik-ai/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { otlpCollector, spanTree, toolSpanViolations } from "../otlp-collector.test-helper";
import { AgentRun } from "../tracing";
import { CursorEndpoint, cursorModel, flattenContext, SUBMIT_RESULT_TOOL } from "./cursor";

const collector = otlpCollector();
beforeAll(() => collector.start());
afterAll(() => collector.stop());

// Nothing reaches the network: every test injects `prompt` or uses this mock.
const sdk = vi.hoisted(() => ({ prompt: vi.fn(), emptyFs: vi.fn(() => ({ kind: "empty-fs" })) }));
vi.mock("@cursor/sdk", () => ({ Agent: { prompt: sdk.prompt }, emptyFs: sdk.emptyFs }));

const key = process.env.CURSOR_API_KEY;
beforeEach(() => {
  process.env.CURSOR_API_KEY = "cursor-test-key";
  sdk.prompt.mockReset();
});
afterEach(() => {
  if (key === undefined) delete process.env.CURSOR_API_KEY;
  else process.env.CURSOR_API_KEY = key;
});

const COMPOSER = { id: "composer-2.5" };
const usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 5, totalTokens: 120, reasoningTokens: 7 };
const finished = (result: string): RunResult => ({ id: "run-1", status: "finished", result, usage });

function inputWith(extra: Partial<InferenceInput> = {}): InferenceInput {
  const context = ModelContext.create()
    .addContextItem(DeveloperMessageItem.create("You are a coding agent."))
    .addContextItem(UserMessageItem.create("Add a README."))
    .addContextItem(ModelMessageItem.rehydrate({ text: "Done earlier." }));
  return { model: "composer-2.5", context, ...extra };
}

const tool = (name: string, invoke: Tool["invoke"]): Tool => ({
  type: "function",
  name,
  description: `The ${name} tool`,
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
  strict: true,
  invoke: vi.fn(invoke),
});

const readFile = () => tool("read_file", async ({ path }: { path: string }) => `contents of ${path}`);

const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["approve", "request_changes"] },
    summary: { type: "string" },
    findings: { type: "array", items: { type: "string" } },
  },
  required: ["verdict", "summary", "findings"],
  additionalProperties: false,
};

type Call = [name: string, args: Record<string, unknown>, callId?: string];

/** A fake Agent.prompt that calls the given custom tools like Cursor would (one batch runs in parallel), then finishes. */
function fakePrompt(batches: Call[][], result = "All done.") {
  return vi.fn(async (_message: string, options: AgentOptions) => {
    const tools = options.local?.customTools as Record<string, SDKCustomTool>;
    const outputs: SDKCustomToolResult[] = [];
    for (const batch of batches) {
      outputs.push(...(await Promise.all(batch.map(([name, args, toolCallId]) => tools[name].execute(args as never, { toolCallId })))));
    }
    return { ...finished(result), outputs } as RunResult;
  });
}

const outputsOf = (output: { rowResponse: unknown }) => (output.rowResponse as { outputs: SDKCustomToolResult[] }).outputs;
const answerText = (output: { items: unknown[] }) => (output.items[0] as ModelMessageItem).content.text;

describe("CursorEndpoint", () => {
  it("runs one Agent.prompt with only custom tools and maps the answer and token usage", async () => {
    const read = readFile();
    const prompt = fakePrompt([[["read_file", { path: "package.json" }, "call_1"]]]);
    const output = await new CursorEndpoint(COMPOSER, prompt).infer(inputWith({ tools: [read] }));

    expect(prompt).toHaveBeenCalledTimes(1);
    const [message, options] = prompt.mock.calls[0];
    expect(message).toContain("# Instructions\n\nYou are a coding agent.");
    expect(message).toContain("## User\n\nAdd a README.");
    expect(message).toContain("## Assistant\n\nDone earlier.");
    expect(message).toContain("`custom-user-tools` MCP server: `read_file`");
    expect(options).toMatchObject({ apiKey: "cursor-test-key", model: { id: "composer-2.5" }, tools: ["mcp"] });
    expect(options).not.toHaveProperty("mcpServers");
    expect(options).not.toHaveProperty("disallowedTools");
    expect(options.local).not.toHaveProperty("settingSources");
    expect(options.local?.fs).toEqual({ kind: "empty-fs" });
    expect(Object.keys(options.local?.customTools ?? {})).toEqual(["read_file"]);
    expect(options.local?.customTools?.read_file.inputSchema).toBe(read.parameters);
    expect(read.invoke).toHaveBeenCalledWith({ path: "package.json" });
    expect(outputsOf(output)).toEqual(["contents of package.json"]);

    expect(output.items).toHaveLength(1);
    expect(output.items[0]).toBeInstanceOf(ModelMessageItem);
    expect(answerText(output)).toBe("All done.");
    expect(output.tokenUsage).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      inputTokenDetails: { cached_tokens: 30 },
      outputTokenDetails: { reasoning_tokens: 7 },
    });
  });

  it("returns tool errors to the model as text and caps large tool results", async () => {
    const failing = tool("run_command", async () => Promise.reject(new Error("container is gone")));
    const big = tool("list_files", async () => "x".repeat(50_000));
    const prompt = fakePrompt([[["run_command", { path: "." }], ["list_files", { path: "." }]]]);
    const output = await new CursorEndpoint(COMPOSER, prompt).infer(inputWith({ tools: [failing, big] }));
    const [error, listing] = outputsOf(output);
    expect(error).toEqual({ content: [{ type: "text", text: "Error calling tool: Error: container is gone" }], isError: true });
    expect((listing as string).length).toBeLessThan(31_000);
    expect(listing).toContain("chars truncated");
  });

  it("emulates structured output with submit_result and returns its args as the answer JSON", async () => {
    const review = { verdict: "approve", summary: "Looks good", findings: [] };
    const prompt = fakePrompt([[[SUBMIT_RESULT_TOOL, review]]], "OK, submitted.");
    const output = await new CursorEndpoint(COMPOSER, prompt).infer(
      inputWith({ tools: [readFile()], structuredOutput: { name: "code_review", schema: REVIEW_SCHEMA } }),
    );

    const [message, options] = prompt.mock.calls[0];
    expect(message).toContain("call the `submit_result` tool exactly once");
    expect(options.local?.customTools?.[SUBMIT_RESULT_TOOL].inputSchema).toBe(REVIEW_SCHEMA);
    expect(JSON.parse(answerText(output))).toEqual(review);
  });

  it("rejects submit_result args that don't match the schema, so the model can retry", async () => {
    const bad = { verdict: "lgtm", summary: "Looks good" };
    const good = { verdict: "request_changes", summary: "Missing test", findings: ["add a test"] };
    const prompt = fakePrompt([[[SUBMIT_RESULT_TOOL, bad]], [[SUBMIT_RESULT_TOOL, good]]]);
    const output = await new CursorEndpoint(COMPOSER, prompt).infer(inputWith({ structuredOutput: { schema: REVIEW_SCHEMA } }));

    const [rejected, accepted] = outputsOf(output);
    expect(rejected).toMatchObject({ isError: true });
    expect(JSON.stringify(rejected)).toMatch(/Invalid result: .*(findings|allowed values)/);
    expect(accepted).toBe("Result received.");
    expect(JSON.parse(answerText(output))).toEqual(good);
  });

  it("accepts a valid JSON answer written as text, and fails a structured turn without a valid result", async () => {
    const review = { verdict: "approve", summary: "ok", findings: [] };
    const asText = await new CursorEndpoint(COMPOSER, fakePrompt([], JSON.stringify(review))).infer(inputWith({ structuredOutput: { schema: REVIEW_SCHEMA } }));
    expect(JSON.parse(answerText(asText))).toEqual(review);

    const structured = inputWith({ structuredOutput: { schema: REVIEW_SCHEMA } });
    await expect(new CursorEndpoint(COMPOSER, fakePrompt([], "I approve.")).infer(structured)).rejects.toThrow(/without calling submit_result/);
    const invalid = fakePrompt([[[SUBMIT_RESULT_TOOL, { verdict: "maybe" }]]], '{"verdict":"maybe"}');
    await expect(new CursorEndpoint(COMPOSER, invalid).infer(structured)).rejects.toThrow(/without calling submit_result with a valid result/);
  });

  it("surfaces failed runs and a missing CURSOR_API_KEY as errors", async () => {
    const errored = vi.fn(async () => ({ id: "r", status: "error", error: { message: "Bad model name" } }) as RunResult);
    await expect(new CursorEndpoint(COMPOSER, errored).infer(inputWith())).rejects.toThrow("Cursor run error: Bad model name");
    delete process.env.CURSOR_API_KEY;
    await expect(new CursorEndpoint(COMPOSER, errored).infer(inputWith())).rejects.toThrow("CURSOR_API_KEY is not set");
    expect(errored).toHaveBeenCalledTimes(1);
  });

  it("calls the SDK's Agent.prompt by default (mocked here), sending the model's explicit params", async () => {
    sdk.prompt.mockResolvedValue(finished("hi"));
    const grok = cursorModel({ id: "grok-4.7", params: [{ id: "effort", value: "high" }] });
    expect(grok.specification).toMatchObject({ name: "grok-4.7", provider: "cursor", supportsFunctionCalling: true, supportsStructuredOutput: true });
    const output = await grok.endpoint.infer(inputWith());
    expect(sdk.prompt).toHaveBeenCalledWith(
      expect.stringContaining("Add a README."),
      expect.objectContaining({ model: { id: "grok-4.7", params: [{ id: "effort", value: "high" }] }, tools: ["mcp"] }),
    );
    expect(answerText(output)).toBe("hi");
  });

  it("opens no spans itself: traced tools get one execute_tool span per call, with Cursor's call id", async () => {
    collector.requests.length = 0;
    const run = await AgentRun.start({ agentName: "implement", model: "composer-2.5", provider: "cursor", vcs: { branch: "task/x" } });
    const untraced = readFile();
    const prompt = fakePrompt([[["read_file", { path: "a.ts" }, "call_a\nfc_a_1"], ["read_file", { path: "b.ts" }, "call_b"]]]);
    await run.modelTurn(() => new CursorEndpoint(COMPOSER, prompt).infer(inputWith({ tools: [untraced] })));
    await run.modelTurn(() => new CursorEndpoint(COMPOSER, prompt).infer(inputWith({ tools: [run.traceTool(readFile())] })));
    await run.end();

    expect(untraced.invoke).toHaveBeenCalledTimes(2);
    const spans = collector.sessionSpans();
    expect(toolSpanViolations(spans)).toEqual([]);
    expect(spanTree(spans)).toEqual([
      "chat composer-2.5",
      "chat composer-2.5",
      "  execute_tool read_file (call_a)",
      "  execute_tool read_file (call_b)",
    ]);
  });
});

describe("flattenContext", () => {
  it("returns a placeholder for an empty context", () => {
    expect(flattenContext({ model: "composer-2.5", context: ModelContext.create() })).toBe("(empty)");
  });
});
