import { randomUUID } from "node:crypto";
import path from "node:path";
import { createJsonStore } from "./json-store";
import type { Project } from "./projects";

const store = createJsonStore<Project>(path.join(process.cwd(), "data", "projects.json"));

export const listProjects = () => store.list();

export const getProject = store.get;

export const createProject = (input: Pick<Project, "name" | "template">) => {
  const now = new Date().toISOString();
  return store.create({ id: randomUUID(), ...input, status: "bootstrapping", createdAt: now, updatedAt: now });
};

export const updateProject = store.update;

export const deleteProject = store.remove;
