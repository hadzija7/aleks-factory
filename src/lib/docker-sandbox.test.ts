import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCodingTools } from "./coding-tools";
import { DEFAULT_SANDBOX_IMAGE, DockerSandbox, type CommandResult } from "./docker-sandbox";

const dockerAvailable = (() => {
  try {
    execFileSync("docker", ["image", "inspect", DEFAULT_SANDBOX_IMAGE], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!dockerAvailable)("run_command docker sandbox", { timeout: 120_000 }, () => {
  let base: string;
  let projectRoot: string;
  let outsideFile: string;
  let sandbox: DockerSandbox;
  let run: (command: string) => Promise<CommandResult>;

  beforeAll(async () => {
    base = mkdtempSync(path.join(os.tmpdir(), "sandbox-test-"));
    projectRoot = path.join(base, "project");
    outsideFile = path.join(base, "outside", "keep.txt");
    mkdirSync(path.dirname(outsideFile), { recursive: true });
    writeFileSync(outsideFile, "host data");
    sandbox = new DockerSandbox(`test-${process.pid}`, projectRoot);
    const runCommand = createCodingTools(projectRoot, sandbox).find((tool) => tool.name === "run_command")!;
    run = async (command) => JSON.parse(await runCommand.invoke({ command }));
    await sandbox.start();
  });

  afterAll(async () => {
    await sandbox?.dispose();
    rmSync(base, { recursive: true, force: true });
  });

  it("writes files created in /work to the project root", async () => {
    const result = await run("echo hello > /work/created.txt && pwd");
    expect(result).toMatchObject({ ok: true, exitCode: 0, timedOut: false });
    expect(result.stdout.trim()).toBe("/work");
    expect(readFileSync(path.join(projectRoot, "created.txt"), "utf8")).toBe("hello\n");
  });

  it("has no network access", async () => {
    const result = await run("curl -sS --max-time 5 https://example.com");
    expect(result.ok).toBe(false);
    expect(result.exitCode).not.toBe(0);
  });

  it("recreates the container once if it has died", async () => {
    execFileSync("docker", ["kill", sandbox.name], { stdio: "ignore" });
    expect(await run("echo alive")).toMatchObject({ ok: true, stdout: "alive\n" });
  });

  it("leaves the host untouched after rm -rf /", async () => {
    await run("rm -rf --no-preserve-root / 2>/dev/null");
    expect(readFileSync(outsideFile, "utf8")).toBe("host data");
    expect(existsSync(projectRoot)).toBe(true);
    // The container survives: only /work (the project) was writable by the sandbox user.
    expect(await run("echo still-here")).toMatchObject({ ok: true, stdout: "still-here\n" });
  });
});
