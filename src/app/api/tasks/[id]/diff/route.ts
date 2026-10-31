import { connection } from "next/server";
import { getTask } from "@/lib/task-store";
import { taskDiff } from "@/lib/workspace";

export async function GET(_request: Request, ctx: RouteContext<"/api/tasks/[id]/diff">) {
  await connection();
  const task = await getTask((await ctx.params).id);
  if (!task) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ files: await taskDiff(task) });
}
