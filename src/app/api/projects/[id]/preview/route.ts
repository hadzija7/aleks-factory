import { connection } from "next/server";
import { getPreview, mainPreviewTarget, startPreview, stopPreview } from "@/lib/preview";
import { getProject } from "@/lib/project-store";

async function target(ctx: RouteContext<"/api/projects/[id]/preview">) {
  const project = await getProject((await ctx.params).id);
  return project?.status === "ready" ? mainPreviewTarget(project.id) : undefined;
}

const notReady = () => Response.json({ error: "project is not ready" }, { status: 409 });

export async function GET(_request: Request, ctx: RouteContext<"/api/projects/[id]/preview">) {
  await connection();
  const t = await target(ctx);
  return t ? Response.json(await getPreview(t)) : notReady();
}

export async function POST(_request: Request, ctx: RouteContext<"/api/projects/[id]/preview">) {
  const t = await target(ctx);
  if (!t) return notReady();
  try {
    await startPreview(t);
  } catch (error) {
    return Response.json({ error: `Failed to start preview: ${error instanceof Error ? error.message : error}` }, { status: 500 });
  }
  return Response.json(await getPreview(t));
}

export async function DELETE(_request: Request, ctx: RouteContext<"/api/projects/[id]/preview">) {
  const t = await target(ctx);
  if (t) await stopPreview(t);
  return new Response(null, { status: 204 });
}
