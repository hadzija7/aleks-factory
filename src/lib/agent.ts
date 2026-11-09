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
import { agentModels, type ResolvedModel } from "./agent-models";
import { createCodingTools } from "./coding-tools";
import { DockerSandbox } from "./docker-sandbox";
import { closeEgress, openEgress } from "./egress";
import { getProject } from "./project-store";
import type { ModelAgentName } from "./factory-agents";
import { modelRegistry } from "./models";
import { DEFAULT_ALLOWED_DOMAINS } from "./projects";
import { setTaskCheck } from "./task-checks";
import { listTasks, updateTask } from "./task-store";
import type { Task } from "./tasks";
import { AgentRun } from "./tracing";
import { changedSince, ensureWorktree, hasWorktree, headRevision, syncWithMain, taskKey, taskVcs, worktreeDir } from "./workspace";

const MAX_REVIEW_ROUNDS = Number(process.env.MAX_REVIEW_ROUNDS ?? 3);
const REVIEW_TOOLS = new Set(["list_files", "read_file", "run_command"]);

const EXECUTOR_INSTRUCTION = `You are an autonomous coding agent.
You receive a task from a kanban board and must complete it inside a single project folder (a git checkout of the task's branch).
Use list_files and read_file to understand the project, edit_file for targeted changes, write_file for new files,
and run_command to run tests or the build so you can verify your own work. All paths are relative to the project root.
run_command runs in a Linux container where the project root is /work. Its internet access is limited to the domains listed in the task
(HTTP/HTTPS through a proxy that curl, npm and Node's fetch pick up automatically); everything else is blocked.
Dependencies are already installed (\`npm install <pkg>\` works while the npm registry is allowed); node_modules lives inside the container,
so inspect it with run_command rather than read_file. \`next build\` can fail fetching Google Fonts unless fonts.googleapis.com is allowed;
lint and \`npx tsc --noEmit\` always work.
Do not run git commands: the board commits and merges your work after a human reviews it.
If the task lists merge conflicts with main, edit each listed file to combine both sides and remove every conflict marker; the board concludes the merge.
Secrets: when the task gives you API keys, tokens or other credentials, write them to \`.env.local\` at the project root
(create or update it with write_file/edit_file, one NAME=value per line) and read them via \`process.env.NAME\` in server-side code only.
Never hardcode secrets in source files, expose them to the browser (no NEXT_PUBLIC_ prefix, no client components), or print them in commands.
\`.env.local\` is gitignored on purpose; the board keeps it with the project. If you add a new variable, also list its name (no value) in \`.env.example\`.
External APIs: before integrating one, read its documentation with curl (strip HTML to keep output small, e.g.
\`curl -sL URL | sed -e 's/<[^>]*>//g' | grep -v '^[[:space:]]*$' | head -200\`) and test the real endpoint with keys loaded from .env.local
(\`set -a; . ./.env.local; set +a; curl -s -H "Authorization: Bearer $NAME" URL | head -c 2000\`). Never guess endpoints or response formats,
and never send a secret to any host other than the API it belongs to. If a domain is blocked or something couldn't be verified, say so in your final summary.
If a tool returns an error, read it, fix the cause and try again.
If the task includes code review findings, address every one of them.
When finished, respond with the final result in concise markdown: what you changed and how you verified it.`;

const REVIEWER_INSTRUCTION = `You are a senior code reviewer.
You review the changes another agent made in a project folder to complete a kanban task.
Use list_files and read_file to inspect the code, and run_command to run tests, lint or the build (Linux container, project root is /work,
internet limited to the allowed domains listed in the task).
Do not modify any files. Check that the task is fully implemented, correct, tested where reasonable, and free of obvious bugs or security issues.
Secrets must come from \`.env.local\` via process.env on the server: request changes if a secret is hardcoded, exposed to the client, or the code needs a variable missing from \`.env.local\`.
For external API integrations, check the endpoint, auth and response format against the API's docs or a real curl call (when its domain is allowed);
request changes if they were guessed or don't match, and state anything you couldn't verify in your summary.
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
type Session = { taskId: string; role: Role; contextId: string; run: AgentRun; model: ResolvedModel };
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
    const session = resolveRuntime().state.sessionByContext.get(input.context.id);
    try {
      const model = session ? session.model.generative : modelRegistry.findByName(input.model)?.model;
      if (!model) {
        const name = session?.model.provider ? `${session.model.provider}/${input.model}` : input.model;
        throw new Error(`Unsupported model: ${name}. Pick a supported one in Factory settings or MOZAIK_MODEL.`);
      }
      return await (session ? session.run.modelTurn(() => model.endpoint.infer(input)) : model.endpoint.infer(input));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (session) resolveRuntime().state.failures.set(session.taskId, message);
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
const networkNote = (domains?: string[]) =>
  domains
    ? `\n\n## Network\nrun_command can reach only these domains over HTTP(S): ${domains.join(", ")}. Other hosts get a 403 from the egress proxy; if you need one, name it in your summary so the user can allow it.`
    : "\n\n## Network\nrun_command has no network access in this session.";

