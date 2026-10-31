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
  error?: string;
  createdAt: string;
  updatedAt: string;
};

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
