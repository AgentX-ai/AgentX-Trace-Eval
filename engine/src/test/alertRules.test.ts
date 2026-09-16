import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openTestDb, type TestDb } from "./dbHarness.js";
import type { Db } from "../storage/db.js";

// Unit coverage for the parts of alert rules the integration flow can't pin cheaply: the
// breach predicate's null semantics, value formatting per metric, the bounded event history,
// the masked-key round trip on update, and definition changes resetting firing state. Channel
// delivery is stubbed - what fires is asserted, where it goes is the integration test's job.

vi.mock("../core/monitor/alertChannels.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../core/monitor/alertChannels.js")>();
  return {
    ...actual,
    deliverAlert: vi.fn(async (channel: { kind: string; target: string }) => ({ kind: channel.kind, target: "stub", ok: true })),
  };
});

let test: TestDb;
let db: Db;

beforeAll(async () => {
  test = await openTestDb();
  db = test.scoped(await test.newProject("alert-unit"));
});

afterAll(async () => {
  await test?.close();
});

describe("breaches", () => {
  it("never breaches on no data, and compares strictly", async () => {
    const { breaches } = await import("../core/monitor/alertRules.js");
    expect(breaches("gt", null, 0.5)).toBe(false);
    expect(breaches("lt", null, 10)).toBe(false);
    expect(breaches("gt", 0.5, 0.5)).toBe(false);
    expect(breaches("gt", 0.51, 0.5)).toBe(true);
    expect(breaches("lt", 9, 10)).toBe(true);
    expect(breaches("lt", 10, 10)).toBe(false);
  });
});

describe("thresholdProblem", () => {
  it("refuses fractional counts and rates above 1, accepts everything else", async () => {
    const { thresholdProblem } = await import("../core/monitor/alertRules.js");
    expect(thresholdProblem("judgeFailures", 2.5)).toMatch(/whole number/);
    expect(thresholdProblem("traceCount", 0)).toBeNull();
    expect(thresholdProblem("failureRate", 1.5)).toMatch(/between 0 and 1/);
    expect(thresholdProblem("toolFailureRate", 1)).toBeNull();
    expect(thresholdProblem("p95LatencyMs", 2000.5)).toBeNull();
    expect(thresholdProblem("estimatedCostUsd", -1)).toMatch(/non-negative/);
  });
});

describe("formatMetricValue", () => {
  it("renders each metric in its own unit", async () => {
    const { formatMetricValue, formatWindow } = await import("../core/monitor/alertRules.js");
    expect(formatMetricValue("failureRate", 0.1234)).toBe("12.3%");
    expect(formatMetricValue("p95LatencyMs", 1234.6)).toBe("1235 ms");
    expect(formatMetricValue("estimatedCostUsd", 0.0421)).toBe("$0.0421");
    expect(formatMetricValue("estimatedCostUsd", 12.5)).toBe("$12.50");
    expect(formatMetricValue("judgeFailures", 3)).toBe("3");
    expect(formatMetricValue("traceCount", null)).toBe("no data");
    expect(formatWindow(5)).toBe("5m");
    expect(formatWindow(120)).toBe("2h");
    expect(formatWindow(2880)).toBe("2d");
  });
});

