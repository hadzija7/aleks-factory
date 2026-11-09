import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

type OtlpValue = { stringValue?: string; intValue?: string | number; boolValue?: boolean };
export type OtlpAttribute = { key: string; value: OtlpValue };
export type OtlpSpan = { name: string; parentSpanId?: string; spanId: string; attributes: OtlpAttribute[]; status?: { code?: number } };

export const attrs = (list: OtlpAttribute[]) =>
  Object.fromEntries(list.map(({ key, value }) => [key, value.stringValue ?? (value.intValue !== undefined ? Number(value.intValue) : value.boolValue)]));

export const callIdOf = (span: OtlpSpan) => attrs(span.attributes)["gen_ai.tool.call.id"];

/** A local OTLP/HTTP endpoint standing in for Dash0: `start` points DASH0_* at it, `requests` holds every export. */
export function otlpCollector() {
  const requests: { url?: string; headers: IncomingHttpHeaders; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push({ url: req.url, headers: req.headers, body });
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });

  return {
    requests,
    async start() {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      process.env.DASH0_OTLP_ENDPOINT = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
      process.env.DASH0_AUTH_TOKEN = "test-token";
      process.env.DASH0_DATASET = "test-dataset";
    },
    stop() {
      delete process.env.DASH0_OTLP_ENDPOINT;
      delete process.env.DASH0_AUTH_TOKEN;
      delete process.env.DASH0_DATASET;
      server.close();
    },
    /** Spans of one session (an AgentRun exports once, on `end`), in export order. */
    sessionSpans(index = 0): OtlpSpan[] {
      return JSON.parse(requests[index].body).resourceSpans.flatMap((r: { scopeSpans: { spans: OtlpSpan[] }[] }) => r.scopeSpans.flatMap((s) => s.spans));
    },
  };
}

/**
 * The tree below the session root as `name (call id)` lines indented by depth, siblings sorted by that label (parallel
 * calls have no stable start order), for comparing the trees different paths produce.
 */
export function spanTree(spans: OtlpSpan[]) {
  const lines: string[] = [];
  const label = (span: OtlpSpan) => {
    const id = callIdOf(span);
    return `${span.name}${id ? ` (${id})` : ""}${span.status?.code === 2 ? " [error]" : ""}`;
  };
  const walk = (parentId: string | undefined, depth: number) => {
    const children = spans.filter((s) => s.parentSpanId === parentId).sort((a, b) => label(a).localeCompare(label(b)));
    for (const span of children) {
      lines.push(`${"  ".repeat(depth)}${label(span)}`);
      walk(span.spanId, depth + 1);
    }
  };
  const root = spans.find((s) => !s.parentSpanId);
  if (root) walk(root.spanId, 0);
  return lines;
}
