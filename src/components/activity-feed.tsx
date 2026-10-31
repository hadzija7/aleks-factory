"use client";

import { useEffect, useRef, useState } from "react";
import type { ActivityEntry, ActivityRole } from "@/lib/activity";

const ROLE_STYLE: Record<ActivityRole, { label: string; className: string }> = {
  execute: { label: "Executor", className: "text-blue-600 dark:text-blue-400" },
  review: { label: "Reviewer", className: "text-violet-600 dark:text-violet-400" },
};

const TOOL_BADGE: Record<string, string> = { run_command: "run", read_file: "read", edit_file: "edit", write_file: "write", list_files: "list" };

const formatDuration = (ms: number) => {
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};

/** Live feed of what the agents are doing on a task: thinking, tool calls with their output, and messages. */
export function ActivityFeed({ taskId }: { taskId: string }) {
  const [entries, setEntries] = useState<ActivityEntry[] | null>(null);
  const [connected, setConnected] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    const source = new EventSource(`/api/tasks/${taskId}/activity`);
    source.addEventListener("snapshot", (e) => setEntries(JSON.parse((e as MessageEvent).data)));
    source.addEventListener("entry", (e) => {
      const entry: ActivityEntry = JSON.parse((e as MessageEvent).data);
      setEntries((prev) => {
        const list = prev ?? [];
        const index = list.findIndex((x) => x.id === entry.id);
        return index === -1 ? [...list, entry] : list.map((x, i) => (i === index ? entry : x));
      });
    });
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    return () => source.close();
  }, [taskId]);

  useEffect(() => {
    const el = scroller.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [entries]);

  const running = entries?.some((e) => e.status === "running");

  return (
    <div className="flex flex-col gap-2">
      <h3 className="flex items-center gap-2 text-sm font-semibold uppercase opacity-70">
        Agent activity
        <span className={`h-1.5 w-1.5 rounded-full ${connected ? (running ? "animate-pulse bg-green-500" : "bg-green-500") : "bg-black/20 dark:bg-white/20"}`} title={connected ? "Live" : "Disconnected"} />
      </h3>
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="max-h-[55vh] min-h-24 overflow-y-auto rounded-lg border border-black/10 bg-black/[.02] p-2 dark:border-white/15 dark:bg-white/[.03]"
      >
        {entries === null && <p className="p-2 text-sm opacity-50">Connecting…</p>}
        {entries?.length === 0 && <p className="p-2 text-sm opacity-50">No agent activity yet. Move the task to “In Execution” to start.</p>}
        <ol className="flex flex-col gap-0.5">
          {entries?.map((entry) => (
            <li key={entry.id}>
              <Entry entry={entry} />
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function Entry({ entry }: { entry: ActivityEntry }) {
  switch (entry.kind) {
    case "phase":
      return (
        <div className={`mt-2 flex items-center gap-2 px-1 text-xs font-semibold first:mt-0 ${entry.role ? ROLE_STYLE[entry.role].className : ""}`}>
          <span className="h-px flex-1 bg-current opacity-20" />
          {entry.title}
          <span className="text-[10px] font-normal opacity-50">{new Date(entry.at).toLocaleTimeString()}</span>
          <span className="h-px flex-1 bg-current opacity-20" />
        </div>
      );
    case "message":
      return (
        <div className="my-1 rounded-md bg-background px-3 py-2 text-sm whitespace-pre-wrap shadow-sm">
          {entry.role && <div className={`mb-1 text-[10px] font-semibold uppercase ${ROLE_STYLE[entry.role].className}`}>{ROLE_STYLE[entry.role].label}</div>}
          {entry.title}
        </div>
      );
    case "error":
      return (
        <div className="my-1 rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600">
          <div className="font-medium">{entry.title}</div>
          {entry.detail && <pre className="mt-1 max-h-60 overflow-auto text-xs whitespace-pre-wrap">{entry.detail}</pre>}
        </div>
      );
    default:
      return <StepRow entry={entry} />;
  }
}

/** A collapsible step: thinking, workspace setup or a tool call. */
function StepRow({ entry }: { entry: ActivityEntry }) {
  const [open, setOpen] = useState(entry.status === "error");
  const isThinking = entry.kind === "thinking";
  const expandable = !!entry.detail;
  const label = isThinking ? (entry.status === "running" ? "Thinking…" : `Thought for ${formatDuration(entry.durationMs ?? 0)}`) : entry.title;

  return (
    <div>
      <button
        onClick={() => expandable && setOpen(!open)}
        className={`flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-xs ${expandable ? "hover:bg-black/5 dark:hover:bg-white/10" : "cursor-default"}`}
      >
        <StatusIcon status={entry.status} />
        {entry.tool && <span className="w-9 shrink-0 rounded bg-black/5 px-1 text-center font-mono text-[10px] uppercase opacity-70 dark:bg-white/10">{TOOL_BADGE[entry.tool] ?? "tool"}</span>}
        <span className={`min-w-0 flex-1 truncate ${isThinking ? "italic opacity-60" : entry.tool ? "font-mono" : ""} ${isThinking && entry.status === "running" ? "animate-pulse" : ""}`} title={label}>
          {label}
        </span>
        {entry.status === "running" && !isThinking && <Elapsed since={entry.at} />}
        {entry.status !== "running" && entry.durationMs !== undefined && !isThinking && <span className="shrink-0 font-mono text-[10px] opacity-40">{formatDuration(entry.durationMs)}</span>}
        {expandable && <span className="shrink-0 opacity-40">{open ? "▾" : "▸"}</span>}
      </button>
      {open && entry.detail && <Detail entry={entry} />}
    </div>
  );
}

function Detail({ entry }: { entry: ActivityEntry }) {
  const lines = entry.detail!.split("\n");
  const colored = entry.tool === "edit_file";
  return (
    <pre className={`mb-1 ml-6 max-h-72 overflow-auto rounded-md border border-black/10 bg-background p-2 font-mono text-[11px] leading-4 whitespace-pre-wrap dark:border-white/15 ${entry.kind === "thinking" ? "font-sans italic opacity-70" : ""}`}>
      {colored
        ? lines.map((line, i) => (
            <div key={i} className={line.startsWith("+ ") ? "bg-green-500/10 text-green-700 dark:text-green-400" : line.startsWith("- ") ? "bg-red-500/10 text-red-700 dark:text-red-400" : ""}>
              {line}
            </div>
          ))
        : entry.detail}
    </pre>
  );
}

function StatusIcon({ status }: { status?: ActivityEntry["status"] }) {
  if (status === "running") return <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />;
  if (status === "error") return <span className="w-3 shrink-0 text-center text-red-600">✕</span>;
  return <span className="w-3 shrink-0 text-center text-green-600">✓</span>;
}

function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <span className="shrink-0 font-mono text-[10px] opacity-40">{formatDuration(Math.max(0, now - Date.parse(since)))}</span>;
}
