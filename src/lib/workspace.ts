import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseDiff } from "./diff";
import { DATA_DIR, errorMessage, execFileAsync, nodeModulesVolume, removeVolume, runSetupCommand } from "./docker";
import type { DiffFile, LocalEnvFile, Project } from "./projects";
import type { Task } from "./tasks";
import { AgentRun } from "./tracing";

const CREATE_NEXT_APP = "create-next-app@16.4.2";

export const projectDir = (projectId: string) => path.join(DATA_DIR, "projects", projectId);
export const repoDir = (projectId: string) => path.join(projectDir(projectId), "repo");
export const worktreeDir = (task: Task) => path.join(projectDir(task.projectId), "worktrees", task.id);
export const branchName = (task: Task) => `task/${task.id.slice(0, 8)}`;
/** Keys naming each checkout's node_modules volume (and its preview container). */
export const repoKey = (projectId: string) => `project-${projectId}`;
export const taskKey = (task: Task) => `task-${task.id}`;
const worktreeGitDir = (task: Task) => path.join(repoDir(task.projectId), ".git", "worktrees", task.id);

let identity: Promise<string[]> | undefined;
// Use the user's git identity when configured, otherwise a local fallback so commits never fail on it.
const identityArgs = () =>
  (identity ??= execFileAsync("git", ["config", "--get", "user.email"]).then(
    () => [],
    () => ["-c", "user.name=Aleks Factory", "-c", "user.email=factory@localhost"],
  ));

// Hooks and fsmonitor can execute commands, so they are always off: worktree contents are written by agents.
async function git(cwd: string, args: string[]) {
  const safety = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.quotePath=false"];
  const { stdout } = await execFileAsync("git", [...safety, ...(await identityArgs()), ...args], { cwd, maxBuffer: 50 * 1024 * 1024 });
  return stdout;
}

/**
 * Git commands for a task's worktree. The admin dir is passed explicitly instead of trusting the `.git` file inside the
 * worktree, which the agent can overwrite (e.g. to point git at a config that runs host commands).
 */
const worktreeGit = (task: Task, args: string[]) => {
  // One command at a time per worktree: concurrent writers (e.g. two diff requests staging at once) fail on index.lock.
  const dir = worktreeDir(task);
  const run = (worktreeQueues.get(dir) ?? Promise.resolve()).then(() => git(dir, ["--git-dir", worktreeGitDir(task), "--work-tree", dir, ...args]));
  const tail = run.catch(() => {});
  worktreeQueues.set(dir, tail);
  void tail.then(() => worktreeQueues.get(dir) === tail && worktreeQueues.delete(dir));
  return run;
};
const worktreeQueues = new Map<string, Promise<unknown>>();

export async function bootstrapProject(project: Project) {
  const dir = repoDir(project.id);
  await mkdir(dir, { recursive: true });
  // create-next-app requires the target's parent to be writable, so mount the project folder and scaffold into repo/.
  const scaffold = await runSetupCommand(
    path.dirname(dir),
    `npx -y ${CREATE_NEXT_APP} ${path.basename(dir)} --ts --tailwind --eslint --app --src-dir --use-npm --disable-git --yes --no-agent-feedback --skip-install`,
  );
  if (!scaffold.ok) throw new Error(`create-next-app failed:\n${scaffold.output}`);
  const install = await runSetupCommand(dir, "npm install --no-audit --no-fund", repoKey(project.id));
  if (!install.ok) throw new Error(`npm install failed:\n${install.output}`);
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-m", "Bootstrap Next.js app"]);
}

const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

const isRegularFile = (file: string) => lstat(file).then((stat) => stat.isFile(), () => false);

/**
 * Gitignored env files at the checkout root (.env, .env.local, …). They hold secrets, so the board syncs them between
 * main and task worktrees itself instead of committing them. Symlinks are skipped so an agent can't pull in host files.
 */
async function localEnvFiles(dir: string, runGit: (args: string[]) => Promise<string>) {
  const listed = await runGit(["ls-files", "--others", "--ignored", "--exclude-standard", "--", ".env*"]);
  const names = listed.split("\n").filter((name) => name && !name.includes("/"));
  const regular = await Promise.all(names.map((name) => isRegularFile(path.join(dir, name))));
  return names.filter((_, i) => regular[i]);
}

/**
 * Copies env files from one checkout to another; for files that already exist, keys from `fromDir` win (or, with
 * `onlyMissing`, only keys `toDir` lacks are added) and other keys are kept.
 */
