import type { Task } from "./tasks";

// In memory (on globalThis so dev reloads keep it), so a crash mid-check never leaves a task locked.
const checks = ((globalThis as { __taskChecks?: Map<string, string> }).__taskChecks ??= new Map());

/** Labels what the board is checking on a done task right now; no step clears it. */
export const setTaskCheck = (taskId: string, step?: string) => void (step ? checks.set(taskId, step) : checks.delete(taskId));

export const withCheck = (task: Task): Task => {
  const checking = checks.get(task.id);
  return checking ? { ...task, checking } : task;
};
