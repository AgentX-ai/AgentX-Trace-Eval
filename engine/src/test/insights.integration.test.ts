import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { nanoid } from "nanoid";
import { openTestDb, type TestDb } from "./dbHarness.js";
import type { Db } from "../storage/db.js";
import { getCoverage } from "../core/insights/coverage.js";
import { probe, probeBatch } from "../core/insights/probe.js";
import { caseKeyFor } from "../core/insights/cases.js";
import { createDataset } from "../core/evaluate/datasets.js";
import { SIMILARITY_BANDS } from "../core/evaluate/curation.js";

// Coverage and the probe are pure functions of two tables nobody can populate through a route in
// a test: classifying a trace needs an LLM key, and so does embedding a case. Both are driven
// directly here, with EMBEDDINGS INJECTED rather than computed - deterministic vectors on a unit
// circle, whose cosines are exactly cos(angle difference), so every assertion about a band
// boundary is arithmetic rather than a guess about what an embedding model will do that day.

// The one seam these tests need: probing embeds the QUERY, which is the only vector that cannot
// be pre-seeded into the cache the way case embeddings can. Registered text returns its injected
// vector; anything unregistered returns null, which is precisely what a missing OPENAI_API_KEY
// does - so the degraded lexical path stays exercised rather than mocked away.
const { registered } = vi.hoisted(() => ({ registered: new Map<string, number[]>() }));

vi.mock("../core/evaluate/judge.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../core/evaluate/judge.js")>();
  const one = (text: string): number[] | null => registered.get(text.trim()) ?? null;
  return { ...actual, computeEmbedding: async (text: string) => one(text), computeEmbeddings: async (texts: string[]) => texts.map(one) };
});

let test: TestDb;
let db: Db;

// A unit vector at `angle` radians, padded into a 4-dimensional space so nothing depends on
// dimensionality. cosine(unit(a), unit(b)) === cos(a - b).
const unit = (angle: number): number[] => [Math.cos(angle), Math.sin(angle), 0, 0];

/** Makes `text` embeddable by the mocked embedder above, at the given angle. */
const registerQuery = (text: string, angle: number): void => {
  registered.set(text, unit(angle));
};

// Angles chosen against the real calibration: 0 vs 0.35 rad is cos ~= 0.94 (covered, >= 0.75),
// 0 vs 1.0 rad is cos ~= 0.54 (adjacent, between 0.56 and 0.75 after clamping - see the explicit
// assertions below), 0 vs 1.4 rad is cos ~= 0.17 (nothing in common).
const SAME = 0;
const NEAR = 0.35;
const UNRELATED = 1.4;

async function insertRow(handle: Db, table: unknown, values: Record<string, unknown>): Promise<void> {
  if (handle.kind === "sqlite") {
    await handle.db.insert(table as Parameters<typeof handle.db.insert>[0]).values(values as never);
  } else {
    await handle.db.insert(table as Parameters<typeof handle.db.insert>[0]).values(values as never);
  }
}

async function classify(opts: {
  intent: string;
  /** null writes a row with no embedding - the un-backfilled case. */
  angle: number | null;
  sessionId?: string | null;
  issueType?: string;
  sentiment?: string;
}): Promise<void> {
  const traceId = nanoid();
  await insertRow(db, db.schema.traces, {
    id: traceId,
    name: "insights-agent",
    input: "q",
    output: "a",
    error: null,
    latencyMs: 10,
    framework: null,
    model: null,
    toolCalls: null,
    metadata: null,
    sessionId: opts.sessionId ?? null,
    performanceSummary: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    spanKind: null,
    source: null,
    spanId: null,
    parentSpanId: null,
    startedAt: null,
    createdAt: new Date(),
    agentId: null,
    projectId: db.projectId,
  });
  await insertRow(db, db.schema.monitorClassifications, {
    id: nanoid(),
    traceId,
    agentId: null,
    intent: opts.intent,
    sentiment: opts.sentiment ?? "neutral",
    issueType: opts.issueType ?? "none",
    createdAt: new Date(),
    projectId: db.projectId,
    embedding: opts.angle === null ? null : unit(opts.angle),
  });
}

