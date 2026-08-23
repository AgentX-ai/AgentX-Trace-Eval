import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nanoid } from "nanoid";
import { openTestDb, type TestDb } from "./dbHarness.js";
import { renderTraceToolCatalog } from "../core/trace/trajectory.js";
import { renderToolCatalog } from "../core/evaluate/toolSchemas.js";
import { createToolSchema } from "../core/evaluate/toolSchemas.js";
import type { Db } from "../storage/db.js";

// The judge's opt-in tool catalog, trace-first: metadata.tools captured by the SDK's LLM
// integrations (the exact menu the model saw) wins; the Tools & MCPs registry is the fallback.
// Pins: provider shape-agnostic name extraction (OpenAI nested vs Anthropic flat), dedupe
// across an agent loop's repeated lists, subtree collection, and the empty cases.

let test: TestDb;
let db: Db;

async function insertTrace(values: Partial<Record<string, unknown>> & { id: string }): Promise<void> {
  const row = {
    name: "catalog-agent",
    input: "q",
    output: "a",
    error: null,
    latencyMs: 1,
    framework: null,
    model: null,
    toolCalls: null,
    metadata: null,
    sessionId: null,
    performanceSummary: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    spanId: null,
    parentSpanId: null,
    startedAt: new Date(),
    createdAt: new Date(),
    agentId: null,
    projectId: db.projectId,
    ...values,
  };
  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.traces).values(row as never);
  } else {
    await db.db.insert(db.schema.traces).values(row as never);
  }
}

beforeAll(async () => {
  test = await openTestDb();
  db = test.scoped(await test.newProject("tool-catalog"));
}, 60_000);

afterAll(async () => {
  await test?.close();
});

describe("renderTraceToolCatalog", () => {
  it("renders trace-captured definitions, both provider shapes, deduped across the subtree", async () => {
    const rootId = nanoid();
    await insertTrace({
      id: rootId,
      sessionId: "cat-sess",
      spanId: "cat-root",
      metadata: {
        tools: [
          { type: "function", function: { name: "search_orders", description: "Find orders" } },
          { name: "refund_order", description: "flat shape", input_schema: { type: "object" } },
        ],
      },
    });
    await insertTrace({
      id: nanoid(),
      sessionId: "cat-sess",
      spanId: "cat-llm",
      parentSpanId: "cat-root",
      model: "gpt-4.1-mini",
      // The agent loop re-sends the same list on every call - it must dedupe to one entry.
      metadata: { tools: [{ type: "function", function: { name: "search_orders", description: "Find orders" } }] },
    });

    const rendered = await renderTraceToolCatalog(db, rootId);
    expect(rendered).toContain("captured from the trace");
    expect(rendered).toContain("search_orders");
    expect(rendered).toContain("refund_order");
    // One catalog ENTRY (the name also appears inside the JSON definition, so count lines).
    expect((rendered!.match(/^- search_orders:/gm) ?? []).length).toBe(1);
  });

  it("returns null for traces without captured definitions", async () => {
    const plainId = nanoid();
    await insertTrace({ id: plainId });
    expect(await renderTraceToolCatalog(db, plainId)).toBeNull();
  });
});

describe("renderToolCatalog (registry fallback)", () => {
  it("renders registered tools and stays null on an empty registry", async () => {
    expect(await renderToolCatalog(db)).toBeNull();
    await createToolSchema(db, {
      name: "lookup_invoice",
      description: "Fetches an invoice PDF",
      definition: '{"type":"object","properties":{"invoiceId":{"type":"string"}}}',
    });
    const rendered = await renderToolCatalog(db);
    expect(rendered).toContain("registered tool catalog");
    expect(rendered).toContain("lookup_invoice");
    expect(rendered).toContain("invoiceId");
  });
});
