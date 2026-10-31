import { stopPreview, taskPreviewTarget } from "@/lib/preview";
import { getTask, updateTask } from "@/lib/task-store";
import { commitAndMergeTask } from "@/lib/workspace";

export async function POST(request: Request, ctx: RouteContext<"/api/tasks/[id]/commit">) {
  const task = await getTask((await ctx.params).id);
  if (!task) return Response.json({ error: "not found" }, { status: 404 });
  if (task.status !== "done") return Response.json({ error: "only done tasks can be committed" }, { status: 409 });
  const { message } = await request.json();
  const commitMessage = typeof message === "string" && message.trim() ? message.trim() : task.title;

  await stopPreview(taskPreviewTarget(task));
  try {
    const mergedCommit = await commitAndMergeTask(task, commitMessage);
    return Response.json(await updateTask(task.id, { mergedCommit, branch: undefined }));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 });
  }
}