// Pre-seeds the embedding cache so nothing in these tests calls out to an embeddings API. This is
// exactly the row attachCaseEmbeddings would have written.
async function cacheCaseEmbedding(datasetId: string, query: string, angle: number): Promise<void> {
  await insertRow(db, db.schema.insightCaseEmbeddings, {
    id: nanoid(),
    projectId: db.projectId,
    datasetId,
    caseKey: caseKeyFor(query, `expected for ${query}`),
    query,
    // Two vectors in two spaces. Seeded to the same angle here so the geometry stays readable;
    // what matters is that coverage reads embeddingFull and the probe reads embedding.
    embedding: unit(angle),
    embeddingFull: unit(angle),
    model: "test-injected",
    createdAt: new Date(),
  });
}

async function newDataset(name: string, queries: { query: string; angle: number }[]): Promise<string> {
  const created = (await createDataset(db, {
    name,
    questions: queries.map(q => ({
      main_question: { query: q.query, expectedResults: `expected for ${q.query}` },
      follow_up_questions: [],
    })),
  })) as { _id: string };
  for (const q of queries) {
    await cacheCaseEmbedding(created._id, q.query, q.angle);
  }
  return created._id;
}

beforeAll(async () => {
  test = await openTestDb();
  db = test.scoped(await test.newProject("Insights"));
}, 60_000);

afterAll(async () => {
  await test?.close();
});

describe("the similarity calibration is shared, not copied", () => {
  it("uses the same threshold coverage claims and dedupe rejection are built on", () => {
    // The property the feature is sold on: "covered" means addCaseToDataset would reject the
    // query as a duplicate. If these ever diverge, one of the two is lying to the user.
    expect(SIMILARITY_BANDS.covered).toBe(0.75);
    expect(SIMILARITY_BANDS.related).toBeLessThan(SIMILARITY_BANDS.covered);
  });
});

