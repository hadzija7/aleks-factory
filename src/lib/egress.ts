import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DATA_DIR, DEFAULT_SANDBOX_IMAGE, execFileAsync } from "./docker";
import { DEFAULT_ALLOWED_DOMAINS } from "./projects";

const NETWORK = "aleks-factory-sandbox";
const PROXY = "aleks-factory-egress";
const PROXY_PORT = 3128;
// Not CONTAINER_LABEL: the proxy is shared by every process and must survive per-process container cleanup.
const PROXY_LABEL = "aleks-factory.egress";
const SCRIPT = path.join(process.cwd(), "docker", "egress-proxy.mjs");
const CONFIG_DIR = path.join(DATA_DIR, "egress");
const CONFIG = path.join(CONFIG_DIR, "allowlist.json");

type Sessions = Record<string, { session: string; domains: string[] }>;

const readSessions = (): Sessions => {
  try {
    return JSON.parse(readFileSync(CONFIG, "utf8"));
  } catch {
    return {};
  }
};

const writeSessions = (sessions: Sessions) => {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG, JSON.stringify(sessions, null, 2));
};

const exists = (...args: string[]) => execFileAsync("docker", args).then(() => true, () => false);

/** Starts (or restarts after a script change) the shared proxy, bridging the internal sandbox network to the internet. */
async function ensureProxy() {
  const hash = createHash("sha256").update(readFileSync(SCRIPT)).digest("hex").slice(0, 12);
  const state = await execFileAsync("docker", ["inspect", "-f", `{{.State.Running}} {{index .Config.Labels "${PROXY_LABEL}"}}`, PROXY]).then(
    (r) => r.stdout.trim(),
    () => "",
  );
  if (state === `true ${hash}`) return;
  await execFileAsync("docker", ["rm", "-f", PROXY]).catch(() => {});
  if (!(await exists("network", "inspect", NETWORK))) await execFileAsync("docker", ["network", "create", "--internal", NETWORK]);
  if (!existsSync(CONFIG)) writeSessions({});
  await execFileAsync("docker", [
    "run", "-d", "--name", PROXY, "--label", `${PROXY_LABEL}=${hash}`, "--restart", "unless-stopped",
    "--network", NETWORK, "-v", `${SCRIPT}:/proxy.mjs:ro`, "-v", `${CONFIG_DIR}:/config:ro`,
    "--memory", "256m", "--cpus", "0.5", DEFAULT_SANDBOX_IMAGE, "node", "/proxy.mjs",
  ]);
  await execFileAsync("docker", ["network", "connect", "bridge", PROXY]);
}

let queue: Promise<unknown> = Promise.resolve();
const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
  const next = queue.then(fn, fn);
  queue = next.catch(() => undefined);
  return next;
};

/**
 * Grants a sandbox session HTTP(S) access to `domains` (plus the defaults) and returns the `docker run` args that put it
 * behind the proxy. Calling it again for the same session keeps its token and just updates the allowlist.
 */
export const openEgress = (session: string, domains: string[]) =>
  serialized(async () => {
    await ensureProxy();
    const sessions = readSessions();
    const token = Object.keys(sessions).find((t) => sessions[t].session === session) ?? randomBytes(16).toString("hex");
    sessions[token] = { session, domains: [...new Set([...DEFAULT_ALLOWED_DOMAINS, ...domains])] };
    writeSessions(sessions);
    const proxyUrl = `http://${token}:x@${PROXY}:${PROXY_PORT}`;
    const env = { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, http_proxy: proxyUrl, https_proxy: proxyUrl, NO_PROXY: "localhost,127.0.0.1", no_proxy: "localhost,127.0.0.1", NODE_USE_ENV_PROXY: "1" };
    return ["--network", NETWORK, ...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`])];
  });

export const closeEgress = (session: string) =>
  serialized(async () => {
    const sessions = readSessions();
    for (const token of Object.keys(sessions)) if (sessions[token].session === session) delete sessions[token];
    writeSessions(sessions);
  });
