import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { extractWebhookUrls, notifyWebhooks } from "./webhooks.js";

// POSTs to an operator-supplied URL on every raised signal. Two properties matter more than the
// payload: it must not block the caller, and a target that never answers must not hold a socket
// open indefinitely - signals arrive as fast as traffic does.

type Received = { path: string; body: string };

let server: http.Server;
let base: string;
const received: Received[] = [];
let openRequests = 0;
let abortedRequests = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", chunk => (body += chunk));
    req.on("end", () => {
      received.push({ path: req.url ?? "", body });
      if (req.url === "/hang") {
        // Never responds. The socket stays open until someone gives up on it.
        openRequests++;
        res.on("close", () => {
          openRequests--;
          abortedRequests++;
        });
        return;
      }
      if (req.url === "/fail") {
        res.writeHead(500).end("nope");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
});

const signal = { summary: "Tool failed", severity: "high", patternKey: "agent-tool-failure", agentId: "a1", rootCause: "lookup" };

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(r => setTimeout(r, 25));
  }
}

describe("extractWebhookUrls", () => {
  it("picks out webhook: entries and strips the prefix", () => {
    expect(extractWebhookUrls(["webhook:https://hooks.example.com/abc"])).toEqual(["https://hooks.example.com/abc"]);
  });

  it("ignores channel entries that aren't webhooks", () => {
    expect(extractWebhookUrls(["email:ops@example.com", "slack", "webhook:https://x.test/y"])).toEqual(["https://x.test/y"]);
  });

  it("handles null/undefined/empty without throwing", () => {
    expect(extractWebhookUrls(null)).toEqual([]);
    expect(extractWebhookUrls(undefined)).toEqual([]);
    expect(extractWebhookUrls([])).toEqual([]);
  });

  it("drops entries with an empty or whitespace-only url", () => {
    expect(extractWebhookUrls(["webhook:", "webhook:   ", "webhook: https://x.test "])).toEqual(["https://x.test"]);
  });

  it("ignores non-string channel entries", () => {
    expect(extractWebhookUrls([null, 42, { url: "x" }, "webhook:https://x.test"] as unknown as string[])).toEqual([
      "https://x.test",
    ]);
  });
});

describe("notifyWebhooks", () => {
  it("returns immediately rather than waiting on delivery", () => {
    const started = Date.now();
    notifyWebhooks([`${base}/hang`], signal);
    expect(Date.now() - started).toBeLessThan(50);
  });

  it("delivers a Slack-compatible body to every target", async () => {
    received.length = 0;
    notifyWebhooks([`${base}/one`, `${base}/two`], signal);
    await waitFor(() => received.filter(r => r.path === "/one" || r.path === "/two").length === 2);

    const delivered = received.filter(r => r.path === "/one" || r.path === "/two");
    expect(delivered.map(r => r.path).sort()).toEqual(["/one", "/two"]);
    const payload = JSON.parse(delivered[0]!.body) as Record<string, unknown>;
    // Slack's incoming-webhook format only requires a top-level `text`.
    expect(payload.text).toBe("[AgentX Monitor] HIGH: Tool failed");
    expect(payload).toMatchObject({ severity: "high", patternKey: "agent-tool-failure", agentId: "a1", rootCause: "lookup" });
  });

  it("still delivers to healthy targets when one fails and one is unroutable", async () => {
    received.length = 0;
    notifyWebhooks([`${base}/fail`, "http://127.0.0.1:1/unreachable", `${base}/healthy`], signal);
    await waitFor(() => received.some(r => r.path === "/healthy"));
    expect(received.map(r => r.path)).toContain("/healthy");
  });

  it("does nothing at all for an empty target list", () => {
    const before = received.length;
    notifyWebhooks([], signal);
    expect(received.length).toBe(before);
  });

  it("gives up on a target that never responds instead of holding the socket open", async () => {
    received.length = 0;
    abortedRequests = 0;
    const hangsBefore = openRequests;
    notifyWebhooks([`${base}/hang`], signal);
    await waitFor(() => received.some(r => r.path === "/hang"));
    expect(openRequests).toBeGreaterThan(hangsBefore);

    // A signal-raising engine can emit these as fast as traffic arrives; without a deadline each
    // one pins a socket for undici's multi-minute default.
    await waitFor(() => abortedRequests > 0, 20_000);
    expect(abortedRequests, "the hung delivery was never aborted").toBeGreaterThan(0);
  }, 30_000);
});
