import { connection } from "next/server";
import { createProject, listProjects, updateProject } from "@/lib/project-store";
import { isProjectTemplate } from "@/lib/projects";
import { bootstrapProject } from "@/lib/workspace";

export async function GET() {
  await connection();
  return Response.json(await listProjects());
}

export async function POST(request: Request) {
  const { name, template = "nextjs" } = await request.json();
  if (typeof name !== "string" || !name.trim()) return Response.json({ error: "name is required" }, { status: 400 });
  if (!isProjectTemplate(template)) return Response.json({ error: "unknown template" }, { status: 400 });

  const project = await createProject({ name: name.trim(), template });
  // Scaffolding takes a minute or two; the UI polls the project status.
  void bootstrapProject(project).then(
    () => updateProject(project.id, { status: "ready" }),
    (error) => updateProject(project.id, { status: "failed", error: error instanceof Error ? error.message : String(error) }),
  );
  return Response.json(project, { status: 201 });
}
