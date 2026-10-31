"use client";

import { useCallback, useEffect, useState } from "react";
import type { Preview } from "@/lib/projects";

const POLL_MS = 2000;

/** Start/stop a dev-server preview container behind `endpoint` (GET status, POST start, DELETE stop). */
export function PreviewControl({ endpoint, label = "Preview", compact = false }: { endpoint: string; label?: string; compact?: boolean }) {
  const [preview, setPreview] = useState<Preview>({ status: "stopped" });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(
    () =>
      fetch(endpoint, { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : undefined))
        .then((next?: Preview) => next && setPreview(next)),
    [endpoint],
  );

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (preview.status !== "starting") return;
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [preview.status, refresh]);

  const act = async (method: "POST" | "DELETE") => {
    setPending(true);
    setError(null);
    const res = await fetch(endpoint, { method });
    if (!res.ok) setError((await res.json().catch(() => null))?.error ?? res.statusText);
    else if (method === "POST") setPreview(await res.json());
    else setPreview({ status: "stopped" });
    setPending(false);
  };

  const button = "rounded-md border border-black/10 px-2.5 py-1 text-xs font-medium hover:bg-black/5 disabled:opacity-50 dark:border-white/15 dark:hover:bg-white/10";

  return (
    <div className="flex flex-col gap-1" onClick={(e) => e.stopPropagation()}>
      <div className="flex flex-wrap items-center gap-2">
        {(preview.status === "stopped" || preview.status === "failed") && (
          <button onClick={() => act("POST")} disabled={pending} className={button}>
            {pending ? "Starting…" : `▶ ${label}`}
          </button>
        )}
        {preview.status === "starting" && (
          <span className="flex items-center gap-1.5 text-xs text-amber-600">
            <span className="h-2 w-2 animate-pulse rounded-full bg-amber-500" /> Starting dev server…
          </span>
        )}
        {preview.status === "running" && preview.url && (
          <a href={preview.url} target="_blank" rel="noreferrer" className={`${button} border-green-600/40 text-green-700 dark:text-green-400`}>
            Open preview ↗
          </a>
        )}
        {(preview.status === "starting" || preview.status === "running") && (
          <button onClick={() => act("DELETE")} disabled={pending} className={`${button} opacity-70`}>
            Stop
          </button>
        )}
      </div>
      {!compact && preview.status === "running" && preview.url && <span className="text-xs opacity-50">{preview.url}</span>}
      {(error || preview.status === "failed") && (
        <details className="text-xs text-red-600">
          <summary className="cursor-pointer">{error ?? "Preview failed"}</summary>
          {preview.error && <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-red-500/10 p-2">{preview.error}</pre>}
        </details>
      )}
    </div>
  );
}
