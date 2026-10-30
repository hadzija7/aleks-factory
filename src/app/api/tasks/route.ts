import { connection } from "next/server";
import { createTask, listTasks } from "@/lib/task-store";

export async function GET() {
  await connection();
  return Response.json(await listTasks());
}

export async function POST(request: Request) {
  const { title, description } = await request.json();
  if (typeof title !== "string" || !title.trim()) {
    return Response.json({ error: "title is required" }, { status: 400 });
  }
  const task = await createTask({ title: title.trim(), description: String(description ?? "").trim() });
  return Response.json(task, { status: 201 });
}
