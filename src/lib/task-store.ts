import { randomUUID } from "node:crypto";
import path from "node:path";
import { createJsonStore } from "./json-store";
import { withCheck } from "./task-checks";
import type { Task } from "./tasks";

const store = createJsonStore<Task>(path.join(process.cwd(), "data", "tasks.json"));

export const listTasks = async (projectId: string) => (await store.list((task) => task.projectId === projectId)).map(withCheck);

export const getTask = async (id: string) => {
  const task = await store.get(id);
  return task && withCheck(task);
};

export const createTask = (input: Pick<Task, "projectId" | "title" | "description">) => {
  const now = new Date().toISOString();
  return store.create({ id: randomUUID(), ...input, status: "todo", createdAt: now, updatedAt: now });
};

export const updateTask = store.update;

export const deleteTask = store.remove;

export const deleteProjectTasks = async (projectId: string) => {
  for (const task of await listTasks(projectId)) await store.remove(task.id);
};
