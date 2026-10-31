"use client";

import { useEffect, useState } from "react";
import type { DiffFile, LocalEnvFile } from "@/lib/projects";
import type { Task } from "@/lib/tasks";

const LARGE_FILE_LINES = 400;

const STATUS_BADGE: Record<DiffFile["status"], { letter: string; className: string }> = {
  added: { letter: "A", className: "text-green-600" },
  deleted: { letter: "D", className: "text-red-600" },
  modified: { letter: "M", className: "text-amber-600" },
  renamed: { letter: "R", className: "text-blue-600" },
};

const fileId = (path: string) => `diff-${path.replace(/[^a-zA-Z0-9]/g, "-")}`;

/** Full-screen review of a task branch's changes, with commit & merge into main. */
export function DiffViewer({ task, onClose, onCommitted }: { task: Task; onClose: () => void; onCommitted: () => void }) {
  const [files, setFiles] = useState<DiffFile[] | null>(null);
  const [envFiles, setEnvFiles] = useState<LocalEnvFile[]>([]);
  const [message, setMessage] = useState(task.title);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/tasks/${task.id}/diff`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(res.statusText))))
      .then((data: { files: DiffFile[]; envFiles: LocalEnvFile[] }) => {
        setFiles(data.files);
        setEnvFiles(data.envFiles);
      })
      .catch((e: Error) => setError(`Failed to load diff: ${e.message}`));
  }, [task.id]);

  const commit = async () => {
    setCommitting(true);
    setError(null);
    const res = await fetch(`/api/tasks/${task.id}/commit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    setCommitting(false);
    if (!res.ok) return setError((await res.json().catch(() => null))?.error ?? res.statusText);
    onCommitted();
  };

  const totals = (files ?? []).reduce((acc, f) => ({ add: acc.add + f.additions, del: acc.del + f.deletions }), { add: 0, del: 0 });
  const canCommit = task.status === "done" && !!files?.length && !committing;

  return (
    <div onClick={onClose} className="fixed inset-0 z-20 flex bg-black/50 p-4">
      <div onClick={(e) => e.stopPropagation()} className="flex h-full w-full flex-col overflow-hidden rounded-xl bg-background shadow-2xl">
        <header className="flex items-center justify-between gap-4 border-b border-black/10 px-5 py-3 dark:border-white/15">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold">Review changes · {task.title}</h2>
            <p className="text-xs opacity-60">
              <code>{task.branch}</code> → <code>main</code>
              {files && (
                <>
                  {" "}· {files.length} file{files.length === 1 ? "" : "s"} · <span className="text-green-600">+{totals.add}</span>{" "}
                  <span className="text-red-600">−{totals.del}</span>
                </>
              )}
            </p>
          </div>
          <button onClick={onClose} className="opacity-60 hover:opacity-100" aria-label="Close">
            ✕
          </button>
        </header>

        <div className="flex min-h-0 flex-1">
          <nav className="hidden w-72 shrink-0 overflow-y-auto border-r border-black/10 p-2 text-sm md:block dark:border-white/15">
            {files?.map((f) => (
              <a key={f.path} href={`#${fileId(f.path)}`} className="flex items-center gap-2 rounded px-2 py-1 hover:bg-black/5 dark:hover:bg-white/10">
                <span className={`w-3 font-mono text-xs font-bold ${STATUS_BADGE[f.status].className}`}>{STATUS_BADGE[f.status].letter}</span>
                <span className="min-w-0 flex-1 truncate" title={f.path}>
                  {f.path}
                </span>
                <span className="shrink-0 font-mono text-[10px]">
                  <span className="text-green-600">+{f.additions}</span> <span className="text-red-600">−{f.deletions}</span>
                </span>
              </a>
            ))}
          </nav>

          <main className="min-w-0 flex-1 space-y-4 overflow-y-auto p-4">
            {!files && !error && <p className="text-sm opacity-60">Loading diff…</p>}
            {envFiles.length > 0 && <EnvFilesNote envFiles={envFiles} />}
            {files?.length === 0 && <p className="text-sm opacity-60">No changes on this branch yet.</p>}
            {files?.map((f) => <FileDiff key={f.path} file={f} />)}
          </main>
        </div>

        <footer className="flex flex-col gap-2 border-t border-black/10 px-5 py-3 sm:flex-row sm:items-center dark:border-white/15">
          {error && <p className="flex-1 whitespace-pre-wrap text-sm text-red-600">{error}</p>}
          {!error && task.status !== "done" && <p className="flex-1 text-sm opacity-60">Commit is available once the task is done.</p>}
          {!error && task.status === "done" && <span className="hidden flex-1 sm:block" />}
          <input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Commit message"
            className="rounded-md border border-black/10 bg-transparent px-3 py-2 text-sm sm:w-96 dark:border-white/15"
          />
          <button onClick={commit} disabled={!canCommit} className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90 disabled:opacity-40">
            {committing ? "Committing…" : "Commit & merge to main"}
          </button>
        </footer>
      </div>
    </div>
  );
}

