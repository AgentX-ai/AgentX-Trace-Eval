import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEngine, type TestEngine } from "./server.js";

// A fresh install used to put the example agent, its traces and a starter dataset into Default -
// the same project someone points their SDK at first. Their real first trace then arrived into a
// list next to invented ones, and every count on every page was their data plus ours.
//
// Now Default is genuinely empty and the tour lives in its own "Example" project. Pinned here
// because the failure is quiet in both directions: seed content leaking back into Default looks
// like the product working, and an Example project that never gets created looks like an empty
// install nobody can evaluate.

let engine: TestEngine;
let defaultKey: string;
let exampleKey: string;

type Project = { _id: string; name: string; apiKey: string; isDefault: boolean };

const api = (path: string, key: string) => engine.json(`/api/v1${path}`, { apiKey: key });

async function count(path: string, key: string, field: string): Promise<number> {
  const res = await api(path, key);
  const body = res.body as Record<string, unknown>;
  const list = body[field];
  return Array.isArray(list) ? list.length : 0;
}

beforeAll(async () => {
  engine = await startEngine();
  const projects = ((await engine.json("/api/v1/projects")).body as { projects: Project[] }).projects;
  defaultKey = projects.find(p => p.isDefault)!.apiKey;
  exampleKey = projects.find(p => p.name === "Example")?.apiKey ?? "";
}, 90_000);

afterAll(async () => {
  await engine?.stop();
});

describe("fresh install layout", () => {
  it("creates exactly two projects: an empty Default and an Example", async () => {
    const projects = ((await engine.json("/api/v1/projects")).body as { projects: Project[] }).projects;
    expect(projects.map(p => p.name).sort()).toEqual(["Default", "Example"]);
    expect(projects.find(p => p.name === "Default")!.isDefault).toBe(true);
    // The example is a normal project, not a second default.
    expect(projects.find(p => p.name === "Example")!.isDefault).toBe(false);
  });

  it("leaves Default with no content of its own", async () => {
    expect(await count("/agent-monitoring/agents", defaultKey, "agents")).toBe(0);
    expect(await count("/custom-agent-evaluations/datasets", defaultKey, "datasets")).toBe(0);
    expect(await count("/evaluate/prompts", defaultKey, "prompts")).toBe(0);
    expect(await count("/agent-monitoring/signals?workspaceId=local&polarity=all", defaultKey, "signals")).toBe(0);
    const runs = (await api("/custom-agent-evaluations/runs", defaultKey)).body as { runs?: unknown[] };
    expect(runs.runs ?? []).toHaveLength(0);
  });

  it("still gives Default the built-in scorer catalog, which is product, not example data", async () => {
    const scorers = (await api("/agent-monitoring/judge-scorers", defaultKey)).body as { judgeScorers?: unknown[] };
    // The metric pack seeds per project - an empty project is not a project without scorers.
    expect((scorers.judgeScorers ?? []).length).toBeGreaterThan(0);
  });

  it("puts the tour in Example: an agent with traces, a dataset, a prompt", async () => {
    expect(exampleKey).toBeTruthy();
    expect(await count("/agent-monitoring/agents", exampleKey, "agents")).toBe(1);
    expect(await count("/custom-agent-evaluations/datasets", exampleKey, "datasets")).toBe(1);
    expect(await count("/evaluate/prompts", exampleKey, "prompts")).toBe(1);
  });

  it("gives Example a multi-turn session, not only single-exchange traces", async () => {
    const sessions = (await api("/agent-monitoring/sessions?window=7d", exampleKey)).body as {
      sessions?: { turnCount?: number; traceCount?: number }[];
    };
    const list = sessions.sessions ?? [];
    expect(list.length).toBeGreaterThan(0);
    const longest = Math.max(...list.map(s => s.turnCount ?? s.traceCount ?? 0));
    expect(longest).toBeGreaterThanOrEqual(3);
  });

  it("gives Example topics to show, without having spent a judge call to get them", async () => {
    const topics = (await api("/agent-monitoring/topics?window=7d", exampleKey)).body as {
      topIntents?: { intent: string }[];
    };
    expect((topics.topIntents ?? []).length).toBeGreaterThan(0);
  });

  it("gives Example a finished run, so Evaluate opens on a result", async () => {
    const runs = (await api("/custom-agent-evaluations/runs", exampleKey)).body as {
      runs?: { status: string; averageRating: number | null }[];
    };
    const list = runs.runs ?? [];
    expect(list.length).toBeGreaterThan(0);
    expect(list[0]!.status).toBe("completed");
    expect(list[0]!.averageRating).toBeGreaterThan(0);
  });

  it("detection ran on the example traces, so Review is not empty either", async () => {
    const signals = (await api("/agent-monitoring/signals?workspaceId=local&polarity=all", exampleKey)).body as {
      signals?: unknown[];
    };
    expect((signals.signals ?? []).length).toBeGreaterThan(0);
  });
});
