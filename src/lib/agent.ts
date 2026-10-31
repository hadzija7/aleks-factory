import {
  createAgent,
  createHuman,
  defineRuntime,
  DeveloperMessageItem,
  ModelContext,
  ModelMessageItem,
  RuntimeState,
  SemanticEvent,
  SituationSpecification,
  supportedModels,
  type Agent,
  type InferenceInput,
  type InferenceRunner,
  type SituationContext,
  type SituationHandler,
  type StructuredOutputFormat,
} from "@mozaik-ai/core";
import { createCloudExporter } from "@mozaik-ai/cloud-sdk/exporter";
import type { ActivityRole } from "./activity";
import { addActivity, updateActivity } from "./activity-log";
import { createCodingTools } from "./coding-tools";
import { DockerSandbox } from "./docker-sandbox";
import { updateTask } from "./task-store";
import type { Task } from "./tasks";
import { ensureWorktree, hasWorktree, taskKey } from "./workspace";

const MODEL = process.env.MOZAIK_MODEL ?? "gpt-5.5";
const MAX_REVIEW_ROUNDS = Number(process.env.MAX_REVIEW_ROUNDS ?? 3);
const REVIEW_TOOLS = new Set(["list_files", "read_file", "run_command"]);

const EXECUTOR_INSTRUCTION = `You are an autonomous coding agent.
You receive a task from a kanban board and must complete it inside a single project folder (a git checkout of the task's branch).
Use list_files and read_file to understand the project, edit_file for targeted changes, write_file for new files,
and run_command to run tests or the build so you can verify your own work. All paths are relative to the project root.
run_command runs in an offline Linux container where the project root is /work, so dependencies cannot be downloaded.
Dependencies are already installed; node_modules lives inside the container, so inspect it with run_command rather than read_file. Without network, \`next build\` can fail fetching Google Fonts; prefer lint and \`npx tsc --noEmit\` to verify.
Do not run git commands: the board commits and merges your work after a human reviews it.
Secrets: when the task gives you API keys, tokens or other credentials, write them to \`.env.local\` at the project root
(create or update it with write_file/edit_file, one NAME=value per line) and read them via \`process.env.NAME\` in server-side code only.
Never hardcode secrets in source files, expose them to the browser (no NEXT_PUBLIC_ prefix, no client components), or print them in commands.
\`.env.local\` is gitignored on purpose; the board keeps it with the project. If you add a new variable, also list its name (no value) in \`.env.example\`.
External APIs: the sandbox has no network, so never guess endpoints or response formats. Use only what the task or existing code states,
and clearly list any unverified assumptions in your final summary.
If a tool returns an error, read it, fix the cause and try again.
If the task includes code review findings, address every one of them.
When finished, respond with the final result in concise markdown: what you changed and how you verified it.`;

const REVIEWER_INSTRUCTION = `You are a senior code reviewer.
You review the changes another agent made in a project folder to complete a kanban task.
Use list_files and read_file to inspect the code, and run_command to run tests, lint or the build (offline Linux container, project root is /work).
Do not modify any files. Check that the task is fully implemented, correct, tested where reasonable, and free of obvious bugs or security issues.
Secrets must come from \`.env.local\` via process.env on the server: request changes if a secret is hardcoded, exposed to the client, or the code needs a variable missing from \`.env.local\`.
Integrations with external APIs can't be tested offline: verify the endpoint and response format are taken from the task or existing code rather than guessed, and state any unverified assumptions in your summary.
Approve when the work is ready to ship; only request changes for real problems, not style nitpicks.
Each finding must be specific and actionable (file, problem, expected fix).`;

const REVIEW_FORMAT: StructuredOutputFormat = {
  name: "code_review",
  strict: true,
  schema: {
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["approve", "request_changes"] },
      summary: { type: "string", description: "One or two sentences on the overall state of the work" },
      findings: { type: "array", items: { type: "string" }, description: "Actionable problems to fix; empty when approving" },
    },
    required: ["verdict", "summary", "findings"],
    additionalProperties: false,
  },
};

