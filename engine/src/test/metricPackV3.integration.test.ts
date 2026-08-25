import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { startEngine, postJson, type TestEngine } from "./server.js";

// Metric pack v3 (the DeepEval-comparison fixes + the agent/session/safety additions):
// - Contextual Precision gains the vacuous-truth rule (zero relevant chunks = 0, not a
//   vacuously perfect ranking) and the auditable-counts line.
// - Answer Relevancy goes orthogonal to Faithfulness (direction, never correctness).
// - Seven new templates: Agent x3, Session x2, Safety x2 (safety under NEW names, so the rows
//   operators deleted from the pre-trim pack are never resurrected).
// - Existing installs get the prompt fixes via PACK_UPGRADES - but ONLY on rows still carrying
//   the byte-exact v2 text; an operator's edited rubric survives untouched.

const engines: TestEngine[] = [];

afterAll(async () => {
  for (const e of engines) await e?.stop();
});

const V3_NEW_NAMES = [
  "Agent: Task Completion",
  "Agent: Tool Correctness",
  "Agent: Step Efficiency",
  "Session: Knowledge Retention",
  "Session: Role Adherence",
  "Safety: Harmful Content",
  "Safety: Bias & Fairness",
];

type ScorerWire = { _id: string; name: string; judge: { judgePrompt?: string }; seeded: boolean };

async function listScorers(engine: TestEngine, apiKey: string): Promise<ScorerWire[]> {
  const res = await engine.json("/api/v1/agent-monitoring/judge-scorers", { apiKey });
  return (res.body as { judgeScorers: ScorerWire[] }).judgeScorers;
}

describe("metric pack v3", () => {
  it("fresh projects seed the fixed prompts and the seven new templates", async () => {
    const engine = await startEngine();
    engines.push(engine);
    const created = await engine.json("/api/v1/projects", { ...postJson({ name: "pack-v3" }), apiKey: null });
    const key = (created.body as { project: { apiKey: string } }).project.apiKey;
    const scorers = await listScorers(engine, key);
    const names = scorers.map(s => s.name);
    for (const name of V3_NEW_NAMES) expect(names).toContain(name);
    const precision = scorers.find(s => s.name === "RAG: Contextual Precision")!;
    expect(precision.judge.judgePrompt).toContain("If NO retrieved chunk is relevant to the query, score 0");
    expect(precision.judge.judgePrompt).toContain("State the counts you used");
    // The trimmed-in-2026-08 safety names must NOT come back under their old identities.
    expect(names).not.toContain("Safety: Toxicity");
    expect(names).not.toContain("Safety: Bias");
  });

  it("upgrades a v2 install's seeded prompts exactly once, preserving operator edits", async () => {
    const first = await startEngine();
    const home = first.home;
    const created = await first.json("/api/v1/projects", { ...postJson({ name: "v2-install" }), apiKey: null });
    const key = (created.body as { project: { apiKey: string } }).project.apiKey;
    await first.signal("SIGTERM");
    expect(await first.waitForExit()).toBe(0);

    // Rewind to a v2 install: version marker back to 2, precision prompt back to the v2 text
    // (byte-exact - the upgrade guard), faithfulness prompt EDITED by the operator.
    const V2_PRECISION = `You are evaluating RETRIEVAL RANKING quality: whether the retrieved chunks that are actually relevant to the query appear BEFORE the irrelevant ones. The chunks below are listed in their retrieved order. IGNORE the response entirely - you are judging the ranking, not the answer.

**User Query:** {input}

**Retrieved Context (in ranked order):**
{context}

For each chunk, decide whether it is relevant to the query, then rate how well the ordering front-loads the relevant chunks: a perfect score means every relevant chunk precedes every irrelevant one.`;
    const db = new Database(path.join(home, "agentx.db"));
    db.prepare("UPDATE app_settings SET metric_pack_version = 2").run();
    db.prepare("UPDATE evaluation_settings SET judge_prompt = ? WHERE name = 'RAG: Contextual Precision'").run(V2_PRECISION);
    db.prepare("UPDATE evaluation_settings SET judge_prompt = 'MY CUSTOM FAITHFULNESS RUBRIC' WHERE name = 'RAG: Faithfulness'").run();
    db.prepare("DELETE FROM evaluation_settings WHERE name LIKE 'Agent: %' OR name LIKE 'Session: %' OR name LIKE 'Safety: %'").run();
    db.close();

    const upgraded = await startEngine({}, { home });
    engines.push(upgraded);
    const scorers = await listScorers(upgraded, key);
    const names = scorers.map(s => s.name);
    // New v3 rows arrive for the old install...
    for (const name of V3_NEW_NAMES) expect(names).toContain(name);
    // ...the untouched v2 prompt is upgraded to carry the vacuous-truth rule...
    const precision = scorers.find(s => s.name === "RAG: Contextual Precision")!;
    expect(precision.judge.judgePrompt).toContain("If NO retrieved chunk is relevant to the query, score 0");
    // ...and the operator's edited rubric is left exactly as they wrote it.
    const faithfulness = scorers.find(s => s.name === "RAG: Faithfulness")!;
    expect(faithfulness.judge.judgePrompt).toBe("MY CUSTOM FAITHFULNESS RUBRIC");
  }, 180_000);
});
