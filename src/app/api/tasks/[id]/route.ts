import { clearActivity } from "@/lib/activity-log";
import { executeTask, reviewTask } from "@/lib/agent";
import { stopPreview, taskPreviewTarget } from "@/lib/preview";
import { getProject } from "@/lib/project-store";
import { deleteTask, getTask, updateTask } from "@/lib/task-store";
import { isAgentBusy, isTaskStatus } from "@/lib/tasks";
import { removeWorktree } from "@/lib/workspace";

export async function PATCH(request: Request, ctx: RouteContext<"/api/tasks/[id]">) {
  const { id } = await ctx.params;
  const { status } = await request.json();
  if (!isTaskStatus(status)) return Response.json({ error: "invalid status" }, { status: 400 });

  const current = await getTask(id);
  if (!current) return Response.json({ error: "not found" }, { status: 404 });
  if (isAgentBusy(current.status)) {
    return Response.json({ error: "an agent is working on this task" }, { status: 409 });
  }
  const startsAgent = status === "in_progress" || status === "in_review";
  if (startsAgent && (await getProject(current.projectId))?.status !== "ready") {
    return Response.json({ error: "the project is not ready yet" }, { status: 409 });
  }

  const patch =
    status === "in_progress"
      ? { status, result: undefined, review: undefined, reviewRounds: 0, mergedCommit: undefined, error: undefined }
      : status === "in_review"
        ? { status, review: undefined, error: undefined }
        : { status };
  const task = await updateTask(id, patch);
  if (task && status === "in_progress") executeTask(task);
  if (task && status === "in_review") reviewTask(task);

  return Response.json(task);
}

export async function DELETE(_request: Request, ctx: RouteContext<"/api/tasks/[id]">) {
  const { id } = await ctx.params;
  const current = await getTask(id);
  if (!current) return Response.json({ error: "not found" }, { status: 404 });
  if (isAgentBusy(current.status)) {
    return Response.json({ error: "an agent is working on this task" }, { status: 409 });
  }
  await stopPreview(taskPreviewTarget(current));
  await removeWorktree(current);
  await clearActivity(id);
  await deleteTask(id);
  return new Response(null, { status: 204 });
}
