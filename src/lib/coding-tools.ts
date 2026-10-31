import { mkdirSync, realpathSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Tool } from "@mozaik-ai/core";
import type { DockerSandbox } from "./docker-sandbox";

const IGNORED_DIRS = new Set([".git", "node_modules", ".next", "dist", "build", "coverage"]);
const MAX_LIST_ENTRIES = 500;
const MAX_READ_LINES = 2000;
const MAX_OUTPUT_CHARS = 20_000;

type JsonSchemaProperty = { type: string | string[]; description: string };

function defineTool<TArgs>(
  name: string,
  description: string,
  properties: Record<keyof TArgs & string, JsonSchemaProperty>,
  invoke: (args: TArgs) => Promise<string>,
): Tool {
  return {
    type: "function",
    name,
    description,
    parameters: { type: "object", properties, required: Object.keys(properties), additionalProperties: false },
    strict: true,
    invoke,
  };
}

const isInside = (root: string, target: string) => {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

const exists = (p: string) => stat(p).then(() => true, () => false);

const truncate = (text: string, max = MAX_OUTPUT_CHARS) =>
  text.length > max ? `${text.slice(0, max / 2)}\n... [${text.length - max} chars truncated] ...\n${text.slice(-max / 2)}` : text;

export function createCodingTools(workspace: string, sandbox: Pick<DockerSandbox, "exec">): Tool[] {
  mkdirSync(workspace, { recursive: true });
  const root = realpathSync(workspace);

  // Resolves a model-supplied path and rejects anything (including symlinks) that escapes the workspace.
  async function resolvePath(p: string) {
    const target = path.resolve(root, p);
    if (!isInside(root, target)) throw new Error(`Path "${p}" is outside the project folder`);
    if (path.relative(root, target).split(path.sep)[0] === ".git") throw new Error("The .git metadata is managed by the board and cannot be accessed");
    let existing = target;
    while (!(await exists(existing))) existing = path.dirname(existing);
    if (!isInside(root, await realpath(existing))) throw new Error(`Path "${p}" resolves outside the project folder`);
    return target;
  }

  const display = (abs: string) => path.relative(root, abs) || ".";

  const listFiles = defineTool<{ path: string }>(
    "list_files",
    `Recursively lists files and directories under a path in the project (directories end with "/"). Skips ${[...IGNORED_DIRS].join(", ")}.`,
    { path: { type: "string", description: 'Directory relative to the project root, e.g. "." or "src"' } },
    async (args) => {
      const dir = await resolvePath(args.path);
      if (!(await stat(dir)).isDirectory()) throw new Error(`"${args.path}" is not a directory`);
      const entries: string[] = [];
      const walk = async (current: string) => {
        for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
          if (entries.length >= MAX_LIST_ENTRIES) return;
          const abs = path.join(current, entry.name);
          if (entry.isDirectory()) {
            entries.push(`${display(abs)}/`);
            if (!IGNORED_DIRS.has(entry.name)) await walk(abs);
          } else entries.push(display(abs));
        }
      };
      await walk(dir);
      if (entries.length === 0) return `"${args.path}" is empty`;
      return entries.join("\n") + (entries.length >= MAX_LIST_ENTRIES ? `\n... [truncated at ${MAX_LIST_ENTRIES} entries]` : "");
    },
  );

  const readFileTool = defineTool<{ path: string }>(
    "read_file",
    `Returns a file's contents with 1-based line numbers. Output is capped at ${MAX_READ_LINES} lines.`,
    { path: { type: "string", description: "File path relative to the project root" } },
    async (args) => {
      const lines = (await readFile(await resolvePath(args.path), "utf8")).split("\n");
      const width = String(Math.min(lines.length, MAX_READ_LINES)).length;
      const numbered = lines.slice(0, MAX_READ_LINES).map((line, i) => `${String(i + 1).padStart(width)}\t${line}`);
      if (lines.length > MAX_READ_LINES) numbered.push(`... [${lines.length - MAX_READ_LINES} more lines truncated]`);
      return truncate(numbered.join("\n"));
    },
  );

  const editFile = defineTool<{ path: string; old: string; new: string }>(
    "edit_file",
    "Replaces one exact occurrence of `old` with `new` in an existing file. Fails if `old` is not found or appears more than once; include more surrounding context to make it unique. Do not include line numbers from read_file.",
    {
      path: { type: "string", description: "File path relative to the project root" },
      old: { type: "string", description: "Exact text to replace, including whitespace and indentation" },
      new: { type: "string", description: "Replacement text" },
    },
    async (args) => {
      if (!args.old) throw new Error("`old` must not be empty; use write_file to create files");
      const file = await resolvePath(args.path);
      const content = await readFile(file, "utf8");
      const count = content.split(args.old).length - 1;
      if (count === 0) throw new Error(`\`old\` text not found in ${args.path}`);
      if (count > 1) throw new Error(`\`old\` text appears ${count} times in ${args.path}; add surrounding context to make it unique`);
      await writeFile(file, content.replace(args.old, () => args.new));
      return `Edited ${display(file)}`;
    },
  );

  const writeFileTool = defineTool<{ path: string; content: string }>(
    "write_file",
    "Creates a file (and any missing parent directories) with the given content, overwriting it if it exists. Prefer edit_file for changes to existing files.",
    {
      path: { type: "string", description: "File path relative to the project root" },
      content: { type: "string", description: "Full file content" },
    },
    async (args) => {
      const file = await resolvePath(args.path);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, args.content);
      return `Wrote ${args.content.length} chars to ${display(file)}`;
    },
  );

  const runCommand = defineTool<{ command: string }>(
    "run_command",
    "Runs a bash command in an isolated Linux container (no network) with the project root mounted at /work as the working directory, e.g. tests, build or lint. Non-interactive only, 60s timeout. Returns JSON {ok, exitCode, timedOut, stdout, stderr}; output is capped to the last 8 KB per stream.",
    { command: { type: "string", description: "Bash command to run" } },
    async (args) => JSON.stringify(await sandbox.exec(args.command)),
  );

  return [listFiles, readFileTool, editFile, writeFileTool, runCommand];
}
