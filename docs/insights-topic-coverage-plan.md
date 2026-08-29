# Insights: production topic coverage of evaluation datasets

**Status:** plan, not implemented. No code changes accompany this document.

## 1. The idea in one line

We already know *what production does* (the topic map, from `monitor_classifications`)
and *what we test* (dataset cases). **Insights** is the join between the two: for every
topic real users bring us, how well is it represented by reviewed test cases - and where
it isn't, produce the cases.

Today those two halves never meet. Topics is pure observability
(`core/monitor/topics.ts`: "it never raises a Signal ... pure observability"), and
datasets are grown one trace at a time through Curate, with nobody asking whether the
resulting set actually resembles the traffic. Insights makes dataset quality a
*measured* property instead of a felt one, and turns the measurement into a work queue.

## 2. What already exists (and why this is cheap to build)

| Piece | Where | What Insights takes from it |
|---|---|---|
| Per-trace classification: `intent`, `sentiment`, `issueType` | `core/monitor/topics.ts` | The raw topic signal |
| **Embedding persisted per classification** | `monitor_classifications.embedding` | The single most important asset - traces already live in a vector space |
| UMAP map view, `MIN_POINTS_FOR_MAP`, `MAX_MAP_POINTS` | `topics.ts::getTopicsMap` | Precedent for "derived view, recomputed, capped, degrades honestly" |
| Cosine + dedupe threshold **0.75**, calibrated for `text-embedding-3-small` | `core/evaluate/curation.ts` | The same similarity scale, reused rather than re-invented |
| `previewCaseFromTrace` / `previewCaseFromSession` / `suggestExpected` / `addCaseToDataset` | `curation.ts` | The generation *landing* path - preview, human edits, append |
| `generateSyntheticCases` | `core/evaluate/synthesize.ts` | Cold-start generation, extended here with topic grounding |
| Severity vocabulary | `core/shared/severity.ts` | Risk weighting |
| Outcome reports (real-world ground truth, `isNegative`) | `core/outcomes/outcomeReports.ts` | The strongest risk input we have |
| Background sweep + lease | `core/shared/sweepLease.ts`, `improvementSweep.ts` | How the expensive recompute runs |
| Cache-miss-returns-null, compute in background | `core/monitor/attention.ts` | The exact request-path posture to copy |

Insights is mostly *arithmetic over vectors we already store*. The expensive parts
(classification, embedding) are already paid for.

## 3. The crux: one vector space for traffic and tests

Coverage is only comparable if traces and dataset cases are projected into the **same**
space. That is the whole design.

- Traces: already embedded (`monitor_classifications.embedding`).
- Cases: embed `main_question.query` once, cache by content hash.
- Topics: a **persisted centroid**, not a string.

### 3.1 From free-text intents to stable topics

`intent` is an LLM-written free-text label, steered toward reuse but still drifting
("refund request" vs "requested refund"). Joining coverage on strings would be brittle
and would silently split a topic in half.

A **topic consolidation sweep** clusters classification embeddings (agglomerative,
cosine, average-linkage; HDBSCAN if we want noise handling) and writes `insight_topics`
rows carrying:

- stable `id`
- `centroid` (mean unit vector)
- `label` (LLM-written from the cluster's medoid traces) + `aliases` (the intent strings
  that fell in)
- `radius` / `spread` (mean cosine distance to centroid) - used below
- `trafficCount`, `trafficShare`

This is exactly the "true unsupervised clustering ... a materially bigger piece left for
a future pass" that `topics.ts`'s header defers. Insights is the reason to do it.

Topic assignment for a new trace becomes centroid proximity, which means the sweep is
also a **novelty detector**: a trace whose best cosine to every centroid is below a floor
is not in any known topic. See §7.

### 3.2 Soft assignment, not argmax

Assigning each case to its single nearest topic throws away information and makes the
numbers jumpy at cluster boundaries. Instead, a case contributes to topics by a softmax
over cosine to the top-k centroids, with two rules:

- **Floor:** best cosine below `OFF_MAP_FLOOR` (~0.45 on this embedding scale) - the case
  matches *no* topic. This is itself a finding: **dead test weight**, cases exercising
  something production never asks. Nobody reports this today.
- **Ambiguity:** if top-2 are within epsilon, the case genuinely spans both; the split
  contribution is correct, not a rounding error.

## 4. Measuring coverage honestly

### 4.1 Why "number of cases" is the wrong metric