describe("coverage over production topics", () => {
  let datasetId: string;

  beforeAll(async () => {
    // "password reset": lots of traffic, and a case sitting right on it.
    for (let i = 0; i < 8; i++) {
      await classify({ intent: "password reset", angle: SAME, sessionId: `sess-${i}` });
    }
    // "account closure": real traffic, failing, and nothing near it in any dataset.
    for (let i = 0; i < 4; i++) {
      await classify({ intent: "account closure", angle: UNRELATED, sessionId: `close-${i}`, issueType: "refusal", sentiment: "negative" });
    }
    datasetId = await newDataset("suite", [
      { query: "how do I reset my password", angle: SAME },
      { query: "reset password link expired", angle: NEAR },
    ]);
  });

  it("reports a covered topic and a missing one, and ranks by traffic", async () => {
    const result = await getCoverage(db, { window: "7d", datasetIds: [datasetId] });
    expect(result.insufficientData).toBe(false);
    expect(result.degraded).toBe(false);

    const topics = Object.fromEntries(result.topics.map(t => [t.topic, t]));
    expect(topics["password reset"]!.state).toBe("covered");
    expect(topics["password reset"]!.caseCount).toBe(2);
    // Its target is higher than the two cases it has, and it is still covered: depth, not count,
    // is what the verdict is made of. The target is guidance for what to write next.
    expect(topics["password reset"]!.targetCases).toBeGreaterThan(2);
    expect(topics["account closure"]!.state).toBe("missing");
    expect(topics["account closure"]!.caseCount).toBe(0);
    expect(topics["account closure"]!.coverage).toBe(0);
    // Busiest topic first - the detail panel reads top-down.
    expect(result.topics[0]!.topic).toBe("password reset");
  });

  it("counts unique sessions, not raw request volume", async () => {
    const result = await getCoverage(db, { window: "7d", datasetIds: [datasetId] });
    const reset = result.topics.find(t => t.topic === "password reset")!;
    // 8 traces, 8 distinct session ids. The retry-loop case is the next test.
    expect(reset.traceCount).toBe(8);
    expect(reset.uniqueSessions).toBe(8);
  });

  it("weights risk toward observed issues rather than sentiment alone", async () => {
    const result = await getCoverage(db, { window: "7d", datasetIds: [datasetId] });
    const closure = result.topics.find(t => t.topic === "account closure")!;
    expect(closure.riskComponents.issueRate).toBe(1);
    expect(closure.riskComponents.negativeSentimentRate).toBe(1);
    expect(closure.risk).toBeGreaterThan(0.9);
    // A failing, untested topic must drag the risk-weighted number below the traffic-weighted
    // one. That gap is the headline finding - "you test what is common, not what is dangerous".
    expect(result.riskWeightedCoverage).toBeLessThan(result.trafficWeightedCoverage);
  });

  it("does not let duplicate cases inflate coverage", async () => {
    const before = (await getCoverage(db, { window: "7d", datasetIds: [datasetId] })).topics.find(t => t.topic === "password reset")!;
    const padded = await newDataset(
      "padded",
      // Six near-identical cases, all sitting on the same point as the traffic. A count-based
      // metric would read this as far better covered than the two-case dataset; the
      // facility-location value is already satisfied, so it must not.
      Array.from({ length: 6 }, (_, i) => ({ query: `please reset my password variant ${i}`, angle: SAME }))
    );
    const after = (await getCoverage(db, { window: "7d", datasetIds: [padded] })).topics.find(t => t.topic === "password reset")!;
    expect(after.caseCount).toBe(6);
    // Three times the cases, not one point of extra coverage - the max-similarity term was
    // already satisfied by the first one.
    expect(after.coverage).toBeLessThanOrEqual(before.coverage + 0.001);
  });

  it("scales the target with traffic and risk instead of using a flat number", async () => {
    const result = await getCoverage(db, { window: "7d", datasetIds: [datasetId] });
    const reset = result.topics.find(t => t.topic === "password reset")!;
    const closure = result.topics.find(t => t.topic === "account closure")!;
    expect(reset.targetCases).toBeGreaterThan(2);
    // Lower traffic but far higher risk, so its target is not simply proportional to volume.
    expect(closure.targetCases).toBeGreaterThan(2);
  });

  it("reports an honesty delta between case presence and real depth", async () => {
    const result = await getCoverage(db, { window: "7d", datasetIds: [datasetId] });
    expect(result.presenceCoverage).toBeGreaterThanOrEqual(result.trafficWeightedCoverage);
    expect(result.honestyDelta).toBeCloseTo(result.presenceCoverage - result.trafficWeightedCoverage, 3);
  });

  it("flags cases that match no production topic as off-map", async () => {
    const orphan = await newDataset("orphan", [{ query: "can I pay in martian dollars", angle: 2.6 }]);
    const result = await getCoverage(db, { window: "7d", datasetIds: [orphan] });
    expect(result.offMapCases).toHaveLength(1);
    expect(result.offMapCases[0]!.query).toBe("can I pay in martian dollars");
  });
});

describe("synonymous intent labels", () => {
  it("merges labels the classifier phrased differently, and keeps related-but-distinct ones apart", async () => {
    const db2 = test.scoped(await test.newProject("Merge"));
    const saved = db;
    db = db2;
    try {
      // Same angle = same centroid: the classifier coined two labels for one topic. Measured on
      // real traffic these land at ~0.90, well above the merge threshold.
      for (let i = 0; i < 5; i++) {
        await classify({ intent: "refund request", angle: SAME });
        await classify({ intent: "request a refund", angle: SAME + 0.05 });
      }
      // Related but genuinely different - cos(0.55) ~= 0.85, just under the threshold, which is
      // the case the calibration exists to protect ("order tracking" vs "missing package").
      for (let i = 0; i < 5; i++) {
        await classify({ intent: "dispute a charge", angle: 0.55 });
      }
      const dsId = await newDataset("merge-suite", [{ query: "I want a refund", angle: SAME }]);
      const result = await getCoverage(db, { window: "7d", datasetIds: [dsId] });

      const labels = result.topics.map(t => t.topic);
      expect(labels).toContain("refund request");
      // Merged away, not reported as its own missing topic - the bug this exists to prevent.
      expect(labels).not.toContain("request a refund");
      const refunds = result.topics.find(t => t.topic === "refund request")!;
      expect(refunds.aliases).toContain("request a refund");
      expect(refunds.traceCount).toBe(10);

      // Still its own topic: merging it would hide a genuinely different question.
      expect(labels).toContain("dispute a charge");
    } finally {
      db = saved;
    }
  });
});

