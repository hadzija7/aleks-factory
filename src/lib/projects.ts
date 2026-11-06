export const PROJECT_TEMPLATES = [
  { id: "nextjs", label: "Next.js app", description: "TypeScript, App Router, Tailwind CSS and ESLint via create-next-app" },
] as const;

export type ProjectTemplate = (typeof PROJECT_TEMPLATES)[number]["id"];

export type ProjectStatus = "bootstrapping" | "ready" | "failed";

export type Project = {
  id: string;
  name: string;
  template: ProjectTemplate;
  status: ProjectStatus;
  /** Extra domains agent sandboxes may reach through the egress proxy (e.g. "api.example.com", "*.example.com"). */
  allowedDomains?: string[];
  error?: string;
  createdAt: string;
  updatedAt: string;
};

/** Always reachable from agent sandboxes so they can install packages; projects add their own domains on top. */
export const DEFAULT_ALLOWED_DOMAINS = ["registry.npmjs.org"];

const DOMAIN = /^(\*\.)?([a-z0-9-]+\.)+[a-z]{2,}$/;

/** Normalizes input like "https://api.example.com/path" to "api.example.com"; returns undefined if it isn't a domain. */
export function normalizeDomain(input: string) {
  const host = input.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").split(/[/:?#]/)[0];
  return DOMAIN.test(host) ? host : undefined;
}

export const isProjectTemplate = (value: unknown): value is ProjectTemplate => PROJECT_TEMPLATES.some((t) => t.id === value);

export type PreviewStatus = "stopped" | "starting" | "running" | "failed";

export type Preview = { status: PreviewStatus; url?: string; error?: string };

export type DiffLine = { type: "add" | "del" | "context"; oldLine?: number; newLine?: number; text: string };

export type DiffHunk = { header: string; lines: DiffLine[] };

export type DiffFile = {
  path: string;
  oldPath?: string;
  status: "added" | "deleted" | "modified" | "renamed";
  additions: number;
  deletions: number;
  binary: boolean;
  hunks: DiffHunk[];
};

/** A gitignored env file in a checkout; only key names ever leave the server. */
export type LocalEnvFile = { path: string; keys: string[] };
