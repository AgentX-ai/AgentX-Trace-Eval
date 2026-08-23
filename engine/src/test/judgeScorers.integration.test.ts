import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import path from "node:path";
import { startEngine, postJson, type TestEngine } from "./server.js";

// The LLM Judge Scorer unification: one entity = judge rubric (evaluation_settings) + optional
// online profile (monitor_online_evaluators), strict 1:1, served by /agent-monitoring/
// judge-scorers while every legacy route stays wire-compatible. These tests pin the contract:
// atomic create, sparse PUT, profile upsert/detach, builtin guard, dataset-twin exclusion,
// legacy auto-clone, id stability, the startup cardinality migration, and the camelCase ingest
// aliases that ride in the same change.

let engine: TestEngine;
let key: string;

const api = (path_: string, init?: Parameters<TestEngine["json"]>[1]) =>
  engine.json(`/api/v1${path_}`, { apiKey: key, ...(init ?? {}) });

beforeAll(async () => {
  engine = await startEngine();
  const created = await engine.json("/api/v1/projects", { ...postJson({ name: "judge-scorers" }), apiKey: null });
  key = (created.body as { project: { apiKey: string } }).project.apiKey;
}, 90_000);

afterAll(async () => {
  await engine?.stop();
});

type Wire = {
  _id: string;
  name: string;
  judge: Record<string, unknown>;
  offline: Record<string, unknown>;
  online: null | Record<string, unknown>;
};

describe("unified CRUD", () => {
  it("creates rubric + online profile atomically and lists them joined", async () => {
    const created = await api("/agent-monitoring/judge-scorers", postJson({
      name: "Support quality",
      judge: { acceptanceCriteria: "Concrete and correct.", judgeModel: "gpt-4.1-mini" },
      offline: { numberOfRequests: 2, jaccardSimilarity: { enabled: true } },
      online: { enabled: true, sampleRate: 0.5, alertThreshold: 6, severity: "high" },
    }));
    expect(created.status).toBe(201);
    const scorer = (created.body as { judgeScorer: Wire }).judgeScorer;
    expect(scorer.judge.acceptanceCriteria).toBe("Concrete and correct.");
    expect(scorer.offline.numberOfRequests).toBe(2);
    expect(scorer.online).not.toBeNull();
    expect(scorer.online!.sampleRate).toBe(0.5);

    // Both halves visible through the LEGACY surfaces, names in sync.
    const legacyEvaluators = await api("/agent-monitoring/online-evaluators");
    const bound = (legacyEvaluators.body as { evaluators: { _id: string; name: string; evaluationSettingsId?: string }[] }).evaluators
      .find(e => e.evaluationSettingsId === scorer._id);
    expect(bound).toBeDefined();
    expect(bound!.name).toBe("Support quality");
    expect(bound!._id).toBe(scorer.online!.profileId);

    const legacyConfigs = await api("/evaluate/evaluationSettings?kind=config");
    expect(JSON.stringify(legacyConfigs.body)).toContain(scorer._id);
  });

  it("creates offline-only scorers (online: null) and lets a later PUT take them live", async () => {
    const created = await api("/agent-monitoring/judge-scorers", postJson({
      name: "Offline rubric",
      judge: { acceptanceCriteria: "Cites the policy." },
    }));
    const scorer = (created.body as { judgeScorer: Wire }).judgeScorer;
    expect(scorer.online).toBeNull();

    const wentLive = await api(`/agent-monitoring/judge-scorers/${scorer._id}`, {
      ...postJson({ online: { enabled: true, sampleRate: 0.2 } }),
      method: "PUT",
    });
    expect(wentLive.status).toBe(200);
    const live = (wentLive.body as { judgeScorer: Wire }).judgeScorer;
    expect(live.online).not.toBeNull();
    expect(live.online!.sampleRate).toBe(0.2);
    // The rubric survived the profile upsert untouched (the sparse-PUT trap).
    expect(live.judge.acceptanceCriteria).toBe("Cites the policy.");
  });

  it("PUT is sparse per section: an enabled toggle never nulls the rubric, and profileId is stable", async () => {
    const created = await api("/agent-monitoring/judge-scorers", postJson({
      name: "Sparse probe",
      judge: { acceptanceCriteria: "A", rejectionCriteria: "B", judgePrompt: "Rate {input} vs {output}" },
      online: { enabled: true },
    }));
    const scorer = (created.body as { judgeScorer: Wire }).judgeScorer;
    const profileId = scorer.online!.profileId;

    const toggled = await api(`/agent-monitoring/judge-scorers/${scorer._id}`, {
      ...postJson({ online: { enabled: false } }),
      method: "PUT",
    });
    const after = (toggled.body as { judgeScorer: Wire }).judgeScorer;
    expect(after.online!.enabled).toBe(false);
    expect(after.online!.profileId).toBe(profileId); // `online-eval:<id>` history stays valid
    expect(after.judge.acceptanceCriteria).toBe("A");
    expect(after.judge.judgePrompt).toBe("Rate {input} vs {output}");

    // Rubric edit leaves the online profile alone - and the id still never moves.
    const retuned = await api(`/agent-monitoring/judge-scorers/${scorer._id}`, {
      ...postJson({ judge: { acceptanceCriteria: "A2" } }),
      method: "PUT",
    });
    const after2 = (retuned.body as { judgeScorer: Wire }).judgeScorer;
    expect(after2.judge.acceptanceCriteria).toBe("A2");
    expect(after2.judge.rejectionCriteria).toBe("B");
    expect(after2.online!.enabled).toBe(false);
    expect(after2.online!.profileId).toBe(profileId);
  });

  it("online: null detaches the profile; DELETE removes rubric, versions, and profile", async () => {
    const created = await api("/agent-monitoring/judge-scorers", postJson({
      name: "Detachable", judge: { acceptanceCriteria: "X" }, online: { enabled: true },
    }));
    const scorer = (created.body as { judgeScorer: Wire }).judgeScorer;

    const detached = await api(`/agent-monitoring/judge-scorers/${scorer._id}`, {
      ...postJson({ online: null }),
      method: "PUT",
    });
    expect((detached.body as { judgeScorer: Wire }).judgeScorer.online).toBeNull();

    const deleted = await api(`/agent-monitoring/judge-scorers/${scorer._id}`, { method: "DELETE" });
    expect(deleted.status).toBe(204);
    expect((await api(`/agent-monitoring/judge-scorers/${scorer._id}`)).status).toBe(404);
    const legacyConfigs = await api("/evaluate/evaluationSettings?kind=config");
    expect(JSON.stringify(legacyConfigs.body)).not.toContain(scorer._id);
  });
});