describe("degradation and pending work are reported honestly", () => {
  it("does not report an unembedded case as dead test weight", async () => {
    const scoped = test.scoped(await test.newProject("Pending"));
    const saved = db;
    db = scoped;
    try {
      for (let i = 0; i < 4; i++) {
        await classify({ intent: "refund request", angle: SAME });
      }
      // TWO cases, only one with cached vectors. The embedded one puts the run in embedding mode;
      // the other scores -1 against everything. Calling that "off map" would tell a team to delete
      // a perfectly good test on its first load, before the cache had finished warming.
      const created = (await createDataset(db, {
        name: "half-embedded",
        questions: [
          { main_question: { query: "I want a refund", expectedResults: "expected for I want a refund" }, follow_up_questions: [] },
          { main_question: { query: "not yet embedded", expectedResults: "expected for not yet embedded" }, follow_up_questions: [] },
        ],
      })) as { _id: string };
      await cacheCaseEmbedding(created._id, "I want a refund", SAME);

      const result = await getCoverage(db, { window: "7d", datasetIds: [created._id] });
      expect(result.degraded).toBe(false);
      expect(result.caseEmbeddingsPending).toBe(1);
      expect(result.offMapCases.map(c => c.query)).not.toContain("not yet embedded");
    } finally {
      db = saved;
    }
  });

  it("says per topic which measure produced the number", async () => {
    const result = await getCoverage(db, { window: "7d", datasetIds: [await newDataset("basis", [{ query: "how do I reset my password", angle: SAME }])] });
    // The global degraded flag cannot answer this: facilityLocation returns null for a topic whose
    // own traces carry no embeddings even while the run is using them.
    for (const topic of result.topics) {
      expect(["depth", "count"]).toContain(topic.coverageBasis);
    }
  });

  it("returns null risk-weighted coverage when nothing carries risk, not zero", async () => {
    const scoped = test.scoped(await test.newProject("NoRisk"));
    const saved = db;
    db = scoped;
    try {
      // Every topic healthy. 0% here would be indistinguishable from testing nothing at all.
      for (let i = 0; i < 4; i++) {
        await classify({ intent: "happy path", angle: SAME, issueType: "none", sentiment: "positive" });
      }
      const result = await getCoverage(db, { window: "7d", datasetIds: [await newDataset("healthy", [{ query: "all good", angle: SAME }])] });
      expect(result.riskWeightedCoverage).toBeNull();
      expect(result.trafficWeightedCoverage).toBeGreaterThan(0);
    } finally {
      db = saved;
    }
  });
});

