export const TASK_STATUSES = ["todo", "in_progress", "done", "failed"] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export type Task = {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  result?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

export const COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: "todo", label: "To Do" },
  { status: "in_progress", label: "In Execution" },
  { status: "done", label: "Done" },
  { status: "failed", label: "Failed" },
];

export const isTaskStatus = (value: unknown): value is TaskStatus =>
  TASK_STATUSES.includes(value as TaskStatus);