async function syncEnvFiles(fromDir: string, names: string[], toDir: string, onlyMissing = false) {
  for (const name of names) {
    const source = await readFile(path.join(fromDir, name), "utf8");
    const target = path.join(toDir, name);
    if (!(await isRegularFile(target))) {
      await rm(target, { force: true });
      await writeFile(target, source);
      continue;
    }
    const lines = (await readFile(target, "utf8")).split("\n");
    for (const line of source.split("\n")) {
      const key = line.match(ENV_LINE)?.[1];
      if (!key) continue;
      const index = lines.findIndex((l) => l.match(ENV_LINE)?.[1] === key);
      if (index === -1) lines.splice(lines.at(-1) === "" ? lines.length - 1 : lines.length, 0, line);
      else if (!onlyMissing) lines[index] = line;
    }
    await writeFile(target, lines.join("\n"));
  }
}

/** Env files in a task's worktree with their key names (never values), for the review screen. */
export async function taskEnvFiles(task: Task): Promise<LocalEnvFile[]> {
  if (!hasWorktree(task)) return [];
  const dir = worktreeDir(task);
  const names = await localEnvFiles(dir, (args) => worktreeGit(task, args));
  return Promise.all(
    names.map(async (name) => ({
      path: name,
      keys: (await readFile(path.join(dir, name), "utf8")).split("\n").flatMap((line) => line.match(ENV_LINE)?.[1] ?? []),
    })),
  );
}

/** Creates the task's branch and worktree off main (once) and installs dependencies so the offline agent sandbox can build. */
export async function ensureWorktree(task: Task) {
  const dir = worktreeDir(task);
  const branch = branchName(task);
  if (existsSync(dir)) return { dir, branch };
  const repo = repoDir(task.projectId);
  await mkdir(path.dirname(dir), { recursive: true });
  await git(repo, ["worktree", "prune"]);
  const branchExists = await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).then(() => true, () => false);
  await git(repo, branchExists ? ["worktree", "add", dir, branch] : ["worktree", "add", "-b", branch, dir, "main"]);
  if (!existsSync(worktreeGitDir(task))) throw new Error(`Unexpected worktree admin dir for ${branch}`);
  await syncEnvFiles(repo, await localEnvFiles(repo, (args) => git(repo, args)), dir);
  if (existsSync(path.join(dir, "package-lock.json"))) {
    const install = await AgentRun.step("npm ci", () => runSetupCommand(dir, "npm ci --no-audit --no-fund", taskKey(task)));
    if (!install.ok) throw new Error(`npm ci failed:\n${install.output}`);
  }
  return { dir, branch };
}

export const hasWorktree = (task: Task) => existsSync(worktreeDir(task));

/** Branch, HEAD commit and origin remote (if any) of a task's checkout, for tracing. */
export async function taskVcs(task: Task) {
  const optional = (run: Promise<string>) => run.then((out) => out.trim() || undefined, () => undefined);
  const [startingCommit, remoteUrl] = await Promise.all([
    // Before the worktree exists the run starts from the branch if it's left over, else from main, which it forks from.
    hasWorktree(task)
      ? optional(worktreeGit(task, ["rev-parse", "HEAD"]))
      : optional(git(repoDir(task.projectId), ["rev-parse", "--verify", "--quiet", `refs/heads/${branchName(task)}`])).then(
          (sha) => sha ?? optional(git(repoDir(task.projectId), ["rev-parse", "--verify", "main"])),
        ),
    optional(git(repoDir(task.projectId), ["remote", "get-url", "origin"])),
  ]);
  const base = process.env.FACTORY_PUBLIC_URL?.replace(/\/+$/, "");
  return { branch: branchName(task), startingCommit, remoteUrl, issueUrl: base && `${base}/projects/${task.projectId}?task=${task.id}` };
}

/** Everything the agents changed on the task branch, including uncommitted and new files. */
export async function taskDiff(task: Task): Promise<DiffFile[]> {
  if (!hasWorktree(task)) return [];
  await worktreeGit(task, ["add", "-A"]);
  // Compare against where the branch forked so work merged to main by other tasks doesn't show up as reverted.
  const base = (await worktreeGit(task, ["merge-base", "main", "HEAD"])).trim();
  return parseDiff(await worktreeGit(task, ["diff", "--cached", "--no-color", "--no-ext-diff", "-M", base]));
}

export class MergeConflictError extends Error {
  constructor(readonly files: string[]) {
    super(`Merging main into the task branch conflicts in ${files.join(", ")}`);
  }
}

const CONFLICT_MARKER = /^(<{7}|>{7})( |$)/m;

/** Stages everything in the worktree and commits it if anything changed. */
async function commitWorktree(task: Task, message: string) {
  await worktreeGit(task, ["add", "-A"]);
  const hasStaged = await worktreeGit(task, ["diff", "--cached", "--quiet"]).then(() => false, () => true);
  if (hasStaged) await worktreeGit(task, ["commit", "-m", message]);
  return hasStaged;
}

const unmergedFiles = async (task: Task) =>
  (await worktreeGit(task, ["diff", "--name-only", "--diff-filter=U"])).split("\n").filter(Boolean);