type Role = ActivityRole;
type Session = { taskId: string; role: Role; contextId: string };
type Review = { verdict: "approve" | "request_changes"; summary: string; findings: string[] };

type TaskAssignedPayload = { task: Task };
type ReviewRequestedPayload = { task: Task };
type MessageReceivedPayload = { loopId: string; input: InferenceInput };
type ModelAnswerPayload = { loopId: string; answer: ModelMessageItem };

class FactoryState extends RuntimeState {
  sessionByContext = new Map<string, Session>();
  sessionByLoop = new Map<string, Session>();
  failures = new Map<string, string>();
  sandboxByTask = new Map<string, DockerSandbox>();
  /** Activity entry ids of in-flight inferences (by loop) and tool calls (by call id). */
  thinkingByLoop = new Map<string, number>();
  toolByCall = new Map<string, { id: number; name: string }>();
}

const { initializeRuntime, resolveRuntime, join, runLoop, sendEvent } = defineRuntime<FactoryState>();

class WhenEvent extends SituationSpecification {
  private readonly types: Set<string>;
  constructor(...types: string[]) {
    super();
    this.types = new Set(types);
  }
  isSatisfiedBy({ event }: SituationContext) {
    return this.types.has(event.type);
  }
}

// Inference errors are not surfaced as events by runLoop, so we turn them into a final answer and record the failure.
const inferenceRunner: InferenceRunner = {
  async run(input) {
    try {
      const model = supportedModels.find((m) => m.specification.name === input.model);
      if (!model) throw new Error(`Unsupported model: ${input.model}`);
      return await model.endpoint.infer(input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const taskId = resolveRuntime().state.sessionByContext.get(input.context.id)?.taskId;
      if (taskId) resolveRuntime().state.failures.set(taskId, message);
      return { items: [ModelMessageItem.rehydrate({ text: message })], tokenUsage: undefined, rowResponse: null };
    }
  },
  stream() {
    throw new Error("Streaming is not supported by the task executor");
  },
};

/**
 * Prepares the task's git worktree (its workspace) and one sandbox container per task session, shared by the executor
 * and the reviewer until the task is done or failed. Marks the task failed and returns undefined if setup fails.
 */
async function sessionFor(task: Task) {
  const { state } = resolveRuntime();
  const setup = hasWorktree(task) ? undefined : addActivity(task.id, { kind: "setup", title: "Creating branch and installing dependencies", status: "running" });
  try {
    const { dir, branch } = await ensureWorktree(task);
    if (setup) updateActivity(task.id, setup, { status: "done", title: `Workspace ready on ${branch}` });
    if (task.branch !== branch) await updateTask(task.id, { branch });
    let sandbox = state.sandboxByTask.get(task.id);
    if (!sandbox) {
      sandbox = new DockerSandbox(task.id, dir, taskKey(task));
      state.sandboxByTask.set(task.id, sandbox);
    }
    // run_command retries the start if it fails here.
    await sandbox.start().catch((e) => console.error(`[agent] failed to start sandbox for task ${task.id}`, e));
    return { dir, sandbox };
  } catch (error) {
    const message = `Workspace setup failed: ${error instanceof Error ? error.message : String(error)}`;
    if (setup) updateActivity(task.id, setup, { status: "error", detail: message });
    endSession(task.id);
    await updateTask(task.id, { status: "failed", error: message });
  }
}

function endSession(taskId: string) {
  const { state } = resolveRuntime();
  void state.sandboxByTask.get(taskId)?.dispose();
  state.sandboxByTask.delete(taskId);
}

function startLoop(agent: Agent, taskId: string, role: Role, message: string, input: Omit<InferenceInput, "model" | "context">) {
  const context = ModelContext.create().addContextItem(DeveloperMessageItem.create(agent.getDeveloperMessage()));
  resolveRuntime().state.sessionByContext.set(context.id, { taskId, role, contextId: context.id });
  runLoop(agent.getId(), message, { model: MODEL, context, ...input });
}

const taskBrief = (task: Task) => `# ${task.title}\n\n${task.description}`;

const formatReview = ({ verdict, summary, findings }: Review) =>
  [`**${verdict === "approve" ? "Approved" : "Changes requested"}:** ${summary}`, ...findings.map((f) => `- ${f}`)].join("\n");

function parseReview(text: string): Review | undefined {
  try {
    const review = JSON.parse(text) as Review;
    return review.verdict === "approve" || review.verdict === "request_changes" ? { ...review, findings: review.findings ?? [] } : undefined;
  } catch {
    return undefined;
  }
}

const executeAssignedTask: SituationHandler = {
  specification: new WhenEvent("task.assigned"),
  processor: {
    async apply({ event, participant }) {
      const agent = participant as Agent;
      const { task } = event.payload as TaskAssignedPayload;
      addActivity(task.id, { kind: "phase", role: "execute", title: task.review ? `Executor fixing review findings (round ${task.reviewRounds ?? 1})` : "Executor started" });
      const session = await sessionFor(task);
      if (!session) return;
      const rework = task.review
        ? `\n\n## Code review findings to fix (round ${task.reviewRounds ?? 1})\n\n${task.review}\n\n## Your previous summary\n\n${task.result ?? ""}`
        : "";
      startLoop(agent, task.id, "execute", taskBrief(task) + rework, {
        tools: [...agent.getTools(), ...createCodingTools(session.dir, session.sandbox)],
      });
    },
  },
};

const reviewImplementedTask: SituationHandler = {
  specification: new WhenEvent("task.review_requested"),
  processor: {
    async apply({ event, participant }) {
      const agent = participant as Agent;
      const { task } = event.payload as ReviewRequestedPayload;
      addActivity(task.id, { kind: "phase", role: "review", title: "Code review started" });
      const session = await sessionFor(task);
      if (!session) return;
      const summary = task.result ? `\n\n## Implementer's summary\n\n${task.result}` : "";
      startLoop(agent, task.id, "review", `Review the implementation of this task.\n\n${taskBrief(task)}${summary}`, {
        tools: [...agent.getTools(), ...createCodingTools(session.dir, session.sandbox).filter((tool) => REVIEW_TOOLS.has(tool.name))],
        structuredOutput: REVIEW_FORMAT,
      });
    },
  },
};

const trackLoop: SituationHandler = {
  specification: new WhenEvent("message_received.started"),
  processor: {
    apply({ event }) {
      const { loopId, input } = event.payload as MessageReceivedPayload;
      const { state } = resolveRuntime();
      const session = state.sessionByContext.get(input.context.id);
      if (session) state.sessionByLoop.set(loopId, session);
    },
  },
};

/** The board owns the task lifecycle: execution -> review -> (back to execution | done), driven by each agent's answer. */
async function advanceTask({ taskId, role }: Session, text: string) {
  const { state } = resolveRuntime();
  const error = state.failures.get(taskId);
  state.failures.delete(taskId);
  if (error) {
    addActivity(taskId, { kind: "error", role, title: "Agent failed", detail: error });
    endSession(taskId);
    return updateTask(taskId, { status: "failed", error });
  }

  if (role === "execute") {
    addActivity(taskId, { kind: "message", role, title: text });
    const task = await updateTask(taskId, { status: "in_review", result: text, error: undefined });
    if (!task) return endSession(taskId);
    return emit<ReviewRequestedPayload>("task.review_requested", { task });
  }

  const review = parseReview(text);
  if (!review) {
    addActivity(taskId, { kind: "error", role, title: "Reviewer returned an invalid review", detail: text });
    endSession(taskId);
    return updateTask(taskId, { status: "failed", error: `Reviewer returned an invalid review: ${text.slice(0, 500)}` });
  }
  addActivity(taskId, { kind: "message", role, title: formatReview(review) });
  if (review.verdict === "approve") {
    addActivity(taskId, { kind: "phase", role, title: "Approved, ready for your review" });
    endSession(taskId);
    return updateTask(taskId, { status: "done", review: formatReview(review) });
  }

  const current = await updateTask(taskId, { review: formatReview(review) });
  const rounds = (current?.reviewRounds ?? 0) + 1;
  if (!current || rounds > MAX_REVIEW_ROUNDS) {
    addActivity(taskId, { kind: "error", role, title: `Review still requests changes after ${MAX_REVIEW_ROUNDS} fix rounds` });
    endSession(taskId);
    return current && updateTask(taskId, { status: "failed", error: `Review still requests changes after ${MAX_REVIEW_ROUNDS} fix rounds` });
  }
  const task = await updateTask(taskId, { status: "in_progress", reviewRounds: rounds });
  if (task) emit<TaskAssignedPayload>("task.assigned", { task });
}

type ActivityItem = { type: string; name?: string; content?: { text?: string }; summary?: { text: string }[] };
type InferenceCompletedPayload = { loopId: string; items?: ActivityItem[] };
type FunctionCallStartedPayload = { loopId: string; call: { callId: string; name: string; args: string } };
type FunctionCallCompletedPayload = { loopId: string; callId: string; output?: { text?: string } };

function parseArgs(args: string): Record<string, string> {
  try {
    return JSON.parse(args);
  } catch {
    return {};
  }
}

const TOOL_TITLES: Record<string, (args: Record<string, string>) => string> = {
  run_command: (a) => `$ ${a.command}`,
  read_file: (a) => `Read ${a.path}`,
  edit_file: (a) => `Edit ${a.path}`,
  write_file: (a) => `Write ${a.path}`,
  list_files: (a) => `List ${a.path}`,
};

/** What we know about a tool call before it runs; edits and writes show their content, everything else shows its output later. */
function describeToolCall(name: string, rawArgs: string) {
  const args = parseArgs(rawArgs);
  const title = TOOL_TITLES[name]?.(args) ?? `${name} ${rawArgs}`;
  const prefix = (text: string, sign: string) => text.split("\n").map((line) => `${sign} ${line}`).join("\n");
  if (name === "edit_file") return { title, detail: `${prefix(args.old ?? "", "-")}\n${prefix(args.new ?? "", "+")}` };
  if (name === "write_file") return { title, detail: args.content };
  return { title, detail: undefined };
}

function describeToolResult(name: string, output: string) {
  if (name === "run_command") {
    try {
      const result = JSON.parse(output) as { ok: boolean; exitCode: number | null; timedOut: boolean; stdout: string; stderr: string };
      const status = result.timedOut ? "timed out" : `exit ${result.exitCode}`;
      return { failed: !result.ok, detail: [result.stdout.trimEnd(), result.stderr.trimEnd(), `[${status}]`].filter(Boolean).join("\n") };
    } catch {}
  }
  const failed = output.startsWith("Error");
  return { failed, detail: failed || name !== "edit_file" && name !== "write_file" ? output : undefined };
}

/** Mirrors the agents' Mozaik loop events (thinking, tool calls, results) into the task's live activity feed. */
const trackActivity: SituationHandler = {
  specification: new WhenEvent("inference.started", "inference.completed", "function_call.started", "function_call.completed"),
  processor: {
    apply({ event }) {
      const { state } = resolveRuntime();
      const { loopId } = event.payload as { loopId: string };
      const session = state.sessionByLoop.get(loopId);
      if (!session) return;
      const { taskId, role } = session;

      if (event.type === "inference.started") {
        state.thinkingByLoop.set(loopId, addActivity(taskId, { kind: "thinking", role, title: "Thinking", status: "running" }));
      } else if (event.type === "inference.completed") {
        const items = (event.payload as InferenceCompletedPayload).items ?? [];
        const reasoning = items.flatMap((item) => (item.type === "reasoning" ? (item.summary ?? []).map((s) => s.text) : [])).join("\n\n");
        const thinking = state.thinkingByLoop.get(loopId);
        state.thinkingByLoop.delete(loopId);
        if (thinking) updateActivity(taskId, thinking, { status: "done", title: "Thought", detail: reasoning || undefined });
        // Text next to tool calls is the agent narrating its plan; a final answer is recorded by recordAnswer.
        const narration = items.filter((item) => item.type === "message").map((item) => item.content?.text ?? "").join("\n").trim();
        if (narration && items.some((item) => item.type === "function_call")) addActivity(taskId, { kind: "message", role, title: narration });
      } else if (event.type === "function_call.started") {
        const { call } = event.payload as FunctionCallStartedPayload;
        const { title, detail } = describeToolCall(call.name, call.args);
        state.toolByCall.set(call.callId, { id: addActivity(taskId, { kind: "tool", role, tool: call.name, title, detail, status: "running" }), name: call.name });
      } else {
        const { callId, output } = event.payload as FunctionCallCompletedPayload;
        const tool = state.toolByCall.get(callId);
        state.toolByCall.delete(callId);
        if (!tool) return;
        const { failed, detail } = describeToolResult(tool.name, output?.text ?? "");
        updateActivity(taskId, tool.id, { status: failed ? "error" : "done", ...(detail !== undefined && { detail }) });
      }
    },
  },
};

const recordAnswer: SituationHandler = {
  specification: new WhenEvent("model.answer"),
  processor: {
    async apply({ event }) {
      const { loopId, answer } = event.payload as ModelAnswerPayload;
      const { state } = resolveRuntime();
      const session = state.sessionByLoop.get(loopId);
      if (!session) return;
      state.sessionByLoop.delete(loopId);
      state.sessionByContext.delete(session.contextId);
      try {
        await advanceTask(session, answer.content.text);
      } catch (e) {
        console.error(`[agent] failed to advance task ${session.taskId}`, e);
      }
    },
  },
};

let board: ReturnType<typeof createHuman> | undefined;

function emit<TPayload>(type: string, payload: TPayload) {
  const sender = ensureRuntime();
  sendEvent(SemanticEvent.create<string, TPayload>(type, sender.getId(), payload), sender.getId());
}

// Streams every runtime event to mozaik cloud (app.jigjoy.ai) when MOZAIK_API_KEY is set. It only listens, never publishes.
function joinCloudExporter() {
  const projectKey = process.env.MOZAIK_API_KEY;
  if (!projectKey) return;
  const exporter = createCloudExporter({
    endpoint: process.env.MOZAIK_CLOUD_ENDPOINT ?? "https://api.app.jigjoy.ai",
    projectKey,
    participants: () => resolveRuntime().state.getParticipants(),
    mozaikVersion: "4.1.0",
    onError: (error, dropped) => console.error(`[cloud] dropped ${dropped} event(s): ${error.message}`),
  });
  join(exporter.participant);
}

function ensureRuntime() {
  if (board) return board;
  initializeRuntime({ state: new FactoryState(), inferenceRunnerConfig: { runner: inferenceRunner } });
  // Join first so the exporter also records the other participants joining.
  joinCloudExporter();
  board = createHuman({ name: "Kanban Board", capabilities: ["task.assign", "task.review.request"], handlers: [trackLoop, trackActivity, recordAnswer] });
  join(board);
  join(
    createAgent({
      name: "Task Executor",
      capabilities: ["task.execute"],
      instruction: EXECUTOR_INSTRUCTION,
      tools: [],
      handlers: [executeAssignedTask],
    }),
  );
  join(
    createAgent({
      name: "Code Reviewer",
      capabilities: ["task.review"],
      instruction: REVIEWER_INSTRUCTION,
      tools: [],
      handlers: [reviewImplementedTask],
    }),
  );
  return board;
}

export function executeTask(task: Task) {
  emit<TaskAssignedPayload>("task.assigned", { task });
}

export function reviewTask(task: Task) {
  emit<ReviewRequestedPayload>("task.review_requested", { task });
}
