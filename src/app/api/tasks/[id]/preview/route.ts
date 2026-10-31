import { connection } from "next/server";
import { getPreview, startPreview, stopPreview, taskPreviewTarget } from "@/lib/preview";
import { getTask } from "@/lib/task-store";
import { hasWorktree } from "@/lib/workspace";

async function target(ctx: RouteContext<"/api/tasks/[id]/preview">) {
  const task = await getTask((await ctx.params).id);
  return task && hasWorktree(task) ? taskPreviewTarget(task) : undefined;
}

const noWorkspace = () => Response.json({ error: "this task has no workspace to preview" }, { status: 409 });

export async function GET(_request: Request, ctx: RouteContext<"/api/tasks/[id]/preview">) {
  await connection();
  const t = await target(ctx);
  return Response.json(t ? await getPreview(t) : { status: "stopped" });
}

export async function POST(_request: Request, ctx: RouteContext<"/api/tasks/[id]/preview">) {
  const t = await target(ctx);
  if (!t) return noWorkspace();
  try {
    await startPreview(t);
  } catch (error) {
    return Response.json({ error: `Failed to start preview: ${error instanceof Error ? error.message : error}` }, { status: 500 });
  }
  return Response.json(await getPreview(t));
}

export async function DELETE(_request: Request, ctx: RouteContext<"/api/tasks/[id]/preview">) {
  const t = await target(ctx);
  if (t) await stopPreview(t);
  return new Response(null, { status: 204 });
}
