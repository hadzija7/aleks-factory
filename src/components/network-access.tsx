"use client";

import { useState, type FormEvent } from "react";
import { DEFAULT_ALLOWED_DOMAINS, normalizeDomain, type Project } from "@/lib/projects";

/** Domains the project's agent sandboxes may reach through the egress proxy. */
export function NetworkAccess({ project, onChange }: { project: Project; onChange: (project: Project) => void }) {
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const domains = project.allowedDomains ?? [];

  const save = async (allowedDomains: string[]) => {
    setError(null);
    const res = await fetch(`/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allowedDomains }),
    });
    if (!res.ok) return setError((await res.json().catch(() => null))?.error ?? res.statusText);
    onChange(await res.json());
  };

  const add = (e: FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    const domain = normalizeDomain(input);
    if (!domain) return setError("Use a domain like api.example.com or *.example.com");
    setInput("");
    if (!domains.includes(domain)) save([...domains, domain]);
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="opacity-50" title="HTTP(S) access for agents' run_command, through an allowlisting proxy">
        Agent network
      </span>
      {DEFAULT_ALLOWED_DOMAINS.map((d) => (
        <code key={d} title="Always allowed" className="rounded bg-black/5 px-1.5 py-0.5 opacity-50 dark:bg-white/10">
          {d}
        </code>
      ))}
      {domains.map((d) => (
        <code key={d} className="flex items-center gap-1 rounded bg-blue-500/10 px-1.5 py-0.5 text-blue-700 dark:text-blue-300">
          {d}
          <button onClick={() => save(domains.filter((x) => x !== d))} className="opacity-50 hover:opacity-100" aria-label={`Remove ${d}`}>
            ✕
          </button>
        </code>
      ))}
      <form onSubmit={add}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="+ allow domain"
          className="w-36 rounded border border-transparent bg-transparent px-1.5 py-0.5 hover:border-black/10 focus:border-black/20 focus:outline-none dark:hover:border-white/15"
        />
      </form>
      {error && <span className="text-red-600">{error}</span>}
    </div>
  );
}
