import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEngine, postJson, type TestEngine } from "./server.js";
import { improvementGroupsResponseSchema, improvementReportResponseSchema } from "../contract/wire.js";

// Auto-improve, end to end: a low judge score raises a signal; a human CONFIRMS it in review;
// the confirmed occurrence lands in the "Confirmed failures" improvement group automatically
// (Confirm IS the accumulation gesture); the group is spent on an id-addressable improvement
// report the auto-improve skill fetches. Online evidence only - no dataset run anywhere here.

let engine: TestEngine;
let key: string;
let judgeStub: http.Server;
let stubUrl: string;

const api = (path: string, init?: Parameters<TestEngine["json"]>[1]) =>
  engine.json(`/api/v1${path}`, { apiKey: key, ...(init ?? {}) });

beforeAll(async () => {
  judgeStub = http.createServer((req, res) => {
    let raw = "";
    req.on("data", chunk => (raw += chunk));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      // One stub, two roles: scoring calls get a low rating; the report-synthesis call (its
      // prompt names the confirmed-failure analysis) gets a REPORT_SCHEMA payload.
      const isReportCall = raw.includes("HUMAN-CONFIRMED");
      const output = isReportCall
        ? {
            summary: "The agent invents refund policy under pressure.",
            issues: [
              {
                title: "Invented refund policy",
                description: "Responses assert policy that exists nowhere.",
                recommendation: "Ground refund answers in the policy tool output.",
                memberIndexes: [0],
              },
            ],
          }
        : { rating: 2, justification: "stub says bad" };
      res.end(
        JSON.stringify({
          id: "resp_stub",
          output_text: JSON.stringify(output),
          usage: { input_tokens: 5, output_tokens: 5 },
        })
      );
    });
  });
  await new Promise<void>(resolve => judgeStub.listen(0, "127.0.0.1", resolve));
  const address = judgeStub.address();
  stubUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

  engine = await startEngine({ OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", GEMINI_API_KEY: "" });
  const created = await engine.json("/api/v1/projects", { ...postJson({ name: "auto-improve" }), apiKey: null });
  key = (created.body as { project: { apiKey: string } }).project.apiKey;

  const model = await api(
    "/agent-monitoring/portability/models",
    postJson({
      id: "stub-judge-i",
      provider: "custom",
      label: "Stub judge I",
      baseUrl: stubUrl,
      pricePerMInputTokens: 0,
      pricePerMOutputTokens: 0,
    })
  );
  expect(model.status).toBe(201);

  const scorer = await api(
    "/agent-monitoring/judge-scorers",
    postJson({
      name: "improve-judge",
      judge: { evaluationCriteria: "Anything.", judgeModel: "stub-judge-i" },
      online: { enabled: true, sampleRate: 1, alertThreshold: 5 },
    })
  );
  expect(scorer.status).toBe(201);
  const scorer2 = await api(
    "/agent-monitoring/judge-scorers",
    postJson({
      name: "improve-judge-2",
      judge: { evaluationCriteria: "Anything else.", judgeModel: "stub-judge-i" },
      online: { enabled: true, sampleRate: 1, alertThreshold: 5 },
    })
  );
  expect(scorer2.status).toBe(201);
}, 90_000);

afterAll(async () => {
  await engine?.stop();
  await new Promise<void>(resolve => judgeStub.close(() => resolve()));
});