Ten near-duplicate refund cases is not ten times the coverage of one. A metric that can
be inflated by pasting the same case is worthless, and worse, it will be inflated,
because we are about to build a button that generates cases.

### 4.2 The metric: facility-location coverage

For topic `t`, let `T` be its trace embeddings (sampled, capped) and `C` the dataset
cases assigned to it. Define

```
coverage(t) = (1 / |T|) * SUM over x in T of  max over c in C of  sim(x, c)
```

clipped and rescaled so that "a case sitting right on a trace" reads as 1 and "nothing
nearby" reads as 0. This is the classic submodular **facility-location** value.

Why this is the right shape:

- Diminishing returns are automatic - a duplicate case adds nearly nothing, because the
  `max` is already satisfied. The anti-gaming property falls out of the math instead of
  needing a separate rule.
- It rewards *spread*: covering three phrasings of a request beats three copies of one.
- Sub-mode coverage (§4.4) is the same number computed per sub-cluster - one formula, not
  a second system.
- It reuses the 0.75 similarity calibration already in `curation.ts`.

**Fallback:** with no `OPENAI_API_KEY` (or embeddings that failed), degrade to
`min(1, distinctCases(t) / target(t))` grouped by intent string, and mark the response
`degraded: true`. Every embedding path in this repo already returns null on failure; this
must too. A degraded number is labelled, never silently wrong.

### 4.3 Per-topic target - not a flat constant

The mockup shows "0 / 6 target" and "12 / 10 target". A flat target per topic is wrong:
a narrow topic is finished at 3 cases, a sprawling one is thin at 20.

```
target(t) = ceil( BASE
                + K_TRAFFIC * sqrt(trafficShare(t))
                + K_RISK    * risk(t)
                + K_SPREAD  * spread(t) )
```

`spread(t)` is the topic's measured intra-cluster diameter - we already have it from the
clustering step. **Coverage targets driven by measured semantic diversity, not just
volume**, is the part of this that ordinary eval tooling does not do. `sqrt` on traffic
so a 40%-of-traffic topic doesn't demand 40% of the test budget.

### 4.4 Sub-mode coverage: the sharp insight

Within a topic, k-means its trace embeddings into sub-clusters (k from `spread`), then
compute the same facility-location value per sub-cluster. This produces the finding that
actually changes what someone does on Monday:

> *Password reset: 12 cases, 100% headline coverage. Three sub-modes - MFA lockout,
> corporate SSO, recovery-email bounced - have no case within 0.5. 100% is the average of
> a well-covered happy path and three uncovered failure modes.*

That is a materially better product than a green tile.

### 4.5 The three headline numbers

Matching the mockup exactly:

- **Traffic-weighted coverage** = `SUM_t trafficShare(t) * coverage(t)` -
  "share of real requests represented by a reviewed test case".
- **Topic breadth** = `count(coverage(t) >= threshold) / topicCount` - the 5/8 tile.
- **Risk-weighted coverage** = `SUM_t normRisk(t) * coverage(t)` -
  "high-impact scenarios adequately tested".

The traffic/risk gap is the headline story: 68% vs 51% says *you test what is common, not
what is dangerous*. That single sentence is the reason this feature sells.

### 4.6 Risk score, and why it must be explainable

`risk(t)` blends, all joinable through `traceId` today:

| Input | Source | Weight rationale |
|---|---|---|
| Negative outcome reports | `outcome_reports.isNegative` | Confirmed real-world harm - strongest available truth |
| Open failure Signals, severity-weighted | `monitor_signals` + `severity.ts` | Someone already triaged this as bad |
| `issueType != "none"` density | `monitor_classifications` | Cheap, always available |
| Negative sentiment density | `monitor_classifications` | Weakest; user frustration is noisy |

The API returns the **components alongside the score**, never a bare number. "High risk"
that can't be explained gets ignored the second time a user sees it.

## 5. Topic states and the map

Three states, matching the mockup's legend:

- **Covered** - `coverage >= target` and no uncovered sub-mode above a traffic floor.
- **Underrepresented** - `0 < coverage < target`.
- **Missing** - no case assigned at all.

Plus two states the mockup doesn't have and should:

- **Stale** - covered, but the topic's centroid has drifted since the cases were written
  (§7). Green that quietly stopped being true is worse than red.
- **Off-map cases** - not a topic state, a dataset-level list: cases matching no topic.
  Either dead weight or evidence the topic sweep is missing something. Presented as a
  question, not a verdict.