describe("provisional results do not read as verdicts", () => {
  it("does not tell you to write a case for a topic whose cases are still indexing", async () => {
    const scoped = test.scoped(await test.newProject("Indexing"));
    const saved = db;
    db = scoped;
    try {
      for (let i = 0; i < 4; i++) {
        await classify({ intent: "refund request", angle: SAME });
      }
      for (let i = 0; i < 4; i++) {
        await classify({ intent: "order tracking", angle: UNRELATED });
      }
      const created = (await createDataset(db, {
        name: "indexing",
        questions: [
          { main_question: { query: "I want a refund", expectedResults: "expected for I want a refund" }, follow_up_questions: [] },
          { main_question: { query: "where is my order", expectedResults: "expected for where is my order" }, follow_up_questions: [] },
        ],
      })) as { _id: string };
      // Only the refund case is indexed. Order tracking therefore has no assigned case yet - but
      // its case exists and is in the queue, so "curate production traces" is wrong advice.
      await cacheCaseEmbedding(created._id, "I want a refund", SAME);

      const result = await getCoverage(db, { window: "7d", datasetIds: [created._id] });
      const tracking = result.topics.find(t => t.topic === "order tracking")!;
      expect(result.caseEmbeddingsPending).toBe(1);
      expect(tracking.suggestedAction).toContain("still being indexed");
      expect(tracking.suggestedAction).not.toContain("Curate the production traces");
    } finally {
      db = saved;
    }
  });

  it("does not report off-map cases when it is only matching labels", async () => {
    const scoped = test.scoped(await test.newProject("LexicalOffMap"));
    const saved = db;
    db = scoped;
    try {
      for (let i = 0; i < 4; i++) {
        await classify({ intent: "refund request", angle: SAME });
      }
      // No cached vectors anywhere, so this runs lexically. Jaccard compares a case's words to a
      // topic LABEL, which most legitimate cases miss - reporting those as dead test weight was
      // producing dozens of false "delete this test" entries on real data.
      await createDataset(db, {
        name: "lexical",
        questions: [
          { main_question: { query: "please issue my money back for order 12345", expectedResults: "issues it" }, follow_up_questions: [] },
        ],
      });
      const result = await getCoverage(db, { window: "7d" });
      expect(result.degraded).toBe(true);
      expect(result.offMapCases).toHaveLength(0);
    } finally {
      db = saved;
    }
  });

  // NOTE: this asserts the tail counts at all, NOT that the unrounded-weight fix works. Rounding
  // to 3dp only zeroes a weight below 0.0005 of traffic, which needs >4000 classified traces to
  // reproduce - too slow to seed here. The fix is reasoned, not covered at realistic scale.
  it("keeps a small traffic tail counting toward the headline number", async () => {
    const scoped = test.scoped(await test.newProject("Tail"));
    const saved = db;
    db = scoped;
    try {
      // One dominant topic plus an uncovered tail.
      for (let i = 0; i < 60; i++) {
        await classify({ intent: "refund request", angle: SAME });
      }
      for (let i = 0; i < 2; i++) {
        await classify({ intent: "vpn issue", angle: UNRELATED });
      }
      const dsId = await newDataset("tail", [{ query: "I want a refund", angle: SAME }]);
      const result = await getCoverage(db, { window: "7d", datasetIds: [dsId] });
      // The uncovered tail must hold the number below a clean 1.
      expect(result.trafficWeightedCoverage).toBeLessThan(1);
      expect(result.trafficWeightedCoverage).toBeGreaterThan(0.9);
    } finally {
      db = saved;
    }
  });
});