describe("opt-in tool catalog", () => {
  it("round-trips judge.includeToolCatalog and survives sparse updates", async () => {
    const created = await api("/agent-monitoring/judge-scorers", postJson({
      name: "Catalog judge",
      judge: { acceptanceCriteria: "Uses the right tool.", includeToolCatalog: true },
      online: { enabled: true },
    }));
    expect(created.status).toBe(201);
    const scorer = (created.body as { judgeScorer: Wire }).judgeScorer;
    expect(scorer.judge.includeToolCatalog).toBe(true);

    // Sparse online toggle must not clear the flag (the patch-vs-replace trap).
    const toggled = await api(`/agent-monitoring/judge-scorers/${scorer._id}`, {
      ...postJson({ online: { enabled: false } }),
      method: "PUT",
    });
    expect((toggled.body as { judgeScorer: Wire }).judgeScorer.judge.includeToolCatalog).toBe(true);

    // Off by default for everything else, and visible on the legacy settings wire too.
    const legacy = await api(`/evaluate/evaluationSettings/${scorer._id}`);
    expect(JSON.stringify(legacy.body)).toContain('"includeToolCatalog":true');

    const plain = await api("/agent-monitoring/judge-scorers", postJson({ name: "No catalog" }));
    expect((plain.body as { judgeScorer: Wire }).judgeScorer.judge.includeToolCatalog).toBe(false);
  });
});

