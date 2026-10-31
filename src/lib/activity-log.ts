import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ActivityEntry } from "./activity";

const DIR = path.join(process.cwd(), "data", "activity");
const MAX_DETAIL_CHARS = 6000;
const PERSIST_DELAY_MS = 500;

type Log = { entries: ActivityEntry[]; nextId: number; persistTimer?: NodeJS.Timeout };

// On globalThis so dev hot reloads keep live logs and their SSE subscribers.
const store = ((globalThis as { __activityLogs?: { logs: Map<string, Log>; emitter: EventEmitter } }).__activityLogs ??= {
  logs: new Map(),
  emitter: new EventEmitter().setMaxListeners(0),
});

const file = (taskId: string) => path.join(DIR, `${taskId}.json`);

const cap = (text?: string) => (text && text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS)}\n… [${text.length - MAX_DETAIL_CHARS} more chars]` : text);

// Synchronous on purpose: a fast tool's "completed" event must never overtake the entry created for "started".
function load(taskId: string): Log {
  let log = store.logs.get(taskId);
  if (log) return log;
  let entries: ActivityEntry[] = [];
  try {
    entries = JSON.parse(readFileSync(file(taskId), "utf8"));
  } catch {}
  log = { entries, nextId: (entries.at(-1)?.id ?? 0) + 1 };
  store.logs.set(taskId, log);
  return log;
}

function changed(taskId: string, log: Log, entry: ActivityEntry) {
  store.emitter.emit(taskId, entry);
  clearTimeout(log.persistTimer);
  log.persistTimer = setTimeout(async () => {
    await mkdir(DIR, { recursive: true });
    await writeFile(file(taskId), JSON.stringify(log.entries)).catch((e) => console.error(`[activity] failed to save ${taskId}`, e));
  }, PERSIST_DELAY_MS);
}

export function addActivity(taskId: string, entry: Omit<ActivityEntry, "id" | "at">) {
  const log = load(taskId);
  const full: ActivityEntry = { ...entry, detail: cap(entry.detail), id: log.nextId++, at: new Date().toISOString() };
  log.entries.push(full);
  changed(taskId, log, full);
  return full.id;
}

/** Finishes or amends an entry; `durationMs` is filled in automatically when a running entry stops running. */
export function updateActivity(taskId: string, id: number, patch: Partial<Omit<ActivityEntry, "id" | "at">>) {
  const log = load(taskId);
  const index = log.entries.findIndex((e) => e.id === id);
  if (index === -1) return;
  const current = log.entries[index];
  const finishing = current.status === "running" && patch.status && patch.status !== "running";
  const next = {
    ...current,
    ...patch,
    detail: cap(patch.detail ?? current.detail),
    durationMs: finishing ? Date.now() - Date.parse(current.at) : current.durationMs,
  };
  log.entries[index] = next;
  changed(taskId, log, next);
}

export const getActivity = (taskId: string) => load(taskId).entries;

export function subscribeActivity(taskId: string, listener: (entry: ActivityEntry) => void) {
  store.emitter.on(taskId, listener);
  return () => void store.emitter.off(taskId, listener);
}

export async function clearActivity(taskId: string) {
  clearTimeout(store.logs.get(taskId)?.persistTimer);
  store.logs.delete(taskId);
  await rm(file(taskId), { force: true });
}
