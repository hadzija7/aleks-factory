import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Task } from "./tasks";

const DATA_FILE = path.join(process.cwd(), "data", "tasks.json");

let queue: Promise<unknown> = Promise.resolve();

const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
  const next = queue.then(fn, fn);
  queue = next.catch(() => undefined);
  return next;
};

async function readAll(): Promise<Task[]> {
  try {
    return JSON.parse(await readFile(DATA_FILE, "utf8")) as Task[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function writeAll(tasks: Task[]) {
  await mkdir(path.dirname(DATA_FILE), { recursive: true });
  await writeFile(DATA_FILE, JSON.stringify(tasks, null, 2));
}

export const listTasks = () => serialize(readAll);

export const getTask = (id: string) =>
  serialize(async () => (await readAll()).find((task) => task.id === id));

export const createTask = (input: Pick<Task, "title" | "description">) =>
  serialize(async () => {
    const now = new Date().toISOString();
    const task: Task = { id: randomUUID(), ...input, status: "todo", createdAt: now, updatedAt: now };
    await writeAll([...(await readAll()), task]);
    return task;
  });

export const updateTask = (id: string, patch: Partial<Omit<Task, "id" | "createdAt">>) =>
  serialize(async () => {
    const tasks = await readAll();
    const index = tasks.findIndex((task) => task.id === id);
    if (index === -1) return undefined;
    tasks[index] = { ...tasks[index], ...patch, updatedAt: new Date().toISOString() };
    await writeAll(tasks);
    return tasks[index];
  });

export const deleteTask = (id: string) =>
  serialize(async () => {
    const tasks = await readAll();
    const remaining = tasks.filter((task) => task.id !== id);
    await writeAll(remaining);
    return remaining.length !== tasks.length;
  });