describe("auto-improve loop", () => {
  it("Confirm accumulates evidence; the group spends into an id-addressable report", async () => {
    await api("/ingest/traces", postJson({ name: "improve-agent", input: "refund?", output: "bad answer", span_id: "i-1" }));
    await new Promise(r => setTimeout(r, 2000));

    const signals = await api("/agent-monitoring/signals?polarity=all");
    const signal = ((signals.body as { signals: Array<{ _id: string; summary: string }> }).signals ?? []).find(s =>
      s.summary.includes('"improve-judge"')
    );
    expect(signal, JSON.stringify(signals.body).slice(0, 300)).toBeTruthy();

    // Confirm the flag - this alone must land the occurrence in the default group.
    const confirm = await api(`/agent-monitoring/signals/${signal!._id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "triaged", reviewStatus: "reviewed" }),
    });
    expect(confirm.status).toBe(200);

    const groups = improvementGroupsResponseSchema.parse((await api("/agent-monitoring/improvement-groups")).body);
    expect(groups.improvementGroups.length).toBe(1);
    const group = groups.improvementGroups[0]!;
    expect(group.name).toBe("Confirmed failures");
    expect(group.memberCount).toBe(1);

    const detail = (await api(`/agent-monitoring/improvement-groups/${group._id}`)).body as {
      improvementGroup: { members: Array<{ rating: number | null; source: string; traceId: string | null }> };
    };
    expect(detail.improvementGroup.members[0]).toMatchObject({ rating: 2, source: "low-score" });
    expect(detail.improvementGroup.members[0]!.traceId).toBeTruthy();

    // Re-confirming the SAME verdict after a resolve/reopen cycle must not double the evidence.
    await api(`/agent-monitoring/signals/${signal!._id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "resolved", resolutionReason: "fixed" }),
    });
    await api(`/agent-monitoring/signals/${signal!._id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "triaged" }),
    });
    const again = improvementGroupsResponseSchema.parse((await api("/agent-monitoring/improvement-groups")).body);
    expect(again.improvementGroups[0]!.memberCount).toBe(1);

    // Spend the group: an explicit, billed LLM pass producing the report the skill consumes.
    const generated = await api(`/agent-monitoring/improvement-groups/${group._id}/report`, {
      ...postJson({ model: "stub-judge-i" }),
    });
    expect(generated.status, JSON.stringify(generated.body).slice(0, 300)).toBe(200);
    const report = improvementReportResponseSchema.parse(generated.body).report;
    expect(report.groupName).toContain("Confirmed failures");
    expect(report.issues.length).toBe(1);
    expect(report.issues[0]!.title).toBe("Invented refund policy");
    expect(report.issues[0]!.evidence[0]).toMatchObject({ rating: 2 });

    // The id is the hand-off: fetching it back returns the same report (what the skill does).
    const fetched = improvementReportResponseSchema.parse(
      (await api(`/agent-monitoring/improvement-reports/${report._id}`)).body
    ).report;
    expect(fetched._id).toBe(report._id);
    expect(fetched.issues[0]!.recommendation).toContain("policy tool");

    // Unknown ids are honest 404s, not empty reports.
    expect((await api("/agent-monitoring/improvement-reports/nope")).status).toBe(404);

    // --- Batch lifecycle: generating SEALED the group and cleared the accumulator ------------
    const afterSeal = improvementGroupsResponseSchema.parse((await api("/agent-monitoring/improvement-groups")).body);
    // The spent batch keeps its source case and is renamed with its seal time...
    const sealed = afterSeal.improvementGroups.find(g => g._id === group._id)!;
    expect(sealed.status).toBe("proposed");
    expect(sealed.memberCount).toBe(1);
    expect(sealed.name).toContain("Confirmed failures ·");
    // ...and no collecting accumulator holds anything pending.
    expect(afterSeal.improvementGroups.filter(g => g.status === "collecting")).toEqual([]);

    // A new confirm starts a FRESH collecting group - the old batch is untouched.
    await api("/ingest/traces", postJson({ name: "improve-agent", input: "q2", output: "bad again", span_id: "i-2" }));
    await new Promise(r => setTimeout(r, 2000));
    const signals2 = await api("/agent-monitoring/signals?polarity=all");
    const signal2 = ((signals2.body as { signals: Array<{ _id: string; summary: string }> }).signals ?? []).find(s =>
      s.summary.includes('"improve-judge-2"')
    );
    expect(signal2, JSON.stringify(signals2.body).slice(0, 300)).toBeTruthy();
    await api(`/agent-monitoring/signals/${signal2!._id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "triaged", reviewStatus: "reviewed" }),
    });
    const secondRound = improvementGroupsResponseSchema.parse(
      (await api("/agent-monitoring/improvement-groups")).body
    );
    expect(secondRound.improvementGroups.length).toBe(2);
    const collecting = secondRound.improvementGroups[0]!; // accumulator sorts first
    expect(collecting.status).toBe("collecting");
    expect(collecting._id).not.toBe(group._id);
    expect(collecting.memberCount).toBe(1);
    expect(secondRound.improvementGroups.find(g => g._id === group._id)!.memberCount).toBe(1);

    // Spending the new batch yields a NEW report bound to the NEW group.
    const secondReport = improvementReportResponseSchema.parse(
      (await api(`/agent-monitoring/improvement-groups/${collecting._id}/report`, { ...postJson({ model: "stub-judge-i" }) }))
        .body
    ).report;
    expect(secondReport._id).not.toBe(report._id);
    expect(secondReport.groupId).toBe(collecting._id);
  }, 90_000);
});
