export type ActivityRole = "execute" | "review";

export type ActivityKind = "phase" | "setup" | "thinking" | "reasoning" | "tool" | "message" | "error";

export type ActivityStatus = "running" | "done" | "error";

/** One line in a task's live agent feed. Running entries are re-sent with the same id when they finish. */
export type ActivityEntry = {
  id: number;
  at: string;
  kind: ActivityKind;
  role?: ActivityRole;
  title: string;
  detail?: string;
  tool?: string;
  status?: ActivityStatus;
  durationMs?: number;
};

/** A one-line summary of what an agent is doing right now, for task cards. */
export function currentStep(entries: ActivityEntry[]) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.kind === "thinking" && entry.status === "running") return "Thinking…";
    if (entry.kind === "tool" || entry.kind === "setup") return entry.title;
    if (entry.kind === "phase") return undefined;
  }
}
