import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Task } from "./tasks";

vi.mock("./docker", async (importOriginal) => ({ ...(await importOriginal<typeof import("./docker")>()), removeVolume: vi.fn() }));

const root = mkdtempSync(path.join(tmpdir(), "workspace-test-"));
vi.spyOn(process, "cwd").mockReturnValue(root);
const workspace = await import("./workspace");

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8" });
const repo = workspace.repoDir("p1");

let n = 0;
const newTask = (): Task => ({
  id: `task-${++n}-0000-0000`,
  projectId: "p1",
  title: `Task ${n}`,
  description: "",
  status: "done",
  createdAt: "",
  updatedAt: "",
});

/** Commits a change straight to main, as if another task had been merged. */
function commitOnMain(file: string, content: string) {
  writeFileSync(path.join(repo, file), content);
  git(repo, "add", "-A");
  git(repo, "commit", "-m", `main: ${file}`);
}

beforeAll(async () => {
  await mkdir(repo, { recursive: true });
  git(repo, "init", "-b", "main");
  writeFileSync(path.join(repo, "a.txt"), "one\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "init");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("syncWithMain", () => {
  it("merges unrelated main changes without conflicts", async () => {
    const task = newTask();
    const { dir } = await workspace.ensureWorktree(task);
    writeFileSync(path.join(dir, "b.txt"), "task\n");
    commitOnMain("c.txt", "main\n");

    const before = await workspace.headRevision(task);
    expect(await workspace.syncWithMain(task)).toEqual([]);
    expect(readFileSync(path.join(dir, "c.txt"), "utf8")).toBe("main\n");
    expect((await workspace.changedSince(task, before)).sort()).toEqual(["b.txt", "c.txt"]);
    const { commit, mergeCommit } = await workspace.commitAndMergeTask(task, "Add b");
    expect(git(repo, "log", "-1", "--format=%s", commit).trim()).toBe("Add b");
    expect(mergeCommit).toBe(git(repo, "rev-parse", "main").trim());
    expect(git(repo, "log", "-1", "--format=%P", mergeCommit).trim().split(" ")).toHaveLength(2);
    expect(readFileSync(path.join(repo, "b.txt"), "utf8")).toBe("task\n");
  });

  it("reports conflicts and concludes the merge once the markers are gone", async () => {
    const task = newTask();
    const { dir } = await workspace.ensureWorktree(task);
    writeFileSync(path.join(dir, "a.txt"), "task\n");
    commitOnMain("a.txt", "main\n");

    await expect(workspace.commitAndMergeTask(task, "Change a")).rejects.toBeInstanceOf(workspace.MergeConflictError);
    expect(readFileSync(path.join(dir, "a.txt"), "utf8")).toMatch(/^<{7} HEAD/m);
    // Still conflicted while markers remain, even after staging (e.g. by the diff viewer).
    await workspace.taskDiff(task);
    expect(await workspace.syncWithMain(task, ["a.txt"])).toEqual(["a.txt"]);

    writeFileSync(path.join(dir, "a.txt"), "main and task\n");
    expect(await workspace.syncWithMain(task, ["a.txt"])).toEqual([]);
    await workspace.commitAndMergeTask(task, "Change a");
    expect(readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("main and task\n");
  });

  it("adds env keys main gained since the worktree was created without overwriting the task's", async () => {
    commitOnMain(".gitignore", ".env*\n");
    const task = newTask();
    const { dir } = await workspace.ensureWorktree(task);
    writeFileSync(path.join(dir, ".env.local"), "SHARED=task\n");
    writeFileSync(path.join(repo, ".env.local"), "SHARED=main\nAPI_KEY=secret\n");

    await workspace.syncWithMain(task);
    expect(readFileSync(path.join(dir, ".env.local"), "utf8")).toBe("SHARED=task\nAPI_KEY=secret\n");
  });
});

describe("taskDiff", () => {
  it("handles concurrent requests without index.lock errors", async () => {
    const task = newTask();
    const { dir } = await workspace.ensureWorktree(task);
    for (let i = 0; i < 20; i++) writeFileSync(path.join(dir, `f${i}.txt`), `${i}\n`);
    const diffs = await Promise.all(Array.from({ length: 5 }, () => workspace.taskDiff(task)));
    for (const files of diffs) expect(files).toHaveLength(20);
  });
});
