export const TASK_STATUSES = ["todo", "in_progress", "in_review", "done", "failed"] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export type Task = {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: TaskStatus;
  result?: string;
  review?: string;
  reviewRounds?: number;
  /** Files that conflicted when main was merged into the task branch; set while the executor resolves them. */
  conflicts?: string[];
  /** Why the task was last sent back to the executor. */
  rework?: "review" | "conflicts" | "checks";
  /** What the board is checking on a done task after main moved; only filled in by the API while it runs. */
  checking?: string;
  /** Git branch with the task's work; set once its worktree exists, cleared when merged. */
  branch?: string;
  /** Short SHA of the commit merged into main. */
  mergedCommit?: string;
  /** What the agent is doing right now; only filled in by the task list API while an agent is busy. */
  currentStep?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

export const COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: "todo", label: "To Do" },
  { status: "in_progress", label: "In Execution" },
  { status: "in_review", label: "In Review" },
  { status: "done", label: "Done" },
  { status: "failed", label: "Failed" },
];

export const isTaskStatus = (value: unknown): value is TaskStatus =>
  TASK_STATUSES.includes(value as TaskStatus);

/** Statuses during which an agent owns the task, so the board must not move or delete it. */
export const isAgentBusy = (status: TaskStatus) => status === "in_progress" || status === "in_review";

/** Busy with an agent or with the board re-checking it against main. */
export const isTaskBusy = (task: Task) => isAgentBusy(task.status) || !!task.checking;
