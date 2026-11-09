import { resolveMergeConflicts, syncDoneTasks } from "@/lib/agent";
import { stopPreview, taskPreviewTarget } from "@/lib/preview";
import { getTask, updateTask } from "@/lib/task-store";
import { AgentRun } from "@/lib/tracing";
import { commitAndMergeTask, MergeConflictError, taskVcs } from "@/lib/workspace";

export async function POST(request: Request, ctx: RouteContext<"/api/tasks/[id]/commit">) {
  const task = await getTask((await ctx.params).id);
  if (!task) return Response.json({ error: "not found" }, { status: 404 });
  if (task.status !== "done") return Response.json({ error: "only done tasks can be committed" }, { status: 409 });
  if (task.checking) return Response.json({ error: "this task is being re-checked against main" }, { status: 409 });
  const { message } = await request.json();
  const commitMessage = typeof message === "string" && message.trim() ? message.trim() : task.title;

  await stopPreview(taskPreviewTarget(task));
  try {
    const run = await AgentRun.start({ agentName: "merge", vcs: await taskVcs(task) });
    const mergedCommit = await run.run(async () => {
      const { commit, mergeCommit } = await commitAndMergeTask(task, commitMessage);
      run.setAttributes({ "dash0.gen_ai.vcs.ref.head.merge_commit": mergeCommit });
      return commit;
    });
    const merged = await updateTask(task.id, { mergedCommit, branch: undefined });
    void syncDoneTasks(task.projectId).catch((e) => console.error("[commit] failed to sync done tasks with main", e));
    return Response.json(merged);
  } catch (error) {
    if (error instanceof MergeConflictError) {
      await resolveMergeConflicts(task, error.files);
      return Response.json({ error: `${error.message}. Sent back to the agent to resolve.` }, { status: 409 });
    }
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 });
  }
}
