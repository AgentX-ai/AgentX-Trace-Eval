import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEngine, postJson, type TestEngine } from "./server.js";

// P2.2 append-only audit log. The acceptance from DEVELOPMENT_PLAN.md, verbatim: creating and
// deleting a scorer, a sign-in, and an API-key regeneration each produce one row; and the trail
// is immutable because no mutation surface exists (asserted here as PUT/DELETE returning 404).
// Also pinned: the data plane stays OUT of the trail (ingest must not flood it), bulk egress
// (GET /export/*) goes IN, and reads require the operator token.

const ADMIN_TOKEN = "audit-test-operator-token";

type AuditEvent = {
  actor: string;
  actorType: string;
  action: string;
  status: number;
  entityType: string | null;
  entityId: string | null;
  summary: { fields?: string[]; name?: string } | null;
  path: string;
};

let engine: TestEngine;
let key: string;

const audit = async (query = ""): Promise<AuditEvent[]> => {
  const res = await engine.request(`/api/v1/admin/audit${query}`, {
    apiKey: null,
    headers: { "x-admin-token": ADMIN_TOKEN },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { events: AuditEvent[] }).events;
};

beforeAll(async () => {
  engine = await startEngine({ AGENTX_ADMIN_TOKEN: ADMIN_TOKEN });
  key = engine.apiKey;
}, 90_000);

afterAll(async () => {
  await engine?.stop();
});

describe("what lands in the trail", () => {
  it("records scorer create and delete as one row each, with actor and safe summary", async () => {
    const created = await engine.json("/api/v1/agent-monitoring/custom-evaluators", {
      ...postJson({
        name: "Audit probe scorer",
        kind: "code",
        language: "python",
        sampleRate: 1,
        alertBelow: 0.5,
        script: "async def handler(input, output, expected, metadata, trace):\n    return 1.0\n",
      }),
      apiKey: key,
    });
    expect(created.status).toBe(201);
    const scorerId = (created.body as { evaluator: { _id: string } }).evaluator._id;

    const deleted = await engine.json(`/api/v1/agent-monitoring/custom-evaluators/${scorerId}`, {
      method: "DELETE",
      apiKey: key,
    });
    expect([200, 204]).toContain(deleted.status);

    const events = await audit();
    const creates = events.filter(e => e.action === "scorer.create");
    const deletes = events.filter(e => e.action === "scorer.delete");
    expect(creates.length).toBe(1);
    expect(deletes.length).toBe(1);
    expect(deletes[0]!.entityId).toBe(scorerId);
    expect(creates[0]!.actor).toMatch(/^project:/);
    expect(creates[0]!.actorType).toBe("project-key");
    // Field names and the display name are recorded; the script's content must NOT be.
    expect(creates[0]!.summary?.fields).toContain("script");
    expect(creates[0]!.summary?.name).toBe("Audit probe scorer");
    expect(JSON.stringify(creates[0]!.summary)).not.toContain("handler");
  });

  it("records an API-key regeneration", async () => {
    const res = await engine.json("/api/v1/agent-monitoring/settings/api-key/regenerate", {
      method: "POST",
      apiKey: key,
    });
    expect(res.status).toBe(200);
    key = (res.body as { apiKey: string }).apiKey;
    expect(key).toBeTruthy();

    const events = await audit("?action=api-key.regenerate");
    expect(events.length).toBe(1);
    expect(events[0]!.status).toBe(200);
  });

  it("records settings changes and bulk-export reads, but never data-plane ingest", async () => {
    await engine.json("/api/v1/agent-monitoring/settings/monitoring-defaults", {
      method: "PUT",
      ...postJson({ enabledBuiltinPatterns: ["pii-in-response"] }),
      apiKey: key,
      headers: { "content-type": "application/json" },
    });
    for (let i = 0; i < 5; i++) {
      const ingested = await engine.json("/api/v1/ingest/traces", {
        ...postJson({ name: "audit-noise", input: "q", output: "a" }),
        apiKey: key,
      });
      expect(ingested.status).toBe(200);
    }
    await engine.request("/api/v1/export/traces", { apiKey: key });

    const events = await audit();
    expect(events.filter(e => e.action === "settings.update").length).toBeGreaterThanOrEqual(1);
    expect(events.filter(e => e.action === "export.read" && e.entityId === "traces").length).toBe(1);
    expect(events.filter(e => e.path.includes("/ingest/")).length).toBe(0);
  });
});

describe("who can read it, and that nobody can rewrite it", () => {
  it("requires the operator token", async () => {
    expect((await engine.json("/api/v1/admin/audit", { apiKey: null })).status).toBe(401);
    const wrongToken = await engine.request("/api/v1/admin/audit", {
      apiKey: null,
      headers: { "x-admin-token": "wrong" },
    });
    expect(wrongToken.status).toBe(401);
  });

  it("has no mutation surface: PUT and DELETE do not exist", async () => {
    for (const method of ["PUT", "DELETE", "PATCH", "POST"]) {
      const res = await engine.request("/api/v1/admin/audit", {
        method,
        apiKey: null,
        headers: { "x-admin-token": ADMIN_TOKEN },
      });
      expect(res.status).toBe(404);
    }
  });
});

describe("auth events (enabled mode)", () => {
  it("records sign-up and sign-in attempts with the attempted email, and failures too", async () => {
    const authEngine = await startEngine({ AGENTX_AUTH: "enabled", AGENTX_ADMIN_TOKEN: ADMIN_TOKEN });
    try {
      const signUp = await authEngine.request("/api/v1/auth/sign-up/email", {
        ...postJson({ email: "owner@example.com", password: "correct-horse-battery", name: "Owner" }),
        apiKey: null,
      });
      expect(signUp.status).toBeLessThan(300);
      const badSignIn = await authEngine.request("/api/v1/auth/sign-in/email", {
        ...postJson({ email: "owner@example.com", password: "wrong-password" }),
        apiKey: null,
      });
      expect(badSignIn.status).toBeGreaterThanOrEqual(400);

      const res = await authEngine.request("/api/v1/admin/audit", {
        apiKey: null,
        headers: { "x-admin-token": ADMIN_TOKEN },
      });
      const events = ((await res.json()) as { events: AuditEvent[] }).events;
      const signUps = events.filter(e => e.action === "auth.sign-up");
      const signIns = events.filter(e => e.action === "auth.sign-in");
      expect(signUps.length).toBe(1);
      expect(signUps[0]!.actor).toBe("owner@example.com");
      expect(signUps[0]!.actorType).toBe("user");
      expect(signIns.length).toBe(1);
      expect(signIns[0]!.status).toBeGreaterThanOrEqual(400);
      expect(signIns[0]!.actorType).toBe("anonymous");
      // The password must never appear anywhere in the trail.
      expect(JSON.stringify(events)).not.toContain("correct-horse-battery");
      expect(JSON.stringify(events)).not.toContain("wrong-password");
    } finally {
      await authEngine.stop();
    }
  }, 90_000);
});
