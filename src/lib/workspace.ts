import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseDiff } from "./diff";
import { DATA_DIR, errorMessage, execFileAsync, nodeModulesVolume, removeVolume, runSetupCommand } from "./docker";
import type { DiffFile, LocalEnvFile, Project } from "./projects";
import type { Task } from "./tasks";

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
const worktreeGit = (task: Task, args: string[]) =>
  git(worktreeDir(task), ["--git-dir", worktreeGitDir(task), "--work-tree", worktreeDir(task), ...args]);

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

/** Copies env files from one checkout to another; for files that already exist, keys from `fromDir` win and other keys are kept. */
async function syncEnvFiles(fromDir: string, names: string[], toDir: string) {
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
      else lines[index] = line;
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
    const install = await runSetupCommand(dir, "npm ci --no-audit --no-fund", taskKey(task));
    if (!install.ok) throw new Error(`npm ci failed:\n${install.output}`);
  }
  return { dir, branch };
}

export const hasWorktree = (task: Task) => existsSync(worktreeDir(task));

/** Everything the agents changed on the task branch, including uncommitted and new files. */
export async function taskDiff(task: Task): Promise<DiffFile[]> {
  if (!hasWorktree(task)) return [];
  await worktreeGit(task, ["add", "-A"]);
  // Compare against where the branch forked so work merged to main by other tasks doesn't show up as reverted.
  const base = (await worktreeGit(task, ["merge-base", "main", "HEAD"])).trim();
  return parseDiff(await worktreeGit(task, ["diff", "--cached", "--no-color", "--no-ext-diff", "-M", base]));
}

/** Commits the task's changes on its branch, merges it into main and removes the worktree. Returns the short commit SHA. */
export async function commitAndMergeTask(task: Task, message: string) {
  if (!hasWorktree(task)) throw new Error("This task has no workspace to commit");
  await worktreeGit(task, ["add", "-A"]);
  const hasStaged = await worktreeGit(task, ["diff", "--cached", "--quiet"]).then(() => false, () => true);
  if (hasStaged) await worktreeGit(task, ["commit", "-m", message]);

  const repo = repoDir(task.projectId);
  const branch = branchName(task);
  if ((await git(repo, ["rev-list", "--count", `main..${branch}`])).trim() === "0") throw new Error("No changes to commit");
  try {
    await git(repo, ["merge", "--no-ff", "-m", `Merge ${branch}: ${task.title}`, branch]);
  } catch (error) {
    await git(repo, ["merge", "--abort"]).catch(() => {});
    throw new Error(`Merging ${branch} into main failed, likely a conflict with work merged since:\n${errorMessage(error)}`);
  }
  const sha = (await git(repo, ["rev-parse", "--short", branch])).trim();
  // Env files are gitignored, so carry the task's secrets over to main before its worktree is deleted.
  await syncEnvFiles(worktreeDir(task), await localEnvFiles(worktreeDir(task), (args) => worktreeGit(task, args)), repo);
  await removeWorktree(task);
  return sha;
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
