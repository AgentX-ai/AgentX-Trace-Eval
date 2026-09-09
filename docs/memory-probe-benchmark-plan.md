# Memory Probe Benchmarks: evaluating long-term agent memory on the customer's own workflows

**Status:** design. Phase 0 (the `memory` span kind, its SDK helper `tracer.trace_memory()` /
`record_memory()`, timeline lane, and docs) is implemented and shipped as of 2026-09-09; every
phase below is unbuilt.

**One sentence:** a *memory probe suite* seeds conversations into an agent across sessions, then
probes later sessions with questions whose answers depend on what those earlier sessions
established - scoring recall, updates, and temporal reasoning the way LongMemEval does, but
against the customer's own agent and workflows instead of a synthetic chat corpus.

---

## 1. Why, and why us

Within-conversation memory is already covered: multi-turn dataset cases, the Session Baseline
Judge (context retention, self-contradiction, drift pointer), and session-scoped scorers all
grade a single conversation. What no surface covers is **cross-session memory**: "the user said
X last Tuesday - does the agent know it today?"

The market context (2026): the benchmark shape has standardized (LongMemEval's six question
categories, LoCoMo, BEAM), but the harnesses that exist are published *by memory vendors, about
their own stores* (Mem0, Zep, Letta each benchmark themselves). The observability/eval platforms
(Langfuse, LangSmith, Braintrust, Arize) trace memory ops but none evaluates memory as a
first-class capability - Braintrust does not even have native multi-turn evals. A neutral,
self-hosted memory benchmark over *your* agent is an open position, and we already own every
piece it needs: session assembly, session judges, datasets with versioning and CI gates, and
now memory-kind spans.

### Non-goals

- **Not a memory store.** We never persist or manage the agent's memories; we only seed,
  probe, and judge through the agent's own interface.
- **Not a benchmark of memory *products*.** The subject is the customer's agent (whatever
  memory stack it uses), not Mem0-vs-Zep league tables.
- **Not synthetic-corpus research.** LongMemEval's public corpus stays a reference point;
  the value here is the same *categories* run over the customer's real domains.

---

## 2. The core object: a Memory Probe Suite

A new dataset flavor - reusing the dataset tables and editor, distinguished by a `memoryProbe`
config block - with two kinds of entries:

```jsonc
{
  "name": "Support memory bar",
  "memoryProbe": {
    // Seed conversations: multi-turn scripts the harness PLAYS INTO the agent first,
    // each as its own real session. `at` offsets create the temporal spread the
    // temporal-reasoning category needs (see §4 on clock control).
    "seeds": [
      {
        "id": "seed-prefs",
        "at": "-14d",
        "persona": { "userId": "probe-user-1" },
        "turns": [
          { "user": "I'm vegetarian and I fly out of SFO." },
          { "user": "Book me the usual airline if you can." }
        ]
      },
      {
        "id": "seed-update",
        "at": "-3d",
        "persona": { "userId": "probe-user-1" },
        "turns": [{ "user": "Actually I moved - I fly out of Oakland now." }]
      }
    ],
    // Probe cases: asked in a FRESH session after seeding. Each declares its category and
    // which seeds its answer depends on, so results aggregate per category and per seed age.
    "probes": [
      {
        "question": "Where do I usually fly from?",
        "category": "knowledge_update",       // the update must win over the older fact
        "dependsOn": ["seed-prefs", "seed-update"],
        "expectedResults": "Oakland (updated from SFO)",
        "mustMention": ["Oakland"],
        "mustNotMention": ["SFO"]             // asserting the STALE fact is the failure mode
      },
      {
        "question": "Any meal restrictions for my flight?",
        "category": "single_session_recall",
        "dependsOn": ["seed-prefs"],
        "expectedResults": "Vegetarian meal"
      }
    ]
  }
}
```

Probe categories are LongMemEval's, minus none: `single_session_recall`, `assistant_recall`
(what the *agent* said or did earlier), `preference_recall`, `knowledge_update`,
`temporal_reasoning` ("what did I ask about *before* I moved?"), `multi_session` (the answer
requires joining facts across seeds). `abstention` is the seventh, implicit category: probes
whose `dependsOn` is empty test that the agent does NOT fabricate a memory it was never given.

Why by-reference seeds instead of one long transcript: per-seed attribution. When
`knowledge_update` fails, the report can say "recalled seed-prefs, missed seed-update" - the
difference between a score and a diagnosis.

---

## 3. Execution flow

Reuses the run lifecycle end to end - a memory probe run IS an evaluation run
(`runSource: "memory-probe"`), so CI gates, run history, version comparison, and the Evaluate UI
all apply unchanged.

```
1. SEED   For each seed: open a session against the subject agent (connector, SDK execute
          callback, or simulated-conversation runner - all three exist) with a fresh
          sessionId derived from (runId, seed.id) and the persona's userId in metadata.
          Turns play in order; spans/memory-kind traces land like any traffic.

2. SETTLE Wait for the agent's memory write path. Configurable settleSeconds (default 0);
          customers with async memory consolidation set it to their pipeline's latency.

3. PROBE  For each probe: a NEW session (same persona, fresh sessionId), ask the question,
          capture the answer + trace. One probe per session by default - probes must not
          contaminate each other's context windows.

4. JUDGE  Grade each probe answer (see §5). Rows land as ordinary run results with
          category/dependsOn in the result metadata.

5. REPORT Per-category aggregates + per-seed-age curve (recall @ 3d vs @ 14d) on the run;
          gate(fail_under=..., scorer="knowledge_update") works because categories are
          surfaced through the existing per-scorer breakdown machinery.
```

