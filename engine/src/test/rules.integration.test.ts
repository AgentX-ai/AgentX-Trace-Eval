import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEngine, postJson, type TestEngine } from "./server.js";

// Automation rules: filter + sample + action, evaluated on every ingested trace. Rules ROUTE
// traffic; scorers score it. Pinned here - the filter actually narrows (a rule that matches
// nothing stays at zero fires), sampling at 0 never fires, the review action lands a queue item,
// the dataset action appends a case a human still has to finish, an action missing its config is
// refused at create time rather than silently doing nothing, and fire counts are honest.

let engine: TestEngine;
let key: string;

const api = (path: string, init?: Parameters<TestEngine["json"]>[1]) =>
  engine.json(`/api/v1${path}`, { apiKey: key, ...(init ?? {}) });

const put = (body: unknown) => ({
  method: "PUT",
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
});

type Rule = { _id: string; name: string; firedCount: number; enabled: boolean; sampleRate: number };

async function ingest(name: string, spanId: string, extra: Record<string, unknown> = {}) {
  await api("/ingest/traces", postJson({ name, input: "where is my order?", output: "it shipped", span_id: spanId, ...extra }));
}

async function rules(): Promise<Rule[]> {
  return ((await api("/agent-monitoring/rules")).body as { rules: Rule[] }).rules;
}

// The queue is the observable effect of a "review" rule; poll briefly since ingest fires rules
// detached from the response.
async function pendingCount(timeoutMs = 8000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let count = 0;
  while (Date.now() < deadline) {
    count = ((await api("/agent-monitoring/review-queue")).body as { pending: number }).pending;
    if (count > 0) return count;
    await new Promise(r => setTimeout(r, 100));
  }
  return count;
}

beforeAll(async () => {
  engine = await startEngine();
  const created = await engine.json("/api/v1/projects", { ...postJson({ name: "rules" }), apiKey: null });
  key = (created.body as { project: { apiKey: string } }).project.apiKey;
}, 90_000);

afterAll(async () => {
  await engine?.stop();
});

describe("automation rules", () => {
  it("refuses an action whose config is missing, instead of creating a rule that does nothing", async () => {
    const noDataset = await api("/agent-monitoring/rules", postJson({ name: "bad", action: "dataset" }));
    expect(noDataset.status).toBe(400);
    expect((noDataset.body as { error: string }).error).toContain("datasetId");
    const noUrl = await api("/agent-monitoring/rules", postJson({ name: "bad", action: "webhook" }));
    expect(noUrl.status).toBe(400);
    expect((noUrl.body as { error: string }).error).toContain("url");
    // A malformed url is a schema failure, not a stored rule.
    const badUrl = await api(
      "/agent-monitoring/rules",
      postJson({ name: "bad", action: "webhook", actionConfig: { url: "not-a-url" } })
    );
    expect(badUrl.status).toBe(400);
    expect(await rules()).toHaveLength(0);
  });

  it("routes a matching trace into the review queue and counts the fire", async () => {
    const created = await api(
      "/agent-monitoring/rules",
      postJson({ name: "sample support", action: "review", filter: { contains: "order" } })
    );
    expect(created.status).toBe(201);
    await ingest("support-agent", "rule-1");
    expect(await pendingCount()).toBe(1);

    const queue = (await api("/agent-monitoring/review-queue")).body as {
      items: { source: string; note?: string }[];
    };
    expect(queue.items[0]!.source).toBe("rule");
    expect(queue.items[0]!.note).toContain("sample support");
    expect((await rules())[0]!.firedCount).toBe(1);
  });

  it("the filter narrows: a non-matching trace leaves the rule at its previous count", async () => {
    const before = (await rules())[0]!.firedCount;
    // "contains: order" must not match this one.
    await ingest("billing-agent", "rule-2", { input: "reset my password", output: "here is the link" });
    await new Promise(r => setTimeout(r, 600));
    expect((await rules())[0]!.firedCount).toBe(before);
  });

  it("sampling at 0 never fires", async () => {
    const id = (await rules())[0]!._id;
    await api(`/agent-monitoring/rules/${id}`, put({ sampleRate: 0 }));
    const before = (await rules())[0]!.firedCount;
    await ingest("support-agent", "rule-3");
    await new Promise(r => setTimeout(r, 600));
    expect((await rules())[0]!.firedCount).toBe(before);
    // Restore for later cases.
    await api(`/agent-monitoring/rules/${id}`, put({ sampleRate: 1, enabled: false }));
  });

  it("a dataset rule appends a case that still needs a human expected result", async () => {
    const dataset = await api("/custom-agent-evaluations/datasets", postJson({ name: "rule-fed", questions: [] }));
    expect(dataset.status).toBe(201);
    const datasetId = (dataset.body as { _id?: string; id?: string })._id ?? (dataset.body as { id: string }).id;

    await api(
      "/agent-monitoring/rules",
      postJson({ name: "harvest errors", action: "dataset", actionConfig: { datasetId }, filter: { status: "error" } })
    );
    await ingest("billing-agent", "rule-4", { error: "upstream timeout", output: "" });

    const deadline = Date.now() + 8000;
    let questions: unknown[] = [];
    while (Date.now() < deadline) {
      const read = await api(`/custom-agent-evaluations/datasets/${datasetId}`);
      questions = ((read.body as { questions?: unknown[] }).questions ?? []) as unknown[];
      if (questions.length > 0) break;
      await new Promise(r => setTimeout(r, 150));
    }
    expect(questions).toHaveLength(1);
    const main = (questions[0] as { main_question: { query: string; expectedResults?: string } }).main_question;
    expect(main.query).toContain("order");
    // Deliberately unfinished: what the agent said is not automatically the right answer.
    expect(main.expectedResults ?? "").toBe("");
  });

  it("rules are backed up", async () => {
    const manifest = await api("/export");
    const entry = (manifest.body as { entities: { entity: string; rows: number }[] }).entities.find(
      e => e.entity === "rules"
    );
    expect(entry?.rows).toBeGreaterThan(0);
  });
});