describe("alert rule storage", () => {
  it("keeps a bounded notification history per rule", async () => {
    const { createAlertRule, listAlertEvents, sendAlertRuleTest } = await import("../core/monitor/alertRules.js");
    const rule = await createAlertRule(db, {
      name: "history cap",
      metric: "traceCount",
      operator: "lt",
      threshold: 1,
      windowMinutes: 5,
      channels: [{ kind: "webhook", target: "https://example.com/hook" }],
    });
    for (let i = 0; i < 230; i++) {
      await sendAlertRuleTest(db, rule._id);
    }
    const events = await listAlertEvents(db, rule._id, 500);
    expect(events).toHaveLength(200);
    expect(events.every(e => e.kind === "test")).toBe(true);
  }, 30_000);

  it("keeps the stored PagerDuty key when an update echoes the mask, and resets state on a definition change", async () => {
    const { createAlertRule, updateAlertRule, getAlertRule } = await import("../core/monitor/alertRules.js");
    const routingKey = "R0123456789abcdef0123456789abcdef";
    const rule = await createAlertRule(db, {
      name: "pd",
      metric: "p95LatencyMs",
      operator: "gt",
      threshold: 1000,
      windowMinutes: 15,
      channels: [{ kind: "pagerduty", target: routingKey }],
    });
    const masked = rule.channels[0]!.target;
    expect(masked).not.toBe(routingKey);

    // Echo the masked read-back: the stored key must survive, and the mask must never be stored.
    const echoed = await updateAlertRule(db, rule._id, { channels: [{ kind: "pagerduty", target: masked }] });
    expect(echoed!.channels[0]!.target).toBe(masked);
    // A fresh key replaces it.
    const rotated = await updateAlertRule(db, rule._id, { channels: [{ kind: "pagerduty", target: "R_new_key_0123456789abcdef" }] });
    expect(rotated!.channels[0]!.target).not.toBe(masked);

    // Simulate a firing rule, then re-threshold it: firing state resets so a resolve is never
    // owed for a threshold that no longer exists.
    const cond = (await import("drizzle-orm")).eq(db.schema.alertRules.id, rule._id);
    if (db.kind === "sqlite") {
      await db.db.update(db.schema.alertRules).set({ state: "firing", lastValue: 5000 }).where(cond);
    } else {
      await db.db.update(db.schema.alertRules).set({ state: "firing", lastValue: 5000 }).where(cond);
    }
    expect((await getAlertRule(db, rule._id))!.state).toBe("firing");
    const renamed = await updateAlertRule(db, rule._id, { name: "pd renamed" });
    expect(renamed!.state).toBe("firing");
    const rethresholded = await updateAlertRule(db, rule._id, { threshold: 9000 });
    expect(rethresholded!.state).toBe("ok");
    expect(rethresholded!.lastValue).toBeNull();
  });

  it("resolves a firing rule's incident when it is re-thresholded, paused, or deleted", async () => {
    const { createAlertRule, updateAlertRule, deleteAlertRule, listAlertEvents } = await import("../core/monitor/alertRules.js");
    const { deliverAlert } = await import("../core/monitor/alertChannels.js");
    const delivered = vi.mocked(deliverAlert);
    const fire = async (id: string) => {
      const cond = (await import("drizzle-orm")).eq(db.schema.alertRules.id, id);
      const patch = { state: "firing" as const, lastValue: 5000, lastFiredAt: new Date(), lastNotifiedAt: new Date() };
      if (db.kind === "sqlite") {
        await db.db.update(db.schema.alertRules).set(patch).where(cond);
      } else {
        await db.db.update(db.schema.alertRules).set(patch).where(cond);
      }
    };
    const rule = await createAlertRule(db, {
      name: "resolve on change",
      metric: "p95LatencyMs",
      operator: "gt",
      threshold: 1000,
      windowMinutes: 15,
      channels: [{ kind: "slack", target: "https://hooks.slack.com/services/T/B/x" }],
    });

    await fire(rule._id);
    delivered.mockClear();
    expect((await updateAlertRule(db, rule._id, { threshold: 9000 }))!.state).toBe("ok");
    expect(delivered).toHaveBeenCalledTimes(1);
    expect(delivered.mock.calls[0]![1]).toMatchObject({ kind: "resolved", status: "RESOLVED" });
    expect(delivered.mock.calls[0]![1].summary).toContain("the rule was changed");

    await fire(rule._id);
    delivered.mockClear();
    await updateAlertRule(db, rule._id, { enabled: false });
    expect(delivered.mock.calls[0]![1].summary).toContain("the rule was paused");
    // A pause of an "ok" rule owes nothing.
    delivered.mockClear();
    await updateAlertRule(db, rule._id, { enabled: true });
    await updateAlertRule(db, rule._id, { enabled: false });
    expect(delivered).not.toHaveBeenCalled();
    expect((await listAlertEvents(db, rule._id, 10)).map(e => e.kind)).toEqual(["resolved", "resolved"]);

    await updateAlertRule(db, rule._id, { enabled: true });
    await fire(rule._id);
    delivered.mockClear();
    expect(await deleteAlertRule(db, rule._id)).toBe(true);
    expect(delivered.mock.calls[0]![1].summary).toContain("the rule was deleted");
  });

  it("writes only the fields an update names, so a sweep transition landing in between survives", async () => {
    const { createAlertRule, updateAlertRule, getAlertRule } = await import("../core/monitor/alertRules.js");
    const rule = await createAlertRule(db, {
      name: "sparse",
      metric: "traceCount",
      operator: "lt",
      threshold: 1,
      windowMinutes: 5,
      channels: [{ kind: "webhook", target: "https://example.com/hook" }],
    });
    // The sweep advances the lifecycle after the editor read the rule but before it saves.
    const cond = (await import("drizzle-orm")).eq(db.schema.alertRules.id, rule._id);
    const advanced = { state: "firing" as const, lastValue: 0, firedCount: 4, lastFiredAt: new Date("2026-09-15T10:00:00Z") };
    if (db.kind === "sqlite") {
      await db.db.update(db.schema.alertRules).set(advanced).where(cond);
    } else {
      await db.db.update(db.schema.alertRules).set(advanced).where(cond);
    }
    const renamed = await updateAlertRule(db, rule._id, { name: "sparse (renamed)" });
    expect(renamed!.name).toBe("sparse (renamed)");
    const stored = (await getAlertRule(db, rule._id))!;
    expect(stored.state).toBe("firing");
    expect(stored.firedCount).toBe(4);
    expect(stored.lastFiredAt).toBe("2026-09-15T10:00:00.000Z");
  });

  it("matches an echoed PagerDuty mask to its own stored key, not to a position", async () => {
    const { createAlertRule, updateAlertRule, getAlertRule } = await import("../core/monitor/alertRules.js");
    const { deliverAlert } = await import("../core/monitor/alertChannels.js");
    const primary = "Rprimary0123456789abcdef01234567";
    const secondary = "Rsecondary123456789abcdef0123456";
    const rule = await createAlertRule(db, {
      name: "two on-calls",
      metric: "traceCount",
      operator: "lt",
      threshold: 1,
      windowMinutes: 5,
      channels: [
        { kind: "pagerduty", target: primary },
        { kind: "pagerduty", target: secondary },
      ],
    });
    const [maskedPrimary, maskedSecondary] = rule.channels.map(c => c.target);
    // The operator drops the primary and keeps the secondary - at position 0 now.
    const kept = await updateAlertRule(db, rule._id, { channels: [{ kind: "pagerduty", target: maskedSecondary! }] });
    expect(kept!.channels).toEqual([{ kind: "pagerduty", target: maskedSecondary }]);
    // What is stored behind the mask is the secondary key: the delivery stub sees it.
    const delivered = vi.mocked(deliverAlert);
    delivered.mockClear();
    const { sendAlertRuleTest } = await import("../core/monitor/alertRules.js");
    await sendAlertRuleTest(db, rule._id);
    expect(delivered.mock.calls[0]![0]).toEqual({ kind: "pagerduty", target: secondary });
    expect((await getAlertRule(db, rule._id))!.channels[0]!.target).not.toBe(maskedPrimary);
  });
});