describe("telling someone what to do first", () => {
  it("ranks a dangerous rarely-asked gap above a harmless common one", async () => {
    const scoped = test.scoped(await test.newProject("Priority"));
    const saved = db;
    db = scoped;
    try {
      // Proportions taken from a real install: the busiest topic runs ~21% of traffic and the
      // dangerous one ~10%. Common and harmless, untested:
      for (let i = 0; i < 21; i++) {
        await classify({ intent: "general greeting", angle: SAME });
      }
      // Half its traffic, but failing. Sorting by traffic alone buries it - and it is exactly the
      // case the headline traffic-vs-risk gap exists to surface.
      for (let i = 0; i < 10; i++) {
        await classify({ intent: "account closure", angle: UNRELATED, issueType: "refusal", sentiment: "negative" });
      }
      const result = await getCoverage(db, { window: "7d", datasetIds: [await newDataset("empty-ish", [{ query: "unrelated", angle: 2.6 }])] });

      const greeting = result.topics.find(t => t.topic === "general greeting")!;
      const closure = result.topics.find(t => t.topic === "account closure")!;
      expect(greeting.trafficShare).toBeGreaterThan(closure.trafficShare);
      expect(closure.priority).toBeGreaterThan(greeting.priority);
    } finally {
      db = saved;
    }
  });

  it("gives a topic nobody asks about no priority, however dangerous it looks", async () => {
    const scoped = test.scoped(await test.newProject("RareRisk"));
    const saved = db;
    db = scoped;
    try {
      for (let i = 0; i < 200; i++) {
        await classify({ intent: "order tracking", angle: SAME });
      }
      // 2 traces in 202. Failing, untested - and still not where the next hour goes.
      for (let i = 0; i < 2; i++) {
        await classify({ intent: "exotic edge case", angle: UNRELATED, issueType: "refusal", sentiment: "negative" });
      }
      const result = await getCoverage(db, { window: "7d", datasetIds: [await newDataset("none", [{ query: "unrelated", angle: 2.6 }])] });
      const tracking = result.topics.find(t => t.topic === "order tracking")!;
      const exotic = result.topics.find(t => t.topic === "exotic edge case")!;
      expect(tracking.priority).toBeGreaterThan(exotic.priority);
    } finally {
      db = saved;
    }
  });

  it("gives a covered topic no priority, however busy it is", async () => {
    const result = await getCoverage(db, { window: "7d", datasetIds: [await newDataset("covered", [{ query: "how do I reset my password", angle: SAME }])] });
    for (const t of result.topics.filter(t => t.state === "covered")) {
      expect(t.priority).toBeLessThan(0.05);
    }
  });

  it("lists every dataset even while filtered to one, and echoes the filter", async () => {
    const dsId = await newDataset("named-suite", [{ query: "how do I reset my password", angle: SAME }]);
    const other = await newDataset("other-suite", [{ query: "close my account", angle: UNRELATED }]);
    const result = await getCoverage(db, { window: "7d", datasetIds: [dsId] });

    // A project-wide figure silently mixes every dataset, so the filter has to exist - but the
    // list it is drawn from must NOT narrow with it. Returning only the selected dataset left the
    // UI's picker with one option the moment it was used, which is a filter nobody can undo.
    const ids = result.datasets.map(d => d.id);
    expect(ids).toContain(dsId);
    expect(ids).toContain(other);
    const named = result.datasets.find(d => d.id === dsId)!;
    expect(named.name).toBe("named-suite");
    expect(named.caseCount).toBe(1);
    // The scope itself comes back on the response, so a caller can tell what it was answered for.
    expect(result.datasetIds).toEqual([dsId]);
  });
});

