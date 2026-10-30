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
} from "@mozaik-ai/core";
import path from "node:path";
import { createCodingTools } from "./coding-tools";
import { DockerSandbox } from "./docker-sandbox";
import { updateTask } from "./task-store";
import type { Task } from "./tasks";

const MODEL = process.env.MOZAIK_MODEL ?? "gpt-5.5";
const WORKSPACE = path.resolve(/* turbopackIgnore: true */ process.env.AGENT_WORKSPACE ?? path.join(process.cwd(), "data", "workspace"));

const INSTRUCTION = `You are an autonomous coding agent.
You receive a task from a kanban board and must complete it inside a single project folder.
Use list_files and read_file to understand the project, edit_file for targeted changes, write_file for new files,
and run_command to run tests or the build so you can verify your own work. All paths are relative to the project root.
run_command runs in an offline Linux container where the project root is /work, so dependencies cannot be downloaded.
If a tool returns an error, read it, fix the cause and try again.
When finished, respond with the final result in concise markdown: what you changed and how you verified it.`;

type TaskAssignedPayload = { task: Task };
type MessageReceivedPayload = { loopId: string; input: InferenceInput };
type ModelAnswerPayload = { loopId: string; answer: ModelMessageItem };

class FactoryState extends RuntimeState {
  taskByContext = new Map<string, string>();
  taskByLoop = new Map<string, string>();
  failures = new Map<string, string>();
  sandboxByTask = new Map<string, DockerSandbox>();
}

const { initializeRuntime, resolveRuntime, join, runLoop, sendEvent } = defineRuntime<FactoryState>();

class WhenEvent extends SituationSpecification {
  constructor(private readonly type: string) {
    super();
  }
  isSatisfiedBy({ event }: SituationContext) {
    return event.type === this.type;
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
      const taskId = resolveRuntime().state.taskByContext.get(input.context.id);
      if (taskId) resolveRuntime().state.failures.set(taskId, message);
      return { items: [ModelMessageItem.rehydrate({ text: message })], tokenUsage: undefined, rowResponse: null };
    }
  },
  stream() {
    throw new Error("Streaming is not supported by the task executor");
  },
};

const executeAssignedTask: SituationHandler = {
  specification: new WhenEvent("task.assigned"),
  processor: {
    async apply({ event, participant }) {
      const agent = participant as Agent;
      const { task } = event.payload as TaskAssignedPayload;
      const { state } = resolveRuntime();
      // One sandbox container per task session; run_command retries the start if it fails here.
      const sandbox = new DockerSandbox(task.id, WORKSPACE);
      state.sandboxByTask.set(task.id, sandbox);
      await sandbox.start().catch((e) => console.error(`[agent] failed to start sandbox for task ${task.id}`, e));
      const context = ModelContext.create().addContextItem(DeveloperMessageItem.create(agent.getDeveloperMessage()));
      state.taskByContext.set(context.id, task.id);
      runLoop(agent.getId(), `# ${task.title}\n\n${task.description}`, {
        model: MODEL,
        tools: [...agent.getTools(), ...createCodingTools(WORKSPACE, sandbox)],
        context,
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
      const taskId = state.taskByContext.get(input.context.id);
      if (taskId) state.taskByLoop.set(loopId, taskId);
    },
  },
};

const recordAnswer: SituationHandler = {
  specification: new WhenEvent("model.answer"),
  processor: {
    async apply({ event }) {
      const { loopId, answer } = event.payload as ModelAnswerPayload;
      const { state } = resolveRuntime();
      const taskId = state.taskByLoop.get(loopId);
      if (!taskId) return;
      const error = state.failures.get(taskId);
      state.taskByLoop.delete(loopId);
      state.failures.delete(taskId);
      for (const [contextId, id] of state.taskByContext) if (id === taskId) state.taskByContext.delete(contextId);
      void state.sandboxByTask.get(taskId)?.dispose();
      state.sandboxByTask.delete(taskId);
      try {
        await updateTask(taskId, error ? { status: "failed", error } : { status: "done", result: answer.content.text, error: undefined });
      } catch (e) {
        console.error(`[agent] failed to save result for task ${taskId}`, e);
      }
    },
  },
};

let board: ReturnType<typeof createHuman> | undefined;

function ensureRuntime() {
  if (board) return board;
  initializeRuntime({ state: new FactoryState(), inferenceRunnerConfig: { runner: inferenceRunner } });
  board = createHuman({ name: "Kanban Board", capabilities: ["task.assign"], handlers: [trackLoop, recordAnswer] });
  join(board);
  join(
    createAgent({
      name: "Task Executor",
      capabilities: ["task.execute"],
      instruction: INSTRUCTION,
      tools: [],
      handlers: [executeAssignedTask],
    }),
  );
  return board;
}

export function executeTask(task: Task) {
  const sender = ensureRuntime();
  sendEvent(SemanticEvent.create<string, TaskAssignedPayload>("task.assigned", sender.getId(), { task }), sender.getId());
}
