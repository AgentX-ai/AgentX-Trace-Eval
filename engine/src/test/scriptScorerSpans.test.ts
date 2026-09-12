import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nanoid } from "nanoid";
import { openTestDb, type TestDb } from "./dbHarness.js";
import type { Db } from "../storage/db.js";
import { loadScorerSpans } from "../core/monitor/scriptScorer.js";

// Pins the sandbox span contract that let the two-classifier bug survive: the ROOT went
// through the unified classifier while every CHILD went through a stale pre-unification
// ladder that ignored the stated span_kind and emitted the retired word "span" - so one
// spans[] array mixed vocabularies by tree position, and a stated "memory" child was
// unreachable from a code scorer forever.
let test: TestDb;
let db: Db;

beforeAll(async () => {
  test = await openTestDb();
  db = test.scoped(await test.newProject("ScorerSpans"));
}, 60_000);

afterAll(async () => {
  await test?.close();
});

describe("loadScorerSpans classification", () => {
  it("children carry the same vocabulary as the root - stated kinds win, memory included", async () => {
    const sessionId = "scorer-span-sess";
    const rootId = nanoid();
    const insert = async (values: Record<string, unknown>) => {
      if (db.kind === "sqlite") {
        await db.db.insert(db.schema.traces).values(values as never);
      } else {
        await db.db.insert(db.schema.traces).values(values as never);
      }
    };
    await insert({
      id: rootId,
      projectId: db.projectId,
      name: "agent-turn",
      input: "q",
      output: "a",
      sessionId,
      spanId: "root-1",
      createdAt: new Date(),
    });
    await insert({
      id: nanoid(),
      projectId: db.projectId,
      name: "user prefs",
      input: "u-1",
      output: "recalled",
      sessionId,
      spanId: "child-mem",
      parentSpanId: "root-1",
      spanKind: "memory",
      createdAt: new Date(),
    });
    await insert({
      id: nanoid(),
      projectId: db.projectId,
      name: "Memory recall",
      input: "u-1",
      output: "recalled",
      sessionId,
      spanId: "child-mem-name",
      parentSpanId: "root-1",
      createdAt: new Date(),
    });
    await insert({
      id: nanoid(),
      projectId: db.projectId,
      // A stated kind must beat the model-presence inference for children too.
      name: "guard",
      model: "gpt-x",
      sessionId,
      spanId: "child-guard",
      parentSpanId: "root-1",
      spanKind: "guardrail",
      createdAt: new Date(),
    });

    const spans = await loadScorerSpans(db, rootId);
    const byName = Object.fromEntries(spans.map(s => [s.name, s.type]));
    expect(byName["user prefs"]).toBe("memory");
    expect(byName["Memory recall"]).toBe("memory");
    expect(byName["guard"]).toBe("guardrail");
    // The retired vocabulary word never appears.
    expect(spans.some(s => s.type === "span")).toBe(false);
  });
});
