"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { PROJECT_TEMPLATES, type Project, type ProjectTemplate } from "@/lib/projects";
import { ProjectStatusBadge } from "./project-status-badge";

const POLL_MS = 3000;

export function ProjectList() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [template, setTemplate] = useState<ProjectTemplate>("nextjs");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    () =>
      fetch("/api/projects", { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : undefined))
        .then((next?: Project[]) => next && setProjects(next)),
    [],
  );

  useEffect(() => {
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const create = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const name = new FormData(form).get("name");
    setCreating(true);
    setError(null);
    const res = await fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, template }) });
    setCreating(false);
    if (!res.ok) return setError((await res.json().catch(() => null))?.error ?? res.statusText);
    form.reset();
    load();
  };

  const remove = async (project: Project) => {
    if (!confirm(`Delete "${project.name}" with its repository, branches and tasks? This cannot be undone.`)) return;
    const res = await fetch(`/api/projects/${project.id}`, { method: "DELETE" });
    if (!res.ok) setError((await res.json().catch(() => null))?.error ?? res.statusText);
    load();
  };

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_360px]">
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide opacity-70">Projects</h2>
        {projects?.length === 0 && <p className="rounded-xl border border-dashed border-black/15 p-8 text-center text-sm opacity-60 dark:border-white/20">No projects yet. Create one to get a repository and a task board.</p>}
        {projects?.map((project) => (
          <article key={project.id} className="group flex items-center gap-4 rounded-xl border border-black/10 p-4 hover:border-black/25 dark:border-white/15 dark:hover:border-white/30">
            <Link href={`/projects/${project.id}`} className="min-w-0 flex-1">
              <h3 className="truncate font-medium">{project.name}</h3>
              <p className="text-xs opacity-60">
                {PROJECT_TEMPLATES.find((t) => t.id === project.template)?.label} · created {new Date(project.createdAt).toLocaleDateString()}
              </p>
            </Link>
            <ProjectStatusBadge status={project.status} />
            {project.status !== "bootstrapping" && (
              <button onClick={() => remove(project)} className="text-xs opacity-0 hover:text-red-600 group-hover:opacity-60" aria-label="Delete project">
                ✕
              </button>
            )}
          </article>
        ))}
      </section>

      <form onSubmit={create} className="flex h-fit flex-col gap-4 rounded-xl border border-black/10 p-5 dark:border-white/15">
        <h2 className="font-semibold">New project</h2>
        <label className="flex flex-col gap-1 text-sm">
          <span className="opacity-70">Name</span>
          <input name="name" required placeholder="my-app" className="rounded-md border border-black/10 bg-transparent px-3 py-2 dark:border-white/15" />
        </label>
        <fieldset className="flex flex-col gap-2 text-sm">
          <legend className="mb-1 opacity-70">Bootstrap with</legend>
          {PROJECT_TEMPLATES.map((t) => (
            <label
              key={t.id}
              className={`flex cursor-pointer flex-col gap-0.5 rounded-lg border p-3 ${template === t.id ? "border-blue-500 bg-blue-500/5" : "border-black/10 dark:border-white/15"}`}
            >
              <span className="flex items-center gap-2 font-medium">
                <input type="radio" name="template" value={t.id} checked={template === t.id} onChange={() => setTemplate(t.id)} />
                {t.label}
              </span>
              <span className="pl-5 text-xs opacity-60">{t.description}</span>
            </label>
          ))}
        </fieldset>
        <p className="text-xs opacity-60">Creates a local git repository. Each task runs on its own branch, and you commit after reviewing the diff.</p>
        {error && <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600">{error}</p>}
        <button type="submit" disabled={creating} className="rounded-md bg-foreground px-4 py-2 font-medium text-background hover:opacity-90 disabled:opacity-50">
          {creating ? "Creating…" : "Create project"}
        </button>
      </form>
    </div>
  );
}
