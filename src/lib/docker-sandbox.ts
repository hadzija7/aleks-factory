import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const LABEL = "aleks-factory.sandbox=1";
const COMMAND_TIMEOUT_S = 60;
// Host-side guard in case `docker exec` itself hangs past the in-container timeout.
const HOST_TIMEOUT_MS = (COMMAND_TIMEOUT_S + 15) * 1000;
const OUTPUT_CAP_BYTES = 8 * 1024;

export const DEFAULT_SANDBOX_IMAGE = process.env.AGENT_SANDBOX_IMAGE ?? "node:22-bookworm";

export type CommandResult = { ok: boolean; exitCode: number | null; timedOut: boolean; stdout: string; stderr: string };

const errorResult = (message: string): CommandResult => ({ ok: false, exitCode: null, timedOut: false, stdout: "", stderr: message });

const errorMessage = (error: unknown) => {
  const e = error as { stderr?: string; message?: string };
  return (e.stderr?.trim() || e.message || String(error)).slice(-OUTPUT_CAP_BYTES);
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

/** Removes agent sandboxes left behind by previous processes. Runs once per process, before the first container starts. */
export function removeStaleSandboxes() {
  return (registry.staleCleanup ??= (async () => {
    try {
      const { stdout } = await execFileAsync("docker", ["ps", "-aq", "--filter", `label=${LABEL}`, "--filter", "name=^agent-"]);
      const ids = stdout.split("\n").filter(Boolean);
      if (ids.length) await execFileAsync("docker", ["rm", "-f", ...ids]);
    } catch (error) {
      console.error("[sandbox] failed to remove stale containers:", errorMessage(error));
    }
  })());
}

/** Appends to a buffer while keeping only its last `OUTPUT_CAP_BYTES`. */
const appendTail = (buffer: Buffer, chunk: Buffer) => {
  const next = Buffer.concat([buffer, chunk]);
  return next.length > OUTPUT_CAP_BYTES ? next.subarray(next.length - OUTPUT_CAP_BYTES) : next;
};

/** One Docker container per agent session; the project root is the only host path it can write to. */
export class DockerSandbox {
  readonly name: string;
  private readonly projectRoot: string;
  private starting?: Promise<void>;

  constructor(
    sessionId: string,
    projectRoot: string,
    private readonly image = DEFAULT_SANDBOX_IMAGE,
  ) {
    this.name = `agent-${sessionId.replace(/[^a-zA-Z0-9_.-]/g, "-")}`;
    mkdirSync(projectRoot, { recursive: true });
    this.projectRoot = realpathSync(projectRoot);
  }

  start() {
    this.starting ??= this.createContainer().catch((error) => {
      this.starting = undefined;
      throw error;
    });
    return this.starting;
  }

  private async createContainer() {
    installProcessCleanup();
    await removeStaleSandboxes();
    await execFileAsync("docker", ["rm", "-f", this.name]).catch(() => {});
    const uid = process.getuid?.() ?? 1000;
    const gid = process.getgid?.() ?? 1000;
    // Track before `run` so a crash mid-start still cleans the container up.
    active.add(this.name);
    await execFileAsync("docker", [
      "run", "-d", "--name", this.name, "--label", LABEL,
      "--network", "none",
      "-v", `${this.projectRoot}:/work`, "-w", "/work",
      "--user", `${uid}:${gid}`, "-e", "HOME=/tmp",
      "--memory", "1g", "--cpus", "1", "--pids-limit", "256",
      this.image, "sleep", "infinity",
    ]);
  }

  private async isRunning() {
    try {
      const { stdout } = await execFileAsync("docker", ["inspect", "-f", "{{.State.Running}}", this.name]);
      return stdout.trim() === "true";
    } catch {
      return false;
    }
  }

  private dockerExec(command: string): Promise<CommandResult> {
    return new Promise((resolve) => {
      const child = spawn("docker", ["exec", this.name, "timeout", "-k", "5", String(COMMAND_TIMEOUT_S), "bash", "-c", command], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let hostTimedOut = false;
      child.stdout.on("data", (chunk: Buffer) => (stdout = appendTail(stdout, chunk)));
      child.stderr.on("data", (chunk: Buffer) => (stderr = appendTail(stderr, chunk)));
      const timer = setTimeout(() => {
        hostTimedOut = true;
        child.kill("SIGKILL");
      }, HOST_TIMEOUT_MS);
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve(errorResult(`Failed to run docker: ${error.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        // `timeout` exits 124 on SIGTERM and 137 when it has to SIGKILL.
        const timedOut = hostTimedOut || code === 124 || code === 137;
        resolve({ ok: code === 0 && !timedOut, exitCode: code, timedOut, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") });
      });
    });
  }

  /** Runs a shell command in the sandbox. Never throws: failures come back as results. */
  async exec(command: string): Promise<CommandResult> {
    try {
      await this.start();
    } catch (error) {
      return errorResult(`Failed to start sandbox: ${errorMessage(error)}`);
    }
    const result = await this.dockerExec(command);
    if (result.ok || result.timedOut || (await this.isRunning())) return result;
    // The container died: recreate it once and retry.
    this.starting = undefined;
    try {
      await this.start();
    } catch (error) {
      return errorResult(`Sandbox died and could not be recreated: ${errorMessage(error)}`);
    }
    return this.dockerExec(command);
  }

  async dispose() {
    this.starting = undefined;
    active.delete(this.name);
    await execFileAsync("docker", ["rm", "-f", this.name]).catch((error) =>
      console.error(`[sandbox] failed to remove ${this.name}:`, errorMessage(error)),
    );
  }
}
