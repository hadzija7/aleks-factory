"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { COLUMNS, type Task, type TaskStatus } from "@/lib/tasks";

const POLL_MS = 2000;

const fetchTasks = async (): Promise<Task[] | undefined> => {
  const res = await fetch("/api/tasks", { cache: "no-store" });
  return res.ok ? res.json() : undefined;
};

export function KanbanBoard() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [dragOver, setDragOver] = useState<TaskStatus | null>(null);
  const [selected, setSelected] = useState<Task | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => fetchTasks().then((next) => next && setTasks(next)), []);

  useEffect(() => {
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const request = async (url: string, init: RequestInit) => {
    setError(null);
    const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json" } });
    if (!res.ok) setError((await res.json().catch(() => null))?.error ?? res.statusText);
    await load();
  };

  const moveTask = (id: string, status: TaskStatus) => {
    const task = tasks.find((t) => t.id === id);
    if (!task || task.status === status) return;
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, status } : t)));
    request(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify({ status }) });
  };

  const createTask = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    await request("/api/tasks", { method: "POST", body: JSON.stringify(data) });
    form.reset();
  };

  const deleteTask = (id: string) => request(`/api/tasks/${id}`, { method: "DELETE" });

  return (
    <div className="flex flex-col gap-6">
      <form onSubmit={createTask} className="flex flex-col gap-2 rounded-xl border border-black/10 p-4 dark:border-white/15 sm:flex-row">
        <input name="title" required placeholder="Task title" className="flex-1 rounded-md border border-black/10 bg-transparent px-3 py-2 dark:border-white/15" />
        <input name="description" placeholder="Description / instructions for the agent" className="flex-[2] rounded-md border border-black/10 bg-transparent px-3 py-2 dark:border-white/15" />
        <button type="submit" className="rounded-md bg-foreground px-4 py-2 font-medium text-background hover:opacity-90">
          Add task
        </button>
      </form>

      {error && <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600">{error}</p>}

      <div className="grid gap-4 md:grid-cols-4">
        {COLUMNS.map((column) => {
          const columnTasks = tasks.filter((t) => t.status === column.status);
          return (
            <section
              key={column.status}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(column.status);
              }}
              onDragLeave={() => setDragOver(null)}
              onDrop={(e) => {
                setDragOver(null);
                moveTask(e.dataTransfer.getData("text/plain"), column.status);
              }}
              className={`flex min-h-96 flex-col gap-3 rounded-xl border p-3 transition-colors ${
                dragOver === column.status ? "border-blue-500 bg-blue-500/5" : "border-black/10 bg-black/[.02] dark:border-white/15 dark:bg-white/[.03]"
              }`}
            >
              <h2 className="flex items-center justify-between text-sm font-semibold uppercase tracking-wide opacity-70">
                {column.label}
                <span className="rounded-full bg-black/5 px-2 text-xs dark:bg-white/10">{columnTasks.length}</span>
              </h2>
              {columnTasks.map((task) => (
                <TaskCard key={task.id} task={task} onOpen={() => setSelected(task)} onDelete={() => deleteTask(task.id)} />
              ))}
            </section>
          );
        })}
      </div>

      {selected && <TaskDetails task={tasks.find((t) => t.id === selected.id) ?? selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function TaskCard({ task, onOpen, onDelete }: { task: Task; onOpen: () => void; onDelete: () => void }) {
  const running = task.status === "in_progress";
  return (
    <article
      draggable={!running}
      onDragStart={(e) => e.dataTransfer.setData("text/plain", task.id)}
      onClick={onOpen}
      className={`group cursor-pointer rounded-lg border border-black/10 bg-background p-3 shadow-sm dark:border-white/15 ${running ? "cursor-progress" : "active:cursor-grabbing"}`}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-medium">{task.title}</h3>
        {!running && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="text-xs opacity-0 hover:text-red-600 group-hover:opacity-60"
            aria-label="Delete task"
          >
            ✕
          </button>
        )}
      </div>
      {task.description && <p className="mt-1 line-clamp-2 text-sm opacity-70">{task.description}</p>}
      {running && (
        <p className="mt-2 flex items-center gap-2 text-xs text-blue-600">
          <span className="h-2 w-2 animate-pulse rounded-full bg-blue-600" /> Agent working…
        </p>
      )}
      {task.status === "done" && task.result && <p className="mt-2 line-clamp-3 text-xs opacity-60">{task.result}</p>}
      {task.status === "failed" && task.error && <p className="mt-2 line-clamp-2 text-xs text-red-600">{task.error}</p>}
    </article>
  );
}

function TaskDetails({ task, onClose }: { task: Task; onClose: () => void }) {
  return (
    <div onClick={onClose} className="fixed inset-0 z-10 flex items-center justify-center bg-black/40 p-4">
      <div onClick={(e) => e.stopPropagation()} className="max-h-[80vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-background p-6 shadow-xl">
        <div className="flex items-start justify-between gap-4">
          <h2 className="text-xl font-semibold">{task.title}</h2>
          <button onClick={onClose} className="opacity-60 hover:opacity-100" aria-label="Close">
            ✕
          </button>
        </div>
        <p className="mt-1 text-xs uppercase opacity-50">{task.status.replace("_", " ")}</p>
        {task.description && <p className="mt-4 whitespace-pre-wrap">{task.description}</p>}
        {task.result && (
          <>
            <h3 className="mt-6 text-sm font-semibold uppercase opacity-70">Agent result</h3>
            <pre className="mt-2 whitespace-pre-wrap rounded-md bg-black/5 p-3 font-sans text-sm dark:bg-white/10">{task.result}</pre>
          </>
        )}
        {task.error && <p className="mt-6 rounded-md bg-red-500/10 p-3 text-sm text-red-600">{task.error}</p>}
      </div>
    </div>
  );
}
