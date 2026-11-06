// Egress proxy for agent sandboxes. Sandboxes sit on an internal Docker network whose only way out is this container.
// Each sandbox authenticates with a per-session token (the proxy URL's username); a request is forwarded only if its
// host is on that session's allowlist. HTTPS goes through CONNECT tunnels (port 443 only), plain HTTP is forwarded.
import fs from "node:fs";
import http from "node:http";
import net from "node:net";

const PORT = 3128;
const CONFIG = "/config/allowlist.json";

const sessions = () => {
  try {
    return JSON.parse(fs.readFileSync(CONFIG, "utf8"));
  } catch {
    return {};
  }
};

function domainsFor(req) {
  const match = /^Basic\s+(.+)$/i.exec(req.headers["proxy-authorization"] ?? "");
  if (!match) return undefined;
  const token = Buffer.from(match[1], "base64").toString().split(":")[0];
  return sessions()[token]?.domains;
}

const matches = (host, domain) =>
  domain.startsWith("*.") ? host === domain.slice(2) || host.endsWith(domain.slice(1)) : host === domain;

function check(req, host) {
  const domains = domainsFor(req);
  if (!domains) return "missing or unknown proxy credentials";
  if (!domains.some((d) => matches(host.toLowerCase(), d.toLowerCase()))) return `${host} is not in this project's allowed domains`;
}

const log = (verdict, method, target) => console.log(`${new Date().toISOString()} ${verdict} ${method} ${target}`);

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return res.writeHead(400).end("Expected an absolute URL\n");
  }
  const denied = url.protocol === "http:" ? check(req, url.hostname) : "only http and https are supported";
  log(denied ? "DENY" : "ALLOW", req.method, url.host);
  if (denied) return res.writeHead(403, { "content-type": "text/plain" }).end(`Blocked by sandbox egress policy: ${denied}\n`);

  req.on("error", () => upstream.destroy());
  res.on("error", () => upstream.destroy());
  const headers = { ...req.headers };
  delete headers["proxy-authorization"];
  delete headers["proxy-connection"];
  const upstream = http.request({ host: url.hostname, port: url.port || 80, path: url.pathname + url.search, method: req.method, headers }, (up) => {
    res.writeHead(up.statusCode ?? 502, up.headers);
    up.pipe(res);
  });
  upstream.on("error", (error) => res.headersSent ? res.destroy() : res.writeHead(502).end(`Upstream error: ${error.message}\n`));
  req.pipe(upstream);
});

server.on("connect", (req, socket, head) => {
  // Attach first: clients often reset the socket right after a 403, which would otherwise crash the proxy.
  socket.on("error", () => upstream?.destroy());
  let upstream;
  const [host, port] = (req.url ?? "").split(":");
  const denied = port !== "443" ? "only port 443 can be tunneled" : check(req, host);
  log(denied ? "DENY" : "ALLOW", "CONNECT", req.url);
  if (denied) return socket.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\nBlocked by sandbox egress policy: ${denied}\n`);

  upstream = net.connect(443, host, () => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", () => socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
});

server.on("clientError", (_error, socket) => socket.destroy());
// A single broken connection must never take down every sandbox's network.
process.on("uncaughtException", (error) => console.error("uncaught", error));

server.listen(PORT, () => console.log(`egress proxy listening on ${PORT}`));
