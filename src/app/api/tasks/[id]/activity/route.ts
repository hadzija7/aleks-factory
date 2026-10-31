import { connection } from "next/server";
import { getActivity, subscribeActivity } from "@/lib/activity-log";
import { getTask } from "@/lib/task-store";

const PING_MS = 15_000;

/** Server-sent events: a `snapshot` of the task's activity so far, then an `entry` for every new or updated line. */
export async function GET(request: Request, ctx: RouteContext<"/api/tasks/[id]/activity">) {
  await connection();
  const { id } = await ctx.params;
  if (!(await getTask(id))) return Response.json({ error: "not found" }, { status: 404 });

  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const write = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup();
        }
      };
      const send = (event: string, data: unknown) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send("snapshot", getActivity(id));
      const unsubscribe = subscribeActivity(id, (entry) => send("entry", entry));
      const ping = setInterval(() => write(": ping\n\n"), PING_MS);
      cleanup = () => {
        unsubscribe();
        clearInterval(ping);
      };
      request.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {}
      });
    },
    cancel: () => cleanup(),
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  });
}
