import type { ProjectStatus } from "@/lib/projects";

const STYLES: Record<ProjectStatus, { label: string; className: string }> = {
  bootstrapping: { label: "Setting up…", className: "bg-amber-500/10 text-amber-700 dark:text-amber-400" },
  ready: { label: "Ready", className: "bg-green-500/10 text-green-700 dark:text-green-400" },
  failed: { label: "Setup failed", className: "bg-red-500/10 text-red-600" },
};

export function ProjectStatusBadge({ status }: { status: ProjectStatus }) {
  const { label, className } = STYLES[status];
  return <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${className}`}>{label}</span>;
}