/** Files that still contain conflict markers (missing files count as resolved). */
async function filesWithMarkers(task: Task, files: string[]) {
  const dir = worktreeDir(task);
  const marked = await Promise.all(
    files.map(async (file) => (await isRegularFile(path.join(dir, file))) && CONFLICT_MARKER.test(await readFile(path.join(dir, file), "utf8"))),
  );
  return files.filter((_, i) => marked[i]);
}

/**
 * Brings main into the task branch so the work merges cleanly later: snapshots the agents' changes, merges main and, when
 * a previous merge stopped on conflicts, concludes it once no conflicted file has markers left. Returns the files still
 * in conflict; the merge is then left in progress (markers in the worktree) for the executor to resolve.
 */
export async function syncWithMain(task: Task, knownConflicts: string[] = []) {
  // Secrets added to main after the worktree was created (e.g. merged from another task) reach it here too.
  const repo = repoDir(task.projectId);
  await syncEnvFiles(repo, await localEnvFiles(repo, (args) => git(repo, args)), worktreeDir(task), true);
  if (existsSync(path.join(worktreeGitDir(task), "MERGE_HEAD"))) {
    const conflicted = [...new Set([...knownConflicts, ...(await unmergedFiles(task))])];
    const unresolved = await filesWithMarkers(task, conflicted);
    if (unresolved.length) return unresolved;
    await worktreeGit(task, ["add", "-A"]);
    await worktreeGit(task, ["commit", "--no-edit"]);
  }
  await commitWorktree(task, `WIP: ${task.title}`);
  const upToDate = await worktreeGit(task, ["merge-base", "--is-ancestor", "main", "HEAD"]).then(() => true, () => false);
  if (upToDate) return [];
  try {
    await worktreeGit(task, ["merge", "--no-edit", "main"]);
    return [];
  } catch (error) {
    const conflicts = await unmergedFiles(task);
    if (conflicts.length) return conflicts;
    await worktreeGit(task, ["merge", "--abort"]).catch(() => {});
    throw new Error(`Merging main into ${branchName(task)} failed:\n${errorMessage(error)}`);
  }
}

export const headRevision = async (task: Task) => (await worktreeGit(task, ["rev-parse", "HEAD"])).trim();

/** Files that differ between `revision` and the task branch's HEAD. */
export const changedSince = async (task: Task, revision: string) =>
  (await worktreeGit(task, ["diff", "--name-only", revision, "HEAD"])).split("\n").filter(Boolean);

/**
 * Commits the task's changes as one commit on top of main, merges it into main and removes the worktree.
 * Throws MergeConflictError when main has moved on in a conflicting way. Returns the task commit's short SHA and the
 * full SHA of the merge commit on main.
 */
export async function commitAndMergeTask(task: Task, message: string) {
  if (!hasWorktree(task)) throw new Error("This task has no workspace to commit");
  const conflicts = await syncWithMain(task, task.conflicts);
  if (conflicts.length) throw new MergeConflictError(conflicts);
  // The branch now contains main, so squash its snapshot and sync commits into a single commit with the user's message.
  await worktreeGit(task, ["reset", "--soft", "main"]);
  if (!(await commitWorktree(task, message))) throw new Error("No changes to commit");

  const repo = repoDir(task.projectId);
  const branch = branchName(task);
  try {
    await git(repo, ["merge", "--no-ff", "-m", `Merge ${branch}: ${task.title}`, branch]);
  } catch (error) {
    await git(repo, ["merge", "--abort"]).catch(() => {});
    throw new Error(`Merging ${branch} into main failed, likely a conflict with work merged since:\n${errorMessage(error)}`);
  }
  const [commit, mergeCommit] = (
    await Promise.all([git(repo, ["rev-parse", "--short", branch]), git(repo, ["rev-parse", "--verify", "main"])])
  ).map((sha) => sha.trim());
  // Env files are gitignored, so carry the task's secrets over to main before its worktree is deleted.
  await syncEnvFiles(worktreeDir(task), await localEnvFiles(worktreeDir(task), (args) => worktreeGit(task, args)), repo);
  await removeWorktree(task);
  return { commit, mergeCommit };
}

export async function removeWorktree(task: Task) {
  const repo = repoDir(task.projectId);
  if (!existsSync(repo)) return;
  await git(repo, ["worktree", "remove", "--force", worktreeDir(task)]).catch(() => rm(worktreeDir(task), { recursive: true, force: true }));
  await git(repo, ["worktree", "prune"]).catch(() => {});
  await git(repo, ["branch", "-D", branchName(task)]).catch(() => {});
  await removeVolume(nodeModulesVolume(taskKey(task)));
}

export async function removeProjectFiles(projectId: string, tasks: Task[]) {
  await Promise.all([repoKey(projectId), ...tasks.map(taskKey)].map((key) => removeVolume(nodeModulesVolume(key))));
  await rm(projectDir(projectId), { recursive: true, force: true });
}
