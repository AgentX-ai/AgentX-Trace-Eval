import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEngine, postJson, type TestEngine } from "./server.js";

// The standards-aligned signal lifecycle (GitHub code-scanning dismissals + Sentry regressed):
//   - resolving REQUIRES a reason (fixed | false_positive | wont_fix); status is a validated
//     enum instead of free text
//   - a re-firing signal reopens whether it was archived OR resolved, clearing the reason
//   - a resolved-as-FIXED signal that fires again records a negative ops outcome (free
//     calibration ground truth: the fix claim was wrong)

let engine: TestEngine;
let key: string;

const api = (path: string, init?: Parameters<TestEngine["json"]>[1]) =>
  engine.json(`/api/v1${path}`, { apiKey: key, ...(init ?? {}) });

const patch = (path: string, body: unknown) =>
  api(path, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeAll(async () => {
  engine = await startEngine({ OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", GEMINI_API_KEY: "" });
  const created = await engine.json("/api/v1/projects", { ...postJson({ name: "signal-lifecycle" }), apiKey: null });
  key = (created.body as { project: { apiKey: string } }).project.apiKey;

  const pattern = await api(
    "/monitor/patterns",
    postJson({ name: "Apology loop", detectorKind: "contains", includeTerms: ["sorry, broke"], severity: "high" })
  );
  expect([200, 201]).toContain(pattern.status);
}, 90_000);

afterAll(async () => {
  await engine?.stop();
});

async function fireSignal(spanId: string): Promise<string> {
  const res = await api(
    "/ingest/traces",
    postJson({ name: "sig-agent", input: "hello", output: "sorry, broke again", monitor: true, span_id: spanId })
  );
  expect(res.status).toBe(200);
  await new Promise(r => setTimeout(r, 800));
  const signals = await api("/agent-monitoring/signals?polarity=all");
  const row = ((signals.body as { signals: Array<{ _id: string; summary: string; status: string }> }).signals ?? []).find(
    s => s.summary.toLowerCase().includes("apology")
  );
  expect(row).toBeTruthy();
  return row!._id;
}

describe("resolution requires a reason", () => {
  it("refuses resolved without resolutionReason, and unknown statuses outright", async () => {
    const id = await fireSignal("s-1");
    const bare = await patch(`/agent-monitoring/signals/${id}`, { status: "resolved" });
    expect(bare.status).toBe(400);
    const junk = await patch(`/agent-monitoring/signals/${id}`, { status: "totally-made-up" });
    expect(junk.status).toBe(400);

    const ok = await patch(`/agent-monitoring/signals/${id}`, { status: "resolved", resolutionReason: "fixed" });
    expect(ok.status).toBe(200);
    const wire = ok.body as { status: string; resolutionReason?: string };
    expect(wire.status).toBe("resolved");
    expect(wire.resolutionReason).toBe("fixed");
  });
});

describe("re-fire reopens resolved signals and records the regression", () => {
  it("resolved-as-fixed -> fires again -> reopened, reason cleared, outcome reported", async () => {
    const calBefore = (await api("/agent-monitoring/calibration?window=24h")).body as { reportedCount: number };

    // The signal from the previous test is resolved/fixed; fire the same pattern again.
    await fireSignal("s-2");
    const signals = await api("/agent-monitoring/signals?polarity=all");
    const row = ((signals.body as { signals: Array<{ summary: string; status: string; resolutionReason?: string }> }).signals ?? []).find(
      s => s.summary.toLowerCase().includes("apology")
    );
    expect(row?.status).toBe("reopened");
    expect(row?.resolutionReason).toBeUndefined();

    // The broken fix claim became a negative ops outcome, visible to calibration.
    const calAfter = (await api("/agent-monitoring/calibration?window=24h")).body as { reportedCount: number };
    expect(calAfter.reportedCount).toBe(calBefore.reportedCount + 1);
  });

  it("reason moving through non-resolved statuses stays null", async () => {
    const signals = await api("/agent-monitoring/signals?polarity=all");
    const row = ((signals.body as { signals: Array<{ _id: string; summary: string }> }).signals ?? []).find(s =>
      s.summary.toLowerCase().includes("apology")
    )!;
    const triaged = await patch(`/agent-monitoring/signals/${row._id}`, { status: "triaged" });
    expect((triaged.body as { resolutionReason?: string }).resolutionReason).toBeUndefined();

    const wontFix = await patch(`/agent-monitoring/signals/${row._id}`, {
      status: "resolved",
      resolutionReason: "wont_fix",
    });
    expect((wontFix.body as { resolutionReason?: string }).resolutionReason).toBe("wont_fix");
  });
});