describe("label matching does not punish long cases", () => {
  it("assigns a wordy case to a topic whose every label word it contains", async () => {
    const scoped = test.scoped(await test.newProject("Wordy"));
    const saved = db;
    db = scoped;
    try {
      for (let i = 0; i < 4; i++) {
        await classify({ intent: "Order tracking", angle: SAME });
      }
      // No cached vectors, so this runs on the label test. The case carries BOTH label words and
      // a lot else; under Jaccard the union denominator scored that 0.154 - below the floor - so
      // it was dropped as off-map and the topic reported "missing" with cases sitting right there.
      await createDataset(db, {
        name: "wordy",
        questions: [
          {
            main_question: {
              query:
                "Where is my order? It has been five days since the shipping confirmation and tracking has not updated at all.",
              expectedResults: "Looks up the order and explains the tracking status.",
            },
            follow_up_questions: [],
          },
        ],
      });
      const result = await getCoverage(db, { window: "7d" });
      const tracking = result.topics.find(t => t.topic === "Order tracking")!;
      expect(result.degraded).toBe(true);
      expect(tracking.caseCount).toBe(1);
      expect(tracking.state).not.toBe("missing");
    } finally {
      db = saved;
    }
  });

  it("still assigns cases to a topic whose traces predate the embedding column", async () => {
    const scoped = test.scoped(await test.newProject("NoCentroid"));
    const saved = db;
    db = scoped;
    try {
      // One topic embedded, one not. monitor_classifications.embedding is never backfilled, so a
      // mixed install is the normal case after an upgrade - and a topic with no centroid used to
      // match nothing at all, reporting "missing" with its cases sitting right there.
      for (let i = 0; i < 4; i++) {
        await classify({ intent: "password reset", angle: SAME });
        await classify({ intent: "billing dispute", angle: null });
      }
      const created = (await createDataset(db, {
        name: "mixed",
        questions: [
          // expectedResults must match what cacheCaseEmbedding hashes - the cache key covers both
          // the query and the expected text, so an edit to either re-embeds the case.
          { main_question: { query: "how do I reset my password", expectedResults: "expected for how do I reset my password" }, follow_up_questions: [] },
          { main_question: { query: "billing dispute over a duplicate charge", expectedResults: "expected for billing dispute over a duplicate charge" }, follow_up_questions: [] },
        ],
      })) as { _id: string };
      await cacheCaseEmbedding(created._id, "how do I reset my password", SAME);
      await cacheCaseEmbedding(created._id, "billing dispute over a duplicate charge", UNRELATED);

      const result = await getCoverage(db, { window: "7d", datasetIds: [created._id] });
      const billing = result.topics.find(t => t.topic === "billing dispute")!;
      expect(result.degraded).toBe(false);
      expect(billing.caseCount).toBe(1);
      expect(billing.state).not.toBe("missing");
    } finally {
      db = saved;
    }
  });

  it("marks a run provisional while cases are still being embedded", async () => {
    const scoped = test.scoped(await test.newProject("Provisional"));
    const saved = db;
    db = scoped;
    try {
      for (let i = 0; i < 4; i++) {
        await classify({ intent: "refund request", angle: SAME });
      }
      const created = (await createDataset(db, {
        name: "half",
        questions: [
          { main_question: { query: "I want a refund", expectedResults: "expected for I want a refund" }, follow_up_questions: [] },
          { main_question: { query: "not yet embedded", expectedResults: "expected for not yet embedded" }, follow_up_questions: [] },
        ],
      })) as { _id: string };
      await cacheCaseEmbedding(created._id, "I want a refund", SAME);

      const result = await getCoverage(db, { window: "7d", datasetIds: [created._id] });
      // degraded is about WHICH measure ran; provisional is about how much of the dataset it saw.
      // A cold cache on a big dataset reports a near-zero number that is a floor, not a verdict.
      expect(result.degraded).toBe(false);
      expect(result.provisional).toBe(true);
    } finally {
      db = saved;
    }
  });

  it("does not blame a missing key when there are simply no cases", async () => {
    const scoped = test.scoped(await test.newProject("NoCases"));
    const saved = db;
    db = scoped;
    try {
      for (let i = 0; i < 4; i++) {
        await classify({ intent: "refund request", angle: SAME });
      }
      const result = await getCoverage(db, { window: "7d" });
      expect(result.degradedReason).toBe("No dataset cases to measure against yet.");
      expect(result.degradedReason).not.toContain("OPENAI_API_KEY");
    } finally {
      db = saved;
    }
  });
});

