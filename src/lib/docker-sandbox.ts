import { spawn } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { DEFAULT_SANDBOX_IMAGE, claimContainer, containerLabels, errorMessage, execFileAsync, hostUserArgs, nodeModulesVolume, removeContainer } from "./docker";

export { DEFAULT_SANDBOX_IMAGE } from "./docker";

const COMMAND_TIMEOUT_S = 60;
// Host-side guard in case `docker exec` itself hangs past the in-container timeout.
const HOST_TIMEOUT_MS = (COMMAND_TIMEOUT_S + 15) * 1000;
const OUTPUT_CAP_BYTES = 8 * 1024;

export type CommandResult = { ok: boolean; exitCode: number | null; timedOut: boolean; stdout: string; stderr: string };

const errorResult = (message: string): CommandResult => ({ ok: false, exitCode: null, timedOut: false, stdout: "", stderr: message });

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
    /** Docker volume key holding this checkout's node_modules (installed by the networked setup step). */
    private readonly nodeModulesKey?: string,
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
    // Claim before `run` so a crash mid-start still cleans the container up.
    await claimContainer(this.name);
    await execFileAsync("docker", [
      "run", "-d", "--name", this.name, ...containerLabels(),
      "--network", "none",
      "-v", `${this.projectRoot}:/work`, "-w", "/work", ...hostUserArgs(),
      ...(this.nodeModulesKey ? ["-v", `${nodeModulesVolume(this.nodeModulesKey)}:/work/node_modules`] : []),
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
    await removeContainer(this.name);
  }
}
