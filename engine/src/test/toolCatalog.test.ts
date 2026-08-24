import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nanoid } from "nanoid";
import { openTestDb, type TestDb } from "./dbHarness.js";
import { renderUsedToolDefinitions, renderSessionUsedToolDefinitions } from "../core/trace/trajectory.js";
import { createToolSchema, getRegistryToolsByName } from "../core/evaluate/toolSchemas.js";
import type { Db } from "../storage/db.js";

// The "detailed" tool-context level: definitions for the tools the agent actually USED
// (trace-captured metadata.tools first, registry by name as fallback - used-names-only lookup
// is what keeps the project-wide registry safe), deduped, plus a one-line mention of tools
// advertised to the model but not used.

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
  db = test.scoped(await test.newProject("tool-context"));
}, 60_000);

afterAll(async () => {
  await test?.close();
});

describe("renderUsedToolDefinitions", () => {
  it("defines only USED tools (both provider shapes) and one-lines the unused menu", async () => {
    const rootId = nanoid();
    await insertTrace({
      id: rootId,
      sessionId: "def-sess",
      spanId: "def-root",
      metadata: {
        tools: [
          { type: "function", function: { name: "search_orders", description: "Find orders", parameters: { type: "object" } } },
          { name: "refund_order", description: "Refund an order", input_schema: { type: "object" } },
          { type: "function", function: { name: "escalate_ticket", description: "Escalate to a human" } },
        ],
      },
      // Flat tool-call record: search_orders was used...
      toolCalls: [{ name: "search_orders", success: true }],
    });
    // ...and refund_order ran as a child span named after the tool.
    await insertTrace({
      id: nanoid(),
      sessionId: "def-sess",
      spanId: "def-tool",
      parentSpanId: "def-root",
      name: "refund_order",
    });

    const rendered = await renderUsedToolDefinitions(db, rootId);
    expect(rendered).toContain("Definitions of the tools the agent used");
    // Used tools get full definitions...
    expect(rendered).toMatch(/- search_orders: .*Find orders/);
    expect(rendered).toMatch(/- refund_order: .*input_schema/);
    // ...the unused one is a one-liner, not a schema dump.
    expect(rendered).toContain("NOT used: escalate_ticket (Escalate to a human)");
    expect(rendered).not.toMatch(/- escalate_ticket:/);
    // Deduped: one entry per used tool.
    expect((rendered!.match(/^- search_orders:/gm) ?? []).length).toBe(1);
  });

  it("falls back to the registry BY NAME for used tools without captured definitions", async () => {
    await createToolSchema(db, {
      name: "lookup_invoice",
      description: "Fetches an invoice PDF",
      definition: '{"type":"object","properties":{"invoiceId":{"type":"string"}}}',
    });
    await createToolSchema(db, {
      name: "other_agents_tool",
      description: "Belongs to a different agent",
      definition: '{"type":"object"}',
    });
    const traceId = nanoid();
    await insertTrace({
      id: traceId,
      toolCalls: [{ name: "lookup_invoice", success: true }],
    });

    const rendered = await renderUsedToolDefinitions(db, traceId);
    expect(rendered).toContain("lookup_invoice");
    expect(rendered).toContain("invoiceId");
    expect(rendered).toContain("[from the tool registry]");
    // The used-names-only lookup keeps the project-wide registry from leaking other tools in.
    expect(rendered).not.toContain("other_agents_tool");
  });

  it("returns null for traces with no tool activity and no menu", async () => {
    const plainId = nanoid();
    await insertTrace({ id: plainId });
    expect(await renderUsedToolDefinitions(db, plainId)).toBeNull();
  });
});

describe("renderSessionUsedToolDefinitions", () => {
  it("collects across the whole conversation", async () => {
    await insertTrace({
      id: nanoid(),
      sessionId: "sess-defs",
      spanId: "turn-1",
      metadata: { tools: [{ name: "search_orders", description: "Find orders", input_schema: {} }] },
      toolCalls: [{ name: "search_orders" }],
    });
    const rendered = await renderSessionUsedToolDefinitions(db, "sess-defs");
    expect(rendered).toContain("search_orders");
  });
});

describe("getRegistryToolsByName", () => {
  it("returns only requested names, with current definitions", async () => {
    const found = await getRegistryToolsByName(db, ["lookup_invoice", "never_registered"]);
    expect(found.get("lookup_invoice")?.definition).toContain("invoiceId");
    expect(found.has("never_registered")).toBe(false);
    expect((await getRegistryToolsByName(db, [])).size).toBe(0);
  });
});