async function sessionFor(task: Task) {
  const { state } = resolveRuntime();
  const setup = hasWorktree(task) ? undefined : addActivity(task.id, { kind: "setup", title: "Creating branch and installing dependencies", status: "running" });
  try {
    const { dir, branch } = await ensureWorktree(task);
    if (setup) updateActivity(task.id, setup, { status: "done", title: `Workspace ready on ${branch}` });
    if (task.branch !== branch) await updateTask(task.id, { branch });
    // Refreshes the allowlist on every phase, so domains added mid-task apply to the running sandbox. Falls back to offline.
    const allowed = (await getProject(task.projectId))?.allowedDomains ?? [];
    const networkArgs = await openEgress(task.id, allowed).catch((e) => console.error(`[agent] egress proxy unavailable for task ${task.id}`, e));
    let sandbox = state.sandboxByTask.get(task.id);
    if (!sandbox) {
      sandbox = new DockerSandbox(task.id, dir, { nodeModulesKey: taskKey(task), networkArgs: networkArgs ?? undefined });
      state.sandboxByTask.set(task.id, sandbox);
    }
    // run_command retries the start if it fails here.
    await sandbox.start().catch((e) => console.error(`[agent] failed to start sandbox for task ${task.id}`, e));
    return { dir, sandbox, domains: networkArgs ? [...new Set([...DEFAULT_ALLOWED_DOMAINS, ...allowed])] : undefined };
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
  void closeEgress(taskId);
}

const AGENT_NAMES: Record<Role, ModelAgentName> = { execute: "implement", review: "review" };

/**
 * One traced session per agent run, on the agent's configured model (or MOZAIK_MODEL); run_command's sandbox calls become
 * `docker_exec` tool spans.
 */
async function startRun(task: Task, role: Role, sandbox: DockerSandbox) {
  const model = await agentModels.resolve(AGENT_NAMES[role]);
  const run = await AgentRun.start({ agentName: AGENT_NAMES[role], model: model.model, provider: model.provider, vcs: await taskVcs(task) });
  const traced: Pick<DockerSandbox, "exec"> = {
    exec: (command) =>
      run.executeTool("docker_exec", () => sandbox.exec(command), (r) =>
        r.ok ? undefined : r.timedOut ? "Command timed out" : `Command failed with exit code ${r.exitCode ?? "unknown"}`),
  };
  return { run, model, sandbox: traced };
}

type Started = Awaited<ReturnType<typeof startRun>>;

function startLoop(agent: Agent, taskId: string, role: Role, { run, model }: Started, message: string, input: Omit<InferenceInput, "model" | "context">) {
  const context = ModelContext.create().addContextItem(DeveloperMessageItem.create(agent.getDeveloperMessage()));
  resolveRuntime().state.sessionByContext.set(context.id, { taskId, role, contextId: context.id, run, model });
  runLoop(agent.getId(), message, { model: model.model, context, ...input });
}

type Rework = NonNullable<Task["rework"]>;

const REWORK: Record<Rework, { phase: string; heading: string }> = {
  review: { phase: "Executor fixing review findings", heading: "Code review findings to fix" },
  conflicts: { phase: "Executor resolving merge conflicts with main", heading: "Merge conflicts to resolve" },
  checks: { phase: "Executor fixing checks broken by the latest main", heading: "Checks failing after merging the latest main" },
};

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
      const round = task.reviewRounds ?? 1;
      const reason = REWORK[task.conflicts?.length ? "conflicts" : (task.rework ?? "review")];
      addActivity(task.id, { kind: "phase", role: "execute", title: task.review ? `${reason.phase} (round ${round})` : "Executor started" });
      const session = await sessionFor(task);
      if (!session) return;
      const rework = task.review ? `\n\n## ${reason.heading} (round ${round})\n\n${task.review}\n\n## Your previous summary\n\n${task.result ?? ""}` : "";
      const started = await startRun(task, "execute", session.sandbox);
      startLoop(agent, task.id, "execute", started, taskBrief(task) + networkNote(session.domains) + rework, {
        tools: [...agent.getTools(), ...createCodingTools(session.dir, started.sandbox)],
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
      const started = await startRun(task, "review", session.sandbox);
      startLoop(agent, task.id, "review", started, `Review the implementation of this task.\n\n${taskBrief(task)}${networkNote(session.domains)}${summary}`, {
        tools: [...agent.getTools(), ...createCodingTools(session.dir, started.sandbox).filter((tool) => REVIEW_TOOLS.has(tool.name))],
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
async function advanceTask({ taskId, role, run }: Session, text: string) {
  const { state } = resolveRuntime();
  const error = state.failures.get(taskId);
  state.failures.delete(taskId);
  const review = role === "review" && !error ? parseReview(text) : undefined;
  void run.end(error ?? (role === "review" && !review ? "Reviewer returned an invalid review" : undefined));
  if (error) {
    addActivity(taskId, { kind: "error", role, title: "Agent failed", detail: error });
    endSession(taskId);
    return updateTask(taskId, { status: "failed", error });
  }

  if (role === "execute") {
    addActivity(taskId, { kind: "message", role, title: text });
    const task = await updateTask(taskId, { status: "in_review", result: text, error: undefined });
    if (!task) return endSession(taskId);
    if (await mergeMain(task)) emit<ReviewRequestedPayload>("task.review_requested", { task });
    return;
  }

  if (!review) {
    addActivity(taskId, { kind: "error", role, title: "Reviewer returned an invalid review", detail: text });
    endSession(taskId);
    return updateTask(taskId, { status: "failed", error: `Reviewer returned an invalid review: ${text.slice(0, 500)}` });
  }
  addActivity(taskId, { kind: "message", role, title: formatReview(review) });
  if (review.verdict === "request_changes") return requestRework(taskId, formatReview(review), "review");
  // main may have moved on during the review, so only call it done once it still merges cleanly.
  const task = await updateTask(taskId, { review: formatReview(review) });
  if (!task || !(await mergeMain(task))) return;
  addActivity(taskId, { kind: "phase", role, title: "Approved, ready for your review" });
  endSession(taskId);
  return updateTask(taskId, { status: "done" });
}

/** Sends the task back to the executor with review findings or merge conflicts; fails after MAX_REVIEW_ROUNDS. */
async function requestRework(taskId: string, findings: string, rework: Rework, patch: Partial<Task> = {}) {
  const current = await updateTask(taskId, { review: findings, rework, ...patch });
  const rounds = (current?.reviewRounds ?? 0) + 1;
  if (!current || rounds > MAX_REVIEW_ROUNDS) {
    const error = current?.conflicts?.length
      ? `Merge conflicts with main still unresolved after ${MAX_REVIEW_ROUNDS} fix rounds`
      : `Review still requests changes after ${MAX_REVIEW_ROUNDS} fix rounds`;
    addActivity(taskId, { kind: "error", role: "review", title: error });
    endSession(taskId);
    return current && updateTask(taskId, { status: "failed", error });
  }
  const task = await updateTask(taskId, { status: "in_progress", reviewRounds: rounds });
  if (task) emit<TaskAssignedPayload>("task.assigned", { task });
}

const conflictFindings = (files: string[]) =>
  [
    "`main` changed since this task started, and merging it into the task branch conflicts in:",
    ...files.map((f) => `- ${f}`),
    "",
    "Each file has git conflict markers: `<<<<<<< HEAD` (this task's version), `=======`, `>>>>>>> main` (main's version).",
    "Edit them so the result keeps main's changes and this task's intent, remove every marker, and re-run lint/typecheck.",
    "If package.json or package-lock.json changed, run `npm install` first.",
  ].join("\n");

/**
 * Merges main into the task branch. Clean: returns true. Conflicts go back to the executor like review findings;
 * other git errors fail the task.
 */
async function mergeMain(task: Task) {
  const step = addActivity(task.id, { kind: "setup", title: "Merging main into the task branch", status: "running" });
  try {
    const conflicts = await syncWithMain(task, task.conflicts);
    if (!conflicts.length) {
      updateActivity(task.id, step, { status: "done", title: task.conflicts?.length ? "Merge conflicts resolved, up to date with main" : "Up to date with main" });
      if (task.conflicts) await updateTask(task.id, { conflicts: undefined });
      return true;
    }
    updateActivity(task.id, step, { status: "error", title: `Merge conflicts with main in ${conflicts.length} file(s)`, detail: conflicts.join("\n") });
    await requestRework(task.id, conflictFindings(conflicts), "conflicts", { conflicts });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateActivity(task.id, step, { status: "error", detail: message });
    endSession(task.id);
    await updateTask(task.id, { status: "failed", error: message });
  }
  return false;
}

/** A done task whose merge into main conflicts goes back to the executor with a fresh round budget. */
export async function resolveMergeConflicts(task: Task, conflicts: string[]) {
  addActivity(task.id, { kind: "error", role: "review", title: `Main changed: merge conflicts in ${conflicts.length} file(s)`, detail: conflicts.join("\n") });
  await updateTask(task.id, { reviewRounds: 0 });
  await requestRework(task.id, conflictFindings(conflicts), "conflicts", { conflicts });
}

// Lint and typecheck always work offline; `next build` may need fonts.googleapis.com.
const MAIN_CHECKS = [
  { step: "running lint", command: "npm run lint --if-present" },
  { step: "running typecheck", command: "[ ! -f tsconfig.json ] || npx tsc --noEmit" },
];
const DEPENDENCY_FILES = new Set(["package.json", "package-lock.json"]);

/**
 * Like CI on a PR whose base moved: merges main into a done task and re-runs lint and typecheck on the result. Conflicts
 * or failing checks send it back through execution and review; if the checks can't run at all it stays done.
 */
async function recheckDoneTask(task: Task) {
  const label = (step: string) => setTaskCheck(task.id, `Checking against main: ${step}`);
  label("merging main");
  const phase = addActivity(task.id, { kind: "setup", title: "Main changed: merging it into this task", status: "running" });
  const before = await headRevision(task);
  const conflicts = await syncWithMain(task, task.conflicts);
  if (conflicts.length) {
    updateActivity(task.id, phase, { status: "error" });
    return resolveMergeConflicts(task, conflicts);
  }
  const changed = await changedSince(task, before);
  updateActivity(task.id, phase, { status: "done", title: changed.length ? `Merged main (${changed.length} file(s) changed)` : "Already up to date with main", detail: changed.join("\n") || undefined });
  if (!changed.length) return;

  const deps = changed.some((file) => DEPENDENCY_FILES.has(file));
  const session = `check-${task.id}`;
  const networkArgs = deps
    ? await openEgress(session, (await getProject(task.projectId))?.allowedDomains ?? []).catch((e) => console.error(`[agent] egress proxy unavailable for ${session}`, e))
    : undefined;
  const sandbox = new DockerSandbox(session, worktreeDir(task), { nodeModulesKey: taskKey(task), networkArgs: networkArgs ?? undefined });
  try {
    const steps = [...(deps ? [{ step: "installing dependencies", command: "npm install --no-audit --no-fund" }] : []), ...MAIN_CHECKS];
    const failures: string[] = [];
    for (const { step, command } of steps) {
      label(step);
      const id = addActivity(task.id, { kind: "tool", tool: "run_command", title: `$ ${command}`, status: "running" });
      const result = await sandbox.exec(command);
      const { detail } = describeToolResult("run_command", JSON.stringify(result));
      updateActivity(task.id, id, { status: result.ok ? "done" : "error", detail });
      if (result.ok) continue;
      // No exit code or a timeout means the check itself couldn't run, which says nothing about the code.
      if (result.exitCode === null || result.timedOut) {
        addActivity(task.id, { kind: "error", title: `Couldn't run checks against main (${step}); left in Done`, detail });
        return;
      }
      failures.push(`### \`${command}\` failed\n\n\`\`\`\n${(detail ?? "").slice(-3000)}\n\`\`\``);
      if (step === "installing dependencies") break;
    }
    if (!failures.length) {
      addActivity(task.id, { kind: "phase", title: "Checks pass on the latest main" });
      return;
    }
    addActivity(task.id, { kind: "error", role: "review", title: "Checks fail after merging the latest main" });
    await updateTask(task.id, { reviewRounds: 0 });
    const findings = `The latest main was merged into this task branch without conflicts, but these checks now fail:\n\n${failures.join("\n\n")}\n\nFix them while keeping both main's changes and this task's intent.`;
    await requestRework(task.id, findings, "checks");
  } finally {
    await sandbox.dispose();
    if (networkArgs) await closeEgress(session);
  }
}

/**
 * Main moved (a task was merged): keeps every other done task mergeable and green, one at a time because the worktrees
 * share one repository and node_modules volumes.
 */
export async function syncDoneTasks(projectId: string) {
  for (const task of await listTasks(projectId)) {
    if (task.status !== "done" || task.checking || !task.branch || task.mergedCommit || !hasWorktree(task)) continue;
    try {
      await recheckDoneTask(task);
    } catch (error) {
      console.error(`[agent] failed to re-check task ${task.id} against main`, error);
      addActivity(task.id, { kind: "error", title: "Re-checking against main failed", detail: error instanceof Error ? error.message : String(error) });
    } finally {
      setTaskCheck(task.id);
    }
  }
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
        // Published synchronously right before the tool runs, so its docker_exec span gets this call id.
        session.run.setToolCallId(call.callId);
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