/** Gitignored env files aren't part of the diff; show which keys exist (never values) and that they carry over to main. */
function EnvFilesNote({ envFiles }: { envFiles: LocalEnvFile[] }) {
  return (
    <section className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs">
      <p className="font-medium">Local environment (not committed, copied to main on merge)</p>
      {envFiles.map((f) => (
        <p key={f.path} className="mt-1 flex flex-wrap items-center gap-1.5">
          <code className="opacity-70">{f.path}</code>
          {f.keys.length === 0 && <span className="opacity-50">no keys</span>}
          {f.keys.map((key) => (
            <code key={key} className="rounded bg-black/5 px-1.5 py-0.5 dark:bg-white/10">
              {key}
            </code>
          ))}
        </p>
      ))}
    </section>
  );
}

function FileDiff({ file }: { file: DiffFile }) {
  const lineCount = file.hunks.reduce((n, h) => n + h.lines.length, 0);
  const [open, setOpen] = useState(lineCount <= LARGE_FILE_LINES);

  return (
    <section id={fileId(file.path)} className="overflow-hidden rounded-lg border border-black/10 dark:border-white/15">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 bg-black/[.03] px-3 py-2 text-left font-mono text-xs dark:bg-white/[.05]"
      >
        <span className="opacity-50">{open ? "▾" : "▸"}</span>
        <span className={`font-bold ${STATUS_BADGE[file.status].className}`}>{STATUS_BADGE[file.status].letter}</span>
        <span className="min-w-0 flex-1 truncate">
          {file.oldPath ? `${file.oldPath} → ` : ""}
          {file.path}
        </span>
        <span className="text-green-600">+{file.additions}</span>
        <span className="text-red-600">−{file.deletions}</span>
      </button>
      {open &&
        (file.binary ? (
          <p className="px-3 py-2 text-xs opacity-60">Binary file</p>
        ) : (
          <table className="w-full border-collapse font-mono text-xs leading-5">
            <tbody>
              {file.hunks.map((hunk, i) => (
                <HunkRows key={i} hunk={hunk} />
              ))}
            </tbody>
          </table>
        ))}
      {!open && lineCount > LARGE_FILE_LINES && <p className="px-3 py-2 text-xs opacity-60">Large diff ({lineCount} lines) collapsed — click the header to show.</p>}
    </section>
  );
}

function HunkRows({ hunk }: { hunk: DiffFile["hunks"][number] }) {
  return (
    <>
      <tr className="bg-blue-500/10 text-blue-700 dark:text-blue-300">
        <td colSpan={4} className="px-3 py-0.5">
          {hunk.header}
        </td>
      </tr>
      {hunk.lines.map((line, i) => (
        <tr
          key={i}
          className={line.type === "add" ? "bg-green-500/10" : line.type === "del" ? "bg-red-500/10" : undefined}
        >
          <td className="w-12 select-none px-2 text-right opacity-40">{line.oldLine ?? ""}</td>
          <td className="w-12 select-none px-2 text-right opacity-40">{line.newLine ?? ""}</td>
          <td className={`w-4 select-none ${line.type === "add" ? "text-green-600" : line.type === "del" ? "text-red-600" : "opacity-30"}`}>
            {line.type === "add" ? "+" : line.type === "del" ? "−" : ""}
          </td>
          <td className="whitespace-pre-wrap break-all pr-3">{line.text}</td>
        </tr>
      ))}
    </>
  );
}