**Who executes the turns:** the same three subject adapters dataset runs already have.
Priority order for v1: agent connectors (HTTP, works for any customer agent that keeps state
server-side by userId) and the SDK `execute()` callback (the customer's own code decides how a
turn reaches their agent). The Playground's simulated-conversation runner joins in v2 for
zero-code demos.

---

## 4. The clock problem (temporal reasoning)

`temporal_reasoning` and any "memory decay" measurement need seeds that are *older than the
probe*. Three strategies, in order of preference, selectable per suite:

1. **Real elapsed time** (`schedule: true`): the harness runs seeds now and probes on a
   schedule (reusing the sweep-style background loop). Honest, slow - right for a standing
   nightly memory bar, wrong for CI.
2. **Timestamp injection** (`clock: "injected"`): seed turns carry `at` offsets and the
   harness passes the intended timestamp to the agent (header/metadata the customer's memory
   stack honors, e.g. Zep/Mem0 accept event timestamps). Fast and honest *if* the customer's
   stack honors it - declared, not assumed: the run report labels results "injected clock".
3. **Narrated time** (`clock: "narrated"`): seeds state their time in-band ("Note: this
   conversation happened two weeks ago"). Weakest, works everywhere, labeled as such.

The suite records which strategy ran; scores across strategies are never merged into one trend
line.

---

## 5. Scoring

Layered, all existing machinery:

- **Deterministic first:** `mustMention` / `mustNotMention` term checks per probe (pattern
  conditions, reused). `mustNotMention` is what catches the stale-fact failure that pure
  LLM-judging tends to forgive.
- **LLM judge:** a Memory Probe Judge (an ordinary judge scorer, seeded as a builtin like the
  Session Baseline Judge) grading the answer against `expectedResults` with a memory-specific
  rubric per category (updates: newest fact wins; abstention: refusing to invent counts as a
  pass, not a low score).
- **Trace-level (optional, needs Phase 0 spans):** if the agent's traces carry `memory`-kind
  spans, a code-scorer-style check asserts the recall actually came FROM memory (a memory read
  span exists in the probe trace whose output mentions the fact) - separating "remembered" from
  "guessed right". Reported as its own column (`memoryEvidence`), never gating by default,
  because most customers will not have instrumented memory ops on day one.
- **Composition:** a scorer group per suite ("Memory bar") blends categories with weights and
  can gate on `knowledge_update` - the highest-stakes category in practice.

---

## 6. Surfaces

- **Wire:** `memoryProbe` block on the dataset (create/update, camelCase); run creation
  unchanged (`datasetId` + optional `scorerGroupId`); results carry
  `{ category, dependsOn, seedSessionIds, probeSessionId, clockStrategy }` per row; run detail
  gains `memoryBreakdown: [{ category, scored, averageRating, staleFactHits }]`.
- **SDK:** `client.evaluations.memory_probe_suite(...)` builder +
  `run(dataset_id=..., ...)` unchanged; `run.memory_breakdown()` accessor;
  `gate(fail_under=..., scorer="knowledge_update")` already works.
- **UI:** the dataset editor gets a Seeds/Probes view for `memoryProbe` datasets; the run
  detail gets a category breakdown card and, per probe row, links to the seed sessions and the
  probe session (both are real sessions - the existing session detail dialog is the drill-down).
- **Docs + sample:** `evaluation/memory-probes.mdx`; `eval_deep_dive/11_memory_probes.py` as
  the assertion-style walkthrough (seed, settle, probe, gate; a deliberately forgetful stub
  agent proves the failure modes are caught).

## 7. Phases

| Phase | Scope | Size |
|---|---|---|
| 0 | `memory` span kind + SDK helper + timeline lane | **shipped** |
| 1 | `memoryProbe` dataset block, seed/probe executor over agent connectors + SDK callback, narrated+injected clocks, deterministic + judge scoring, category breakdown on the run wire, sample script | the core; ~1 engine module (`core/evaluate/memoryProbe.ts`) + run-flow touches |
| 2 | UI (editor view, breakdown card, session links), Memory Probe Judge builtin, scorer-group composition, `memoryEvidence` trace check | dashboard-heavy |
| 3 | Scheduled real-clock suites (standing nightly memory bar, trend chart), decay curves by seed age, abstention category polish | the "drift monitor for memory" |

## 8. Risks and open questions

- **Persona identity plumbing.** Cross-session memory implies the agent knows WHO is asking.
  How the persona's `userId` reaches the customer's agent is adapter-specific (header for
  connectors, callback arg for SDK). v1 makes it an explicit, documented field and refuses to
  run seeds without one, rather than pretending anonymous cross-session memory is testable.
- **Memory pollution.** Probe suites write real memories into the customer's memory store.
  Default posture: dedicated probe personas (`probe-user-*`), never real user ids; docs say to
  point suites at staging memory stores; a `teardownTurns` hook per suite lets customers
  script "forget everything about me" where their stack supports it.
- **Non-determinism across runs.** Seeds re-run per run, so run N's memories can collide with
  run N-1's (same persona). v1: fresh persona per run (`probe-user-<runId>`), suite-pinned
  personas only for the scheduled decay mode where accumulation is the point.
- **Settle-time flakiness.** Async memory pipelines make "seeded but not yet written" look
  like recall failure. `settleSeconds` plus a pre-probe verification turn ("what do you know
  about me so far?") that is recorded but unscored, so a settle failure is diagnosable as such.
- **Open:** should seed playback bypass online scorers/session sweep (it is synthetic traffic
  on a real project)? Leaning yes - tag seed/probe sessions `runSource: "memory-probe"` and
  exclude them from KPIs the way `trace-eval` traffic already is.