describe("strict 1:1 and the legacy auto-clone", () => {
  it("legacy create binding an already-bound config gets a CLONE, not a shared rubric", async () => {
    const created = await api("/agent-monitoring/judge-scorers", postJson({
      name: "Shared once", judge: { acceptanceCriteria: "Shared rubric" }, online: { enabled: true },
    }));
    const scorer = (created.body as { judgeScorer: Wire }).judgeScorer;

    const legacy = await api("/agent-monitoring/online-evaluators", postJson({
      name: "Second binding", evaluationSettingsId: scorer._id, sampleRate: 0.3,
    }));
    expect(legacy.status).toBe(201);
    const evaluator = (legacy.body as { evaluator: { _id: string; evaluationSettingsId: string } }).evaluator;
    expect(evaluator.evaluationSettingsId).not.toBe(scorer._id); // its own copy
    // The clone carries the rubric and is itself a full judge scorer on the unified surface.
    const clone = await api(`/agent-monitoring/judge-scorers/${evaluator.evaluationSettingsId}`);
    expect(clone.status).toBe(200);
    expect((clone.body as { judgeScorer: Wire }).judgeScorer.judge.acceptanceCriteria).toBe("Shared rubric");
  });
});

describe("builtin Session Baseline Judge", () => {
  const baseline = async (): Promise<Wire> => {
    const list = await api("/agent-monitoring/judge-scorers");
    const rows = (list.body as { judgeScorers: Wire[] }).judgeScorers;
    const found = rows.find(r => r.online?.builtinKey === "session-baseline");
    expect(found).toBeDefined();
    return found!;
  };

  it("appears on the unified surface with its builtin marker", async () => {
    const scorer = await baseline();
    expect(scorer.online!.scope).toBe("session");
  });

  it("allows enabled toggles and rubric edits, refuses everything else with 409", async () => {
    const scorer = await baseline();
    const toggle = await api(`/agent-monitoring/judge-scorers/${scorer._id}`, {
      ...postJson({ online: { enabled: true } }),
      method: "PUT",
    });
    expect(toggle.status).toBe(200);

    const tune = await api(`/agent-monitoring/judge-scorers/${scorer._id}`, {
      ...postJson({ judge: { evaluationCriteria: "Weigh context retention heavily." } }),
      method: "PUT",
    });
    expect(tune.status).toBe(200);

    for (const forbidden of [
      { name: "Renamed baseline" },
      { online: null },
      { online: { sampleRate: 0.01 } },
      { offline: { numberOfRequests: 3 } },
    ]) {
      const res = await api(`/agent-monitoring/judge-scorers/${scorer._id}`, {
        ...postJson(forbidden),
        method: "PUT",
      });
      expect(res.status).toBe(409);
    }
    expect((await api(`/agent-monitoring/judge-scorers/${scorer._id}`, { method: "DELETE" })).status).toBe(409);
  });
});

describe("dataset twins stay out", () => {
  it("404s a dashboard-created dataset twin and keeps it off the list", async () => {
    const twin = await api("/evaluate/evaluationSettings/create", postJson({
      name: "Twin dataset", questions: [{ main_question: { query: "q1", expectedResults: "a1" } }],
    }));
    expect([200, 201]).toContain(twin.status);
    const twinId = ((twin.body as { evaluationSettings?: { _id: string }; _id?: string }).evaluationSettings?._id
      ?? (twin.body as { _id?: string })._id) as string;
    expect(twinId).toBeTruthy();

    expect((await api(`/agent-monitoring/judge-scorers/${twinId}`)).status).toBe(404);
    const list = await api("/agent-monitoring/judge-scorers");
    expect((list.body as { judgeScorers: Wire[] }).judgeScorers.some(r => r._id === twinId)).toBe(false);
  });
});

describe("camelCase ingest aliases (wire-casing unification)", () => {
  it("accepts camelCase twins of the legacy snake_case keys and answers with traceId", async () => {
    const res = await api("/ingest/traces", postJson({
      name: "camel-agent",
      input: "q",
      output: "a",
      sessionId: "camel-session",
      spanId: "camel-span-1",
      latencyMs: 42,
    }));
    expect(res.status).toBe(200);
    const body = res.body as { trace_id: string; traceId: string };
    expect(body.traceId).toBeTruthy();
    expect(body.traceId).toBe(body.trace_id);

    const detail = await api(`/ingest/traces/${body.traceId}`);
    const trace = detail.body as { sessionId?: string; latencyMs?: number; spanId?: string };
    expect(trace.sessionId).toBe("camel-session");
    expect(trace.latencyMs).toBe(42);
    expect(trace.spanId).toBe("camel-span-1");
  });
});

