import { connection } from "next/server";
import { currentStep } from "@/lib/activity";
import { getActivity } from "@/lib/activity-log";
import { getProject } from "@/lib/project-store";
import { createTask, listTasks } from "@/lib/task-store";
import { isAgentBusy } from "@/lib/tasks";

export async function GET(request: Request) {
  await connection();
  const projectId = new URL(request.url).searchParams.get("projectId");
  if (!projectId) return Response.json({ error: "projectId is required" }, { status: 400 });
  const tasks = await listTasks(projectId);
  return Response.json(tasks.map((task) => (isAgentBusy(task.status) ? { ...task, currentStep: currentStep(getActivity(task.id)) } : task)));
}

export async function POST(request: Request) {
  const { projectId, title, description } = await request.json();
  if (typeof title !== "string" || !title.trim()) {
    return Response.json({ error: "title is required" }, { status: 400 });
  }
  const project = typeof projectId === "string" ? await getProject(projectId) : undefined;
  if (!project) return Response.json({ error: "project not found" }, { status: 404 });
  const task = await createTask({ projectId: project.id, title: title.trim(), description: String(description ?? "").trim() });
  return Response.json(task, { status: 201 });
}
