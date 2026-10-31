import path from "node:path";
import { DEFAULT_SANDBOX_IMAGE, claimContainer, containerLabels, dependencyArgs, execFileAsync, hostUserArgs, removeContainer } from "./docker";
import type { Preview } from "./projects";
import type { Task } from "./tasks";
import { repoDir, repoKey, taskKey, worktreeDir } from "./workspace";

const APP_PORT = 3000;

/** A preview is one dev-server container for either a task's worktree or the project's main branch. `key` also names its node_modules volume. */
export type PreviewTarget = { key: string; dir: string; extraArgs?: string[] };

export const taskPreviewTarget = (task: Task): PreviewTarget => ({ key: taskKey(task), dir: worktreeDir(task) });

// main only ever contains reviewed commits, but its .git is still mounted read-only so the dev server can't touch history.
export const mainPreviewTarget = (projectId: string): PreviewTarget => ({
  key: repoKey(projectId),
  dir: repoDir(projectId),
  extraArgs: ["-v", `${path.join(repoDir(projectId), ".git")}:/work/.git:ro`],
});

const containerName = (target: PreviewTarget) => `preview-${target.key}`;

export async function startPreview(target: PreviewTarget) {
  const name = containerName(target);
  await claimContainer(name);
  await execFileAsync("docker", [
    "run", "-d", "--name", name, ...containerLabels(),
    "-v", `${target.dir}:/work`, ...(target.extraArgs ?? []), "-w", "/work", ...hostUserArgs(), ...(await dependencyArgs(target.key)),
    "-p", `127.0.0.1::${APP_PORT}`, "-e", "NEXT_TELEMETRY_DISABLED=1",
    "--memory", "2g", "--cpus", "2", "--pids-limit", "512",
    DEFAULT_SANDBOX_IMAGE, "bash", "-c",
    `[ -f node_modules/.package-lock.json ] || npm ci --no-audit --no-fund; exec npm run dev -- -H 0.0.0.0 -p ${APP_PORT}`,
  ]);
}

export async function getPreview(target: PreviewTarget): Promise<Preview> {
  const name = containerName(target);
  let state: string;
  try {
    state = (await execFileAsync("docker", ["inspect", "-f", "{{.State.Status}}", name])).stdout.trim();
  } catch {
    return { status: "stopped" };
  }
  if (state !== "running") {
    const logs = await execFileAsync("docker", ["logs", "--tail", "40", name]).then((r) => `${r.stdout}${r.stderr}`, () => "");
    return { status: "failed", error: logs.trim() || `Preview container is ${state}` };
  }
  const mapping = (await execFileAsync("docker", ["port", name, `${APP_PORT}/tcp`])).stdout.trim().split("\n")[0];
  const url = `http://localhost:${mapping.split(":").pop()}`;
  const up = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: "manual" }).then(() => true, () => false);
  return { status: up ? "running" : "starting", url };
}

export const stopPreview = (target: PreviewTarget) => removeContainer(containerName(target));
