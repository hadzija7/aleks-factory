import { connection } from "next/server";
import { clearActivity } from "@/lib/activity-log";
import { mainPreviewTarget, stopPreview, taskPreviewTarget } from "@/lib/preview";
import { deleteProject, getProject, updateProject } from "@/lib/project-store";
import { normalizeDomain } from "@/lib/projects";
import { deleteProjectTasks, listTasks } from "@/lib/task-store";
import { isAgentBusy } from "@/lib/tasks";
import { removeProjectFiles } from "@/lib/workspace";

export async function GET(_request: Request, ctx: RouteContext<"/api/projects/[id]">) {
  await connection();
  const project = await getProject((await ctx.params).id);
  return project ? Response.json(project) : Response.json({ error: "not found" }, { status: 404 });
}

/** Updates the domains agent sandboxes may reach. Running tasks pick the change up at their next phase. */
export async function PATCH(request: Request, ctx: RouteContext<"/api/projects/[id]">) {
  const { id } = await ctx.params;
  const { allowedDomains } = await request.json();
  if (!Array.isArray(allowedDomains)) return Response.json({ error: "allowedDomains must be an array" }, { status: 400 });
  const domains = allowedDomains.map((d) => (typeof d === "string" ? normalizeDomain(d) : undefined));
  const invalid = allowedDomains.filter((_, i) => !domains[i]);
  if (invalid.length) return Response.json({ error: `invalid domain: ${invalid.join(", ")}` }, { status: 400 });
  const project = await updateProject(id, { allowedDomains: [...new Set(domains as string[])] });
  return project ? Response.json(project) : Response.json({ error: "not found" }, { status: 404 });
}

export async function DELETE(_request: Request, ctx: RouteContext<"/api/projects/[id]">) {
  const { id } = await ctx.params;
  const project = await getProject(id);
  if (!project) return Response.json({ error: "not found" }, { status: 404 });
  const tasks = await listTasks(id);
  if (project.status === "bootstrapping" || tasks.some((task) => isAgentBusy(task.status))) {
    return Response.json({ error: "wait for running agents and setup to finish" }, { status: 409 });
  }
  await Promise.all([stopPreview(mainPreviewTarget(id)), ...tasks.map((task) => stopPreview(taskPreviewTarget(task)))]);
  await removeProjectFiles(id, tasks);
  await Promise.all(tasks.map((task) => clearActivity(task.id)));
  await deleteProjectTasks(id);
  await deleteProject(id);
  return new Response(null, { status: 204 });
}
