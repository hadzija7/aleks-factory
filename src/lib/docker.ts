import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

export const execFileAsync = promisify(execFile);

export const CONTAINER_LABEL = "aleks-factory.sandbox=1";
const OWNER_LABEL = "aleks-factory.pid";
const NPM_CACHE_VOLUME = "aleks-factory-npm-cache";

/** Labels for every container we start; the owner pid lets other processes tell live containers from stale ones. */
export const containerLabels = () => ["--label", CONTAINER_LABEL, "--label", `${OWNER_LABEL}=${process.pid}`];
export const DEFAULT_SANDBOX_IMAGE = process.env.AGENT_SANDBOX_IMAGE ?? "node:22-bookworm";
export const DATA_DIR = path.join(process.cwd(), "data");

export const errorMessage = (error: unknown, max = 8 * 1024) => {
  const e = error as { stderr?: string; stdout?: string; message?: string };
  return (e.stderr?.trim() || e.stdout?.trim() || e.message || String(error)).slice(-max);
};

// Process-wide state lives on globalThis so dev hot reloads don't treat this process's containers as stale.
const registry = ((globalThis as { __agentSandboxes?: { active: Set<string>; cleanupInstalled: boolean; staleCleanup?: Promise<void> } })
  .__agentSandboxes ??= { active: new Set(), cleanupInstalled: false });
const active = registry.active;

function removeActiveSync() {
  if (active.size === 0) return;
  try {
    execFileSync("docker", ["rm", "-f", ...active], { stdio: "ignore", timeout: 15_000 });
  } catch {}
  active.clear();
}

function installProcessCleanup() {
  if (registry.cleanupInstalled) return;
  registry.cleanupInstalled = true;
  // "exit" also fires when Node dies from an uncaught exception, so it covers crashes.
  process.on("exit", removeActiveSync);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => {
      removeActiveSync();
      // Only force the exit if nobody else (e.g. Next.js) is handling the signal.
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
    });
  }
}

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Removes containers whose owning process has exited (e.g. after a crash). Runs once per process, before the first
 * container starts. Containers of other live processes (a second server, tests) are left alone.
 */
export function removeStaleContainers() {
  return (registry.staleCleanup ??= (async () => {
    try {
      const { stdout } = await execFileAsync("docker", ["ps", "-a", "--filter", `label=${CONTAINER_LABEL}`, "--format", `{{.ID}} {{.Label "${OWNER_LABEL}"}}`]);
      const ids = stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split(" "))
        .filter(([, pid]) => !Number(pid) || (Number(pid) !== process.pid && !isAlive(Number(pid))))
        .map(([id]) => id);
      if (ids.length) await execFileAsync("docker", ["rm", "-f", ...ids]);
    } catch (error) {
      console.error("[docker] failed to remove stale containers:", errorMessage(error));
    }
  })());
}

/** Call before `docker run --name <name>`: replaces any old container with that name and removes it when this process exits. */
export async function claimContainer(name: string) {
  installProcessCleanup();
  await removeStaleContainers();
  await execFileAsync("docker", ["rm", "-f", name]).catch(() => {});
  active.add(name);
}

export async function removeContainer(name: string) {
  active.delete(name);
  await execFileAsync("docker", ["rm", "-f", name]).catch((error) => console.error(`[docker] failed to remove ${name}:`, errorMessage(error)));
}

let passwdFile: string | undefined;
/**
 * Runs the container as the host user so files it writes stay owned by them. The uid gets a passwd entry,
 * otherwise tools calling os.userInfo() (e.g. create-next-app) crash.
 */
export function hostUserArgs() {
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  if (!passwdFile) {
    passwdFile = path.join(DATA_DIR, "docker", "passwd");
    mkdirSync(path.dirname(passwdFile), { recursive: true });
    writeFileSync(passwdFile, `root:x:0:0:root:/root:/bin/bash\napp:x:${uid}:${gid}:app:/tmp:/bin/bash\n`);
  }
  return ["--user", `${uid}:${gid}`, "-e", "HOME=/tmp", "-v", `${passwdFile}:/etc/passwd:ro`];
}

export const nodeModulesVolume = (key: string) => `aleks-factory-nm-${key}`;

const readyVolumes = new Set<string>();
/** Creates a named volume owned by the host user (new volumes are root-owned, which the non-root container can't write). */
async function ensureVolume(name: string) {
  if (readyVolumes.has(name)) return;
  const exists = await execFileAsync("docker", ["volume", "inspect", name]).then(() => true, () => false);
  if (!exists) {
    await execFileAsync("docker", ["volume", "create", "--label", CONTAINER_LABEL, name]);
    const owner = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
    await execFileAsync("docker", ["run", "--rm", "--user", "0", "-v", `${name}:/v`, DEFAULT_SANDBOX_IMAGE, "chown", owner, "/v"]);
  }
  readyVolumes.add(name);
}

/**
 * Mounts `node_modules` (per checkout) and the npm cache (shared) from Docker volumes. Writing tens of thousands of
 * small files through a macOS bind mount is what makes installs take minutes; inside a volume they take seconds.
 */
export async function dependencyArgs(nodeModulesKey?: string) {
  await ensureVolume(NPM_CACHE_VOLUME);
  const args = ["-v", `${NPM_CACHE_VOLUME}:/tmp/.npm`];
  if (nodeModulesKey) {
    await ensureVolume(nodeModulesVolume(nodeModulesKey));
    args.push("-v", `${nodeModulesVolume(nodeModulesKey)}:/work/node_modules`);
  }
  return args;
}

export async function removeVolume(name: string) {
  readyVolumes.delete(name);
  await execFileAsync("docker", ["volume", "rm", "-f", name]).catch((error) => console.error(`[docker] failed to remove volume ${name}:`, errorMessage(error)));
}

/** Runs a one-off networked setup command (scaffolding, dependency installs) with `dir` mounted at /work. */
export async function runSetupCommand(dir: string, command: string, nodeModulesKey?: string, timeoutMs = 10 * 60_000): Promise<{ ok: boolean; output: string }> {
  const name = `setup-${randomUUID().slice(0, 8)}`;
  await claimContainer(name);
  try {
    const { stdout, stderr } = await execFileAsync(
      "docker",
      [
        "run", "--rm", "--name", name, ...containerLabels(),
        "-v", `${dir}:/work`, "-w", "/work", ...hostUserArgs(), ...(await dependencyArgs(nodeModulesKey)),
        "--memory", "2g", "--cpus", "2", "--pids-limit", "512",
        DEFAULT_SANDBOX_IMAGE, "bash", "-c", command,
      ],
      { timeout: timeoutMs, maxBuffer: 50 * 1024 * 1024 },
    );
    return { ok: true, output: `${stdout}${stderr}`.slice(-8 * 1024) };
  } catch (error) {
    return { ok: false, output: errorMessage(error) };
  } finally {
    await removeContainer(name);
  }
}
