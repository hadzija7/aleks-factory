import type { DiffFile, DiffHunk } from "./projects";

const stripPrefix = (p: string) => p.replace(/^[ab]\//, "");

/** Parses `git diff` unified output into files, hunks and numbered lines for the diff viewer. */
export function parseDiff(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let hunk: DiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;

  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const [, a = "", b = ""] = line.match(/^diff --git (a\/.*) (b\/.*)$/) ?? [];
      file = { path: stripPrefix(b), oldPath: undefined, status: "modified", additions: 0, deletions: 0, binary: false, hunks: [] };
      if (stripPrefix(a) !== file.path) file.oldPath = stripPrefix(a);
      files.push(file);
      hunk = undefined;
      continue;
    }
    if (!file) continue;
    if (!hunk) {
      if (line.startsWith("new file mode")) file.status = "added";
      else if (line.startsWith("deleted file mode")) file.status = "deleted";
      else if (line.startsWith("rename from ")) [file.status, file.oldPath] = ["renamed", line.slice(12)];
      else if (line.startsWith("rename to ")) file.path = line.slice(10);
      else if (line.startsWith("Binary files ")) file.binary = true;
      else if (line.startsWith("+++ ") && line !== "+++ /dev/null") file.path = stripPrefix(line.slice(4));
    }
    const header = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith("+")) {
      hunk.lines.push({ type: "add", newLine: newLine++, text: line.slice(1) });
      file.additions++;
    } else if (line.startsWith("-")) {
      hunk.lines.push({ type: "del", oldLine: oldLine++, text: line.slice(1) });
      file.deletions++;
    } else if (line.startsWith(" ")) {
      hunk.lines.push({ type: "context", oldLine: oldLine++, newLine: newLine++, text: line.slice(1) });
    }
  }
  for (const f of files) if (f.status !== "renamed" && f.status !== "modified") f.oldPath = undefined;
  return files;
}