## 6. The generation flywheel

A gap is not "generate 6 cases". It is a **generation brief** built from real evidence:

1. **Medoids** - the traces nearest the centroid: what this topic normally looks like.
2. **Uncovered sub-mode representatives** - traces from sub-clusters with no nearby case.
   These are the cases actually worth writing.
3. **Failure evidence** - traces in this topic with `issueType != none`, an open Signal,
   or a negative outcome report. These become *regression* cases with a known-bad actual
   output already attached.
4. **Style anchors** - two existing cases from the target dataset, exactly as
   `synthesize.ts` already does.

Two paths, both landing in the existing human-review flow:

**Curate (preferred).** Real traces, real user language, no synthetic staleness. Insights'
job is *selection*: which traces to promote. Use **maximum marginal relevance** - close to
the uncovered region, far from cases already in the dataset:

```
score(x) = sim(x, uncoveredCentroid) - LAMBDA * max over c in C of sim(x, c)
```

This is active learning applied to test curation. Compare with the status quo ("scroll the
trace list, pick some recent ones"). Selected traces go through
`previewCaseFromTrace` -> `suggestExpected` -> human -> `addCaseToDataset`, which already
dedupes at 0.75, so a bad suggestion is rejected by machinery that exists.

**Synthesize.** For genuinely missing topics with too few real traces, extend
`generateSyntheticCases` with a topic-grounded mode: the SOURCE becomes real trace
excerpts plus the topic label, rather than a pasted document. Same schema, same route
shape, same human review.

**Nothing auto-adds.** Both `curation.ts` and `synthesize.ts` state this posture
explicitly ("Nothing lands in a dataset unreviewed"). Insights must not be the feature
that breaks it - and shouldn't want to. A coverage number inflated by unreviewed
generated cases is the exact failure mode §4.2 exists to prevent. Ship it as a stated
principle, not an omission.

## 7. Ideas worth doing that the obvious version misses

**7.1 Unknown unknowns - Good-Turing.** The topic map can only show topics we have seen.
Classification is *sampled* (`topicsSampleRate`), so it is a survey, and surveys have a
species-estimation problem with a known answer. Let `f1` be topics observed exactly once.
The Good-Turing / Chao1 estimate of unobserved mass gives an honest line:

> *~7% of traffic falls in topics seen too rarely to name. Coverage is 68% +/- 7.*

Cheap to compute from counts we already have, statistically respectable, and it doubles as
the nudge to raise the sample rate. No eval tool ships this. It reframes the product from
"here is your score" to "here is your score and how much we can't see" - which is the
posture that earns trust from the people who buy this.

**7.2 Novelty and drift.** Because centroids are persisted, a trace below `OFF_MAP_FLOOR`
against every centroid is novel. Track the novelty rate per day: a rising rate is an
*emerging topic* before it is big enough to cluster. Feed it into the existing Signal
machinery so it lands in the surfaces people already watch. Related: recompute coverage
against last month's centroids to attribute a coverage drop correctly -
*"71% -> 62%, not because tests were deleted, because traffic moved."* Coverage that only
falls when you delete a test is a lagging indicator; this makes it leading.

**7.3 Coverage as a CI gate.** Snapshot coverage per run; fail a CI eval run when
risk-weighted coverage of critical topics drops below a threshold. This is what makes
Insights load-bearing rather than a dashboard people visit twice. Natural fit with
`agentx_list_ci_runs` and the existing eval CI path.

**7.4 Cost-aware coverage.** Every topic's cases cost tokens to run. Present the
**marginal coverage per case** for each proposed case (the facility-location gain) so a
team on a budget adds the 5 cases that buy the most coverage, not 30 that buy the same.
Submodular greedy selection gives this for free and is provably within 1-1/e of optimal.

**7.5 Judge-blind-spot coverage.** A second, orthogonal axis: are the *scorers* covering
the topic, or is a whole topic being graded by a generic judge that never looks at what
matters there? Same join, different right-hand side (`evaluation_settings` / judge
scorers instead of cases). Out of scope for v1, but the schema should not preclude it -
which is why coverage rows key on `(topicId, datasetId)` and not on the dataset alone.

**7.6 Reverse direction - dataset provenance debt.** For each *case*, when was its topic
last seen in production, and did production behaviour in that topic change since? Surfaces
tests that are now testing a world that no longer exists. Same data, read backwards.

## 8. Shape of the code

New module directory, mirroring how `core/monitor/` and `core/evaluate/` are organised:

```
engine/src/core/insights/
  topics.ts      # consolidation sweep: cluster, centroid, label, aliases, spread
  coverage.ts    # case embedding cache, soft assignment, facility-location coverage
  risk.ts        # risk score + explainable components
  gaps.ts        # gap ranking, MMR trace selection, generation briefs
  snapshots.ts   # history, deltas, CI gate evaluation
```

**Schema** (both `schema.sqlite.ts` and `schema.pg.ts`, per repo convention):

- `insight_topics` - id, projectId, label, aliases (json), centroid (json number[]),
  spread, trafficCount, updatedAt
- `monitor_classifications.topicId` - nullable FK, backfilled by the sweep. A column
  rather than a join table: assignment is 1:1 and this keeps the aggregate queries the
  same shape they are today.
- `insight_case_embeddings` - datasetId, caseKey (content hash), embedding (json), model.
  Keyed by content hash so an edited case re-embeds and an unchanged one never does.
- `insight_coverage_snapshots` - projectId, agentId, datasetId, computedAt, the three
  headline numbers, per-topic json. Powers deltas and the CI gate.

**Compute posture.** Clustering + coverage is far too heavy for a request. Follow
`improvementSweep.ts`: a leased background sweep (`sweepLease.ts`) on a schedule plus an
explicit `POST /insights/recompute`. Reads serve the last snapshot. Follow
`attention.ts` exactly for the cache-miss case: return what we have immediately, compute
in the background, let the next poll pick it up. Never block a dashboard load on an LLM
or a UMAP fit.

**Routes** - `engine/src/routes/insights.ts`:

| Route | Returns |
|---|---|
| `GET /insights/coverage` | three headline numbers, topic list w/ state, degraded flag, unknown-mass estimate |
| `GET /insights/topics/:id` | the detail panel: traffic share, cases vs target, coverage, risk components, sub-modes, suggested action |
| `POST /insights/topics/:id/brief` | the generation brief (selected traces, failure evidence, style anchors) |
| `POST /insights/topics/:id/generate` | topic-grounded synthesis -> preview cases (no write) |
| `POST /insights/recompute` | force the sweep |

Zod schemas go in `contract/wire.ts` alongside the existing monitor schemas - the
dashboard (`AgentX-eval-front`, separate private repo) consumes that contract, so the
wire shape needs to be settled in this plan's review, before UI work starts.

## 9. Phasing

**Phase 0 - the screen, on data we already have.** Case embedding cache, string-grouped
topics from existing `intent` values, count-based coverage, three headline tiles, topic
map states, per-topic panel. Ships the mockup. No clustering, no sweep. Proves the
concept and settles the wire contract.

**Phase 1 - real topics.** Consolidation sweep, centroids, soft assignment,
facility-location coverage, risk scoring, sub-mode analysis. The numbers become
defensible.

**Phase 2 - the flywheel.** Generation briefs, MMR trace selection, topic-grounded
synthesis, marginal-coverage-per-case ranking. Insights starts producing work, not just
describing it.

**Phase 3 - the moat.** Snapshots and deltas, drift attribution, novelty alerts,
Good-Turing unknown mass, CI coverage gate.

Each phase is independently shippable and each one leaves the product better than it
found it.

## 10. Open questions - need a decision before Phase 0

1. **Scope of a coverage number.** Per project, per agent, or per (agent x dataset)? An
   agent may run dataset B while topic X is covered only by dataset A, which would report
   green while the agent's actual suite is blind. Recommendation: compute per
   `(agentId, datasetId)` and roll up, since only the rolled-up view is meaningful on the
   Overview page but only the pair is actionable.
2. **Embedding budget.** Case embeddings are cheap and cached; re-clustering thousands of
   traces nightly is not free. Cap and sample, following `MAX_MAP_POINTS`'s precedent?
3. **Does Insights get its own nav section**, or live as a tab under Datasets and a card
   on Overview? It reads as its own thing, but it is only ever acted on from a dataset.
4. **Do we backfill?** `monitor_classifications.embedding` is explicitly not backfilled
   for older rows. Topics built from a partial history will under-count older traffic.
5. **Naming.** "Insights" is generic and `attention.ts` already owns the word `insight`
   for its one-line digest. *Coverage*, *Gaps*, or *Dataset Fit* are all sharper. Worth
   deciding before it reaches the wire contract and becomes hard to rename.