describe("export captures the rubric", () => {
  it("lists evaluation-settings in the export manifest and streams rows", async () => {
    const manifest = await api("/export");
    const entities = (manifest.body as { entities: { entity: string; rows: number }[] }).entities;
    const settingsEntity = entities.find(e => e.entity === "evaluation-settings");
    expect(settingsEntity).toBeDefined();
    expect(settingsEntity!.rows).toBeGreaterThan(0); // seeds + this suite's scorers
  });
});

describe("startup cardinality migration", () => {
  it("clones configs for N:1 and twin-bound evaluators, preserving evaluator ids", async () => {
    // Seed the PRE-unification shape directly in a second engine's database: the live API can
    // no longer produce it (auto-clone), which is exactly why the migration needs raw rows.
    const second = await startEngine();
    const home = second.home;
    await second.stop({ keepHome: true });

    const sqlite = new Database(path.join(home, "agentx.db"));
    const now = Date.now();
    sqlite.prepare(
      `INSERT INTO evaluation_settings (id, name, acceptance_criteria, is_default, status, created_at, project_id)
       VALUES ('shared-settings', 'Shared rubric', 'be right', 0, 'published', ?, NULL)`
    ).run(now);
    sqlite.prepare(
      `INSERT INTO datasets (id, name, questions, created_at, project_id)
       VALUES ('twin-ds', 'Twin', '[]', ?, NULL)`
    ).run(now);
    sqlite.prepare(
      `INSERT INTO evaluation_settings (id, name, is_default, status, created_at, project_id)
       VALUES ('twin-ds', 'Twin', 0, 'published', ?, NULL)`
    ).run(now);
    const insertEvaluator = sqlite.prepare(
      `INSERT INTO monitor_online_evaluators
         (id, name, evaluation_settings_id, sample_rate, scope_mode, enabled, alert_threshold, severity, scope, idle_seconds, created_at, project_id)
       VALUES (?, ?, ?, 0.1, 'all', 1, 5, 'medium', 'trace', 120, ?, NULL)`
    );
    insertEvaluator.run("eval-a", "First", "shared-settings", now);
    insertEvaluator.run("eval-b", "Second", "shared-settings", now + 1);
    insertEvaluator.run("eval-twin", "TwinBound", "twin-ds", now + 2);
    sqlite.close();

    // Reboot on the same home: the migration runs at startup.
    const rebooted = await startEngine({}, { home });
    try {
      const check = new Database(path.join(home, "agentx.db"), { readonly: true });
      const evaluators = check.prepare(
        `SELECT id, evaluation_settings_id FROM monitor_online_evaluators WHERE id IN ('eval-a','eval-b','eval-twin') ORDER BY id`
      ).all() as { id: string; evaluation_settings_id: string }[];
      check.close();

      expect(evaluators.map(e => e.id)).toEqual(["eval-a", "eval-b", "eval-twin"]); // ids untouched
      const [a, b, twinBound] = evaluators;
      expect(a!.evaluation_settings_id).toBe("shared-settings"); // oldest keeps the original
      expect(b!.evaluation_settings_id).not.toBe("shared-settings"); // newer got a clone
      expect(twinBound!.evaluation_settings_id).not.toBe("twin-ds"); // unbound from the twin

      // The clone carries the rubric, visible over the API.
      const cloned = await rebooted.json(`/api/v1/agent-monitoring/judge-scorers/${b!.evaluation_settings_id}`);
      expect(cloned.status).toBe(200);
      expect(JSON.stringify(cloned.body)).toContain("be right");

      // Idempotency: a second boot changes nothing further.
      const bindingsBefore = JSON.stringify(evaluators);
      await rebooted.stop({ keepHome: true });
      const third = await startEngine({}, { home });
      const check2 = new Database(path.join(home, "agentx.db"), { readonly: true });
      const evaluators2 = check2.prepare(
        `SELECT id, evaluation_settings_id FROM monitor_online_evaluators WHERE id IN ('eval-a','eval-b','eval-twin') ORDER BY id`
      ).all();
      check2.close();
      expect(JSON.stringify(evaluators2)).toBe(bindingsBefore);
      await third.stop();
    } finally {
      // rebooted may already be stopped by the idempotency leg; stop() is safe to re-call.
      await rebooted.stop().catch(() => undefined);
    }
  }, 120_000);
});
