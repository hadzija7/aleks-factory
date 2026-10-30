import { executeTask } from "@/lib/agent";
import { deleteTask, getTask, updateTask } from "@/lib/task-store";
import { isTaskStatus } from "@/lib/tasks";

export async function PATCH(request: Request, ctx: RouteContext<"/api/tasks/[id]">) {
  const { id } = await ctx.params;
  const { status } = await request.json();
  if (!isTaskStatus(status)) return Response.json({ error: "invalid status" }, { status: 400 });

  const current = await getTask(id);
  if (!current) return Response.json({ error: "not found" }, { status: 404 });
  if (current.status === "in_progress") {
    return Response.json({ error: "task is being executed" }, { status: 409 });
  }

  const startsExecution = status === "in_progress";
  const task = await updateTask(id, startsExecution ? { status, result: undefined, error: undefined } : { status });
  if (startsExecution && task) executeTask(task);

  return Response.json(task);
}

export async function DELETE(_request: Request, ctx: RouteContext<"/api/tasks/[id]">) {
  const { id } = await ctx.params;
  const current = await getTask(id);
  if (current?.status === "in_progress") {
    return Response.json({ error: "task is being executed" }, { status: 409 });
  }
  return (await deleteTask(id)) ? new Response(null, { status: 204 }) : Response.json({ error: "not found" }, { status: 404 });
}