describe("the probe", () => {
  let datasetId: string;

  beforeAll(async () => {
    datasetId = await newDataset("probe-suite", [{ query: "how do I reset my password", angle: SAME }]);
    registerQuery("I need to reset my password", NEAR);
    registerQuery("how do I reset my password", SAME);
    registerQuery("close my account", UNRELATED);
    registerQuery("unrelated to anything on file", 2.9);
    registerQuery("something with no bearing on this suite", 2.9);
    // cos(0.75) ~= 0.73: inside the related band, below the covered one. The case that must not
    // be reported as tested.
    registerQuery("my password reset link expired, what now", 0.75);
  });

  it("calls a paraphrase covered, and names the case it matched", async () => {
    const result = await probe(db, { query: "I need to reset my password", datasetIds: [datasetId], window: "7d" });
    expect(result.verdict).toBe("covered");
    expect(result.similarity).toBeGreaterThanOrEqual(SIMILARITY_BANDS.covered);
    expect(result.nearestCases[0]!.query).toBe("how do I reset my password");
    // Never a bare score: the expected answer comes back so a human can see whether the case
    // actually asserts what they meant.
    expect(result.nearestCases[0]!.expectedResults).toContain("expected for");
  });

  it("distinguishes a real gap from a question nobody asks", async () => {
    // Both are uncovered. Only one is a gap - and conflating them is what would send a team
    // writing tests for traffic that does not exist.
    const real = await probe(db, { query: "close my account", datasetIds: [datasetId], window: "7d" });
    expect(real.verdict).toBe("gap");
    expect(real.topic!.topic).toBe("account closure");
    expect(real.explanation).toContain("real gap");

    const hypothetical = await probe(db, { query: "unrelated to anything on file", datasetIds: [datasetId], window: "7d" });
    expect(hypothetical.verdict).toBe("untested-and-unasked");
    expect(hypothetical.topic).toBeNull();
    expect(hypothetical.explanation).toContain("not a gap");
  });

  it("refuses to call a related-but-distinct question covered", async () => {
    const result = await probe(db, { query: "my password reset link expired, what now", datasetIds: [datasetId], window: "7d" });
    expect(result.verdict).toBe("adjacent");
    expect(result.similarity).toBeGreaterThanOrEqual(SIMILARITY_BANDS.related);
    expect(result.similarity).toBeLessThan(SIMILARITY_BANDS.covered);
    // The wording has to say the existing case will not catch this, or a reader sees a high-ish
    // number next to a familiar case and assumes they are covered.
    expect(result.explanation).toContain("not this");
  });

  it("degrades to lexical matching, and says so, when the query cannot be embedded", async () => {
    // Never registered, so the mocked embedder returns null exactly as a missing OPENAI_API_KEY
    // would. The verdict still comes back - on a different, clearly-labelled scale.
    const result = await probe(db, { query: "reset password", datasetIds: [datasetId], window: "7d" });
    expect(result.degraded).toBe(true);
    expect(result.bands.covered).toBeLessThan(SIMILARITY_BANDS.covered);
    expect(result.nearestCases.length).toBeGreaterThan(0);
  });

  it("will not call a single stray classification a real gap", async () => {
    const scoped = test.scoped(await test.newProject("Stray"));
    const saved = db;
    db = scoped;
    try {
      // ONE classification. Below the floor the coverage sweep applies, so it is not a topic - and
      // treating it as one would fabricate a gap out of a single trace.
      await classify({ intent: "one-off question", angle: UNRELATED });
      registerQuery("something nobody really asks", UNRELATED);
      const dsId = await newDataset("stray-suite", [{ query: "unrelated case", angle: SAME }]);
      const result = await probe(db, { query: "something nobody really asks", datasetIds: [dsId], window: "7d" });
      expect(result.verdict).toBe("untested-and-unasked");
      expect(result.topic).toBeNull();
    } finally {
      db = saved;
    }
  });

  it("returns the bands it judged with, so a raw score is never shown alone", async () => {
    const result = await probe(db, { query: "how do I reset my password", datasetIds: [datasetId], window: "7d" });
    expect(result.bands).toEqual({ covered: SIMILARITY_BANDS.covered, related: SIMILARITY_BANDS.related });
  });

  it("rolls a batch up into a pre-launch verdict", async () => {
    const result = await probeBatch(db, {
      queries: ["how do I reset my password", "close my account", "  ", "something with no bearing on this suite"],
      datasetIds: [datasetId],
      window: "7d",
    });
    // The blank line is dropped rather than probed.
    expect(result.rollup.total).toBe(3);
    expect(result.rollup.covered).toBe(1);
    expect(result.rollup.gap).toBe(1);
    expect(result.rollup.untestedAndUnasked).toBe(1);
  });
});
