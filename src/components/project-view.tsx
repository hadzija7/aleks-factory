"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { PROJECT_TEMPLATES, type Project } from "@/lib/projects";
import { KanbanBoard } from "./kanban-board";
import { PreviewControl } from "./preview-control";
import { ProjectStatusBadge } from "./project-status-badge";

const POLL_MS = 3000;

export function ProjectView({ projectId }: { projectId: string }) {
  const [project, setProject] = useState<Project | null | undefined>(undefined);

  const load = useCallback(
    () =>
      fetch(`/api/projects/${projectId}`, { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : null))
        .then((next: Project | null) => setProject(next)),
    [projectId],
  );

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (project?.status !== "bootstrapping") return;
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [project?.status, load]);

  if (project === undefined) return <p className="text-sm opacity-60">Loading…</p>;
  if (project === null)
    return (
      <p className="text-sm">
        Project not found. <Link href="/" className="underline">Back to projects</Link>
      </p>
    );

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link href="/" className="text-xs opacity-60 hover:opacity-100">
            ← Projects
          </Link>
          <h1 className="flex items-center gap-3 text-2xl font-semibold">
            {project.name} <ProjectStatusBadge status={project.status} />
          </h1>
          <p className="text-sm opacity-60">
            {PROJECT_TEMPLATES.find((t) => t.id === project.template)?.label} · local git repo · drag a task to “In Execution” to hand it to the agent
          </p>
        </div>
        {project.status === "ready" && (
          <div className="flex flex-col items-end gap-1">
            <span className="text-xs uppercase opacity-50">main branch</span>
            <PreviewControl endpoint={`/api/projects/${project.id}/preview`} label="Preview main" />
          </div>
        )}
      </header>

      {project.status === "bootstrapping" && (
        <div className="flex items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-5 text-sm">
          <span className="h-3 w-3 animate-pulse rounded-full bg-amber-500" />
          Scaffolding the app and installing dependencies in Docker. The first project takes a few minutes while the image and npm cache warm up.
        </div>
      )}
      {project.status === "failed" && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-5 text-sm text-red-600">
          <p className="font-medium">Project setup failed. Delete it from the projects page and try again.</p>
          {project.error && <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap text-xs">{project.error}</pre>}
        </div>
      )}
      {project.status === "ready" && <KanbanBoard projectId={project.id} />}
    </div>
  );
}
