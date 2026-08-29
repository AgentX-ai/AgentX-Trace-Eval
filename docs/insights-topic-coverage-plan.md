# Insights: production topic coverage of evaluation datasets

**Status:** Phase 0 is implemented and shipped, plus one piece of Phase 1 pulled forward.
Phases 1-3 below are otherwise still design.

| Shipped | Where |
|---|---|
| Coverage sweep, three headline numbers, topic states | `engine/src/core/insights/coverage.ts` |
| Case extraction + embedding cache | `engine/src/core/insights/cases.ts` |
| The probe (single + batch) | `engine/src/core/insights/probe.ts` |
| Routes + wire contract | `engine/src/routes/insights.ts`, `engine/src/contract/wire.ts` |
| Tests | `engine/src/test/insights.integration.test.ts`, `contract.integration.test.ts` |
| **Insights tab** | `AgentX-eval-front`, branch `claude/insights-dataset-topic-coverage-mo44s9` |

**Four things changed during implementation.** This document has been corrected rather than left
describing something the code does not do:

1. **Coverage is the facility-location value alone**, never blended with the case count. The first
   implementation took `min(countRatio, depth)`, which quietly reintroduced duplicate-inflation -
   the anti-gaming test failed with `expected 0.857 to be less than or equal to 0.287`. See §4.2.
2. **Cases assign to topics by argmax**, not the softmax of §3.2. With intent-string topics there
   are no real centroid boundaries for a soft assignment to smooth over; softmax arrives with the
   full clustering.
3. **Topic merging was pulled forward from Phase 1** - see the calibration note in §3.1. Running
   against a real install made it non-optional rather than a refinement.
4. **The window defaults to 30d**, not the 7d every monitoring surface uses. On a real install
   every classified trace was older than seven days, so the screen read "nothing classified yet"
   while the 30d window was full. Those charts are recent health; this is accumulated test debt
   measured against a *sampled* classifier.

**Validated against a real install** (340 classified traces, 54 datasets), which found (3) and (4)
- neither was reachable from the unit tests. It reports 43% traffic-weighted / 6 of 35 topics /
8% risk-weighted on that data, and the probe returns a real gap for "I want to cancel my
subscription today" (naming the `Cancel subscription` topic at 11% of traffic) while returning
*not-covered-and-not-asked* for "can I pay my invoice in martian dollars".

Still **unverified**: the Postgres DDL (mirrors the SQLite path, needs `AGENTX_TEST_DB_URL`), and
the non-degraded similarity path end-to-end (no `OPENAI_API_KEY` was available, so the real-data
run exercised the labelled lexical fallback).

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

**Partly shipped, ahead of schedule.** Full centroid clustering is still Phase 1, but the
*merging* half could not wait: on a real install the classifier had coined both "Refund request"
(7 cases, covered) and "Request a refund" (0 cases, **missing**) - one topic reported twice, half
of it inventing a gap that did not exist, its traffic share split between the two. Same for
"Reset Password" / "Reset forgotten password". `mergeSynonymousTopics` merges intent labels whose
trace centroids are close, using embeddings **already stored** on `monitor_classifications` - no
new API calls, and it works with no LLM key at all.

The threshold is **0.87**, and deliberately not curation.ts's 0.75: that constant compares two
single query strings, this compares centroids of *averaged* input+output embeddings, which run
much higher. Measured on that install:

| pair | cosine | verdict |
|---|---|---|
| refund request / request a refund | 0.909 | must merge |
| reset password / reset forgotten password | 0.902 | must merge |
| order tracking / missing package | 0.822 | must **not** |
| refund policy inquiry / request a refund | 0.813 | must **not** |

0.87 splits those with ~0.05 of margin either side. Reusing 0.75 would have merged "where is my
order" with "it never arrived" - different questions with different correct answers. Candidates
are compared against the *seed's* centroid rather than the growing one, so a chain of
pairwise-similar topics (a~b, b~c) cannot collect into one blob when a and c are unrelated.

Topic assignment for a new trace becomes centroid proximity, which means the sweep is
also a **novelty detector**: a trace whose best cosine to every centroid is below a floor
is not in any known topic. See §8.

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
- Sub-mode coverage (§4.5) is the same number computed per sub-cluster - one formula, not
  a second system.
- It reuses the 0.75 similarity calibration already in `curation.ts`.

**Fallback:** with no `OPENAI_API_KEY` (or embeddings that failed), degrade to
`min(1, distinctCases(t) / target(t))` grouped by intent string, and mark the response
`degraded: true`. Every embedding path in this repo already returns null on failure; this
must too. A degraded number is labelled, never silently wrong.

### 4.3 Per-topic attributes - the row behind every tile

Coverage is a verdict; these are the evidence it is computed from, and each is shown in the
topic detail panel so the verdict is auditable.

| Attribute | Source | Notes |
|---|---|---|
| Traffic share | `insight_topics.trafficCount` | Volume |
| **Unique sessions / customers** | `traces.sessionId`; customer via a configurable `metadata` key | See below - volume alone lies |
| **Declared business risk** | Human-set per topic, seeded by heuristic | Distinct from observed risk - see 4.6 |
| Observed failure frequency | `issueType != none`, signals, outcome reports | Its own column, not only a risk input |
| Approved dataset cases | Assigned cases with a human-reviewed expected answer | "Approved", not "present" |
| Case diversity | Facility-location value (4.2) | The anti-duplicate term |
| **Last dataset update** | Max `source.addedAt` over the topic's cases | Case-side staleness |
| **Ground-truth confidence** | See 4.7 | How much the expected answers are worth |

**Unique sessions matter more than request count.** 500 requests from 3 sessions is one
customer hammering a retry loop; 500 from 400 sessions is real demand. Weighting a coverage
target by raw traffic would over-invest in the first. `traces.sessionId` is first-class and
free. Customer identity is not - there is no customer column, only `traces.metadata`, so
customer-level counting ships as an opt-in configured metadata key (`insight_settings.customerKey`)
and degrades to sessions when unset. Volume weight becomes
`sqrt(requests) * log(1 + uniqueSessions)`, so concentration is discounted without being ignored.

### 4.4 Per-topic target - not a flat constant

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

### 4.5 Sub-mode coverage: the sharp insight

Within a topic, k-means its trace embeddings into sub-clusters (k from `spread`), then
compute the same facility-location value per sub-cluster. This produces the finding that
actually changes what someone does on Monday:

> *Password reset: 12 cases, 100% headline coverage. Three sub-modes - MFA lockout,
> corporate SSO, recovery-email bounced - have no case within 0.5. 100% is the average of
> a well-covered happy path and three uncovered failure modes.*

That is a materially better product than a green tile.

### 4.6 Risk: declared and observed are two different things

`risk(t)` blends, all joinable through `traceId` today:

| Input | Source | Weight rationale |
|---|---|---|
| Negative outcome reports | `outcome_reports.isNegative` | Confirmed real-world harm - strongest available truth |
| Open failure Signals, severity-weighted | `monitor_signals` + `severity.ts` | Someone already triaged this as bad |
| `issueType != "none"` density | `monitor_classifications` | Cheap, always available |
| Negative sentiment density | `monitor_classifications` | Weakest; user frustration is noisy |

The API returns the **components alongside the score**, never a bare number. "High risk"
that can't be explained gets ignored the second time a user sees it.

But everything in that table is *observed* risk - it is derived from failures that already
happened. That is circular for exactly the topics this feature exists to catch. The mockup's own
example makes the point: **Account closure, 10% of traffic, 0 cases, 0% coverage**. It has no
failure history, because it is barely exercised - so observed risk scores it low and it sinks
down the queue. The same is true of payment approval, KYC, anything destructive and rare.

So risk is two fields, not one:

- **`observedRisk`** - derived from the table above. Automatic, always available, backward-looking.
- **`declaredRisk`** - a human-set business criticality per topic (`none`/`low`/`high`/`critical`,
  reusing `severity.ts`'s vocabulary rather than inventing a fifth scale). Seeded by a one-time
  LLM pass over topic labels for irreversible or regulated actions (closure, refund, payment,
  identity, data deletion), then owned by the team. Forward-looking, and the only thing that can
  rank an untested danger correctly.

`risk(t) = max(observedRisk, declaredRisk)`, deliberately `max` and not a blend: a topic that is
either demonstrably failing or declared business-critical is risky, and averaging lets one signal
mask the other. **Risk-weighted coverage is computed on this combined value** - otherwise the
headline number it produces has the same blind spot as the metric it is meant to correct.

### 4.7 Ground-truth confidence - what a case is actually worth

A dataset case whose `expectedResults` was auto-drafted and rubber-stamped is not worth the same
as one a reviewer wrote against a real failure. Coverage that treats them alike is measuring
paperwork. Nothing in the current plan captured this, and the repo already holds the provenance:

| Confidence input | Source | Signal |
|---|---|---|
| Human-written vs `suggestExpected`-drafted expected answer | `curation.ts` provenance | Was a person's judgment applied |
| Reviewer label on the source trace | `review_queue_items.label` - *"A label is ground truth"* | The strongest per-case evidence |
| Confirmed by a real-world outcome | `outcome_reports` joined via `source.traceId` | Reality agreed |
| Corrected score vs judge score | `review_queue_items.correctedScore` / `judgeScoreAtQueue` | A human actively disagreed and fixed it |
| Case has never been run | evaluation run history | Untested test |

`groundTruthConfidence` in [0,1] per case, rolled up per topic. It feeds case adequacy (4.8) and
is surfaced on its own, because "34 covered topics, but 11 of them rest on unverified expected
answers" is a finding a team acts on.

### 4.8 Case adequacy - decomposed, then combined carefully

A topic is not covered because it has one dataset row. Adequacy in [0,1] per topic, from six
factors, each independently displayable:

| Factor | Meaning |
|---|---|
| `volume` | Reviewed cases against target (4.4) |
| `diversity` | Facility-location value (4.2) - variants and phrasings |
| `edgeCases` | Coverage of the topic's *failure* sub-modes specifically, not just its sub-modes |
| `groundTruth` | Confidence roll-up (4.7) |
| `recency` | See the correction below |
| `reviewerConfidence` | Explicit reviewer signal where one exists |

Then:

```
                  SUM_t  productionWeight(t) * adequacy(t)
coverage      =   ------------------------------------------
                  SUM_t  productionWeight(t)
```

with `productionWeight` = traffic share, breadth (uniform), or combined risk, giving the three
headline numbers from one formula.

**Two corrections this decomposition needs, or it will misreport:**

**Do not multiply the factors.** Six factors at a respectable 0.8 each multiply to 0.26. A topic
that is genuinely decent at everything renders as catastrophic, every topic goes red, and people
stop reading the page - the classic way a well-intentioned composite score dies. Use a **weighted
geometric mean** (`exp(SUM w_i * ln f_i)` with `SUM w_i = 1`), which keeps the "one bad factor
drags the score" property that makes a product attractive here, while staying on the same scale
as its inputs. Two factors are **gates** rather than terms - zero reviewed cases or zero ground
truth caps adequacy outright, because no amount of diversity rescues a topic with no verified
expected answer.

**Recency must be relative, not absolute.** A two-year-old case for a topic whose behaviour has
not changed is fine; a three-month-old case for a topic that drifted last week is stale. Raw case
age would flag the first and miss the second - exactly backwards. Measure recency as case age
*against centroid movement since that case was added* (8.2 already computes the drift). This is
the case-side complement to the **Stale** topic state, and the two are independent failure modes:
the traffic moved, or the test rotted.

### 4.9 One number, or four?

Quality-adjusted coverage is **not** a fourth metric sitting beside the other three. It is the
same three metrics with `adequacy(t)` substituted for the crude "has cases" term - which is what
4.8's formula already does. Shipping four co-equal percentages would leave a reader asking which
one is the real one, and they would pick whichever is highest.

So: **three headline numbers, all quality-adjusted**, exactly matching the mockup's tiles:

- **Traffic-weighted coverage** - `productionWeight` = traffic share.
  *"Share of real requests represented by an adequate test case."*
- **Topic breadth** - count of topics whose adequacy clears a threshold, over topic count. The 5/8 tile.
- **Risk-weighted coverage** - `productionWeight` = `max(observedRisk, declaredRisk)`.
  *"High-impact scenarios adequately tested."*

Plus one secondary number that earns its place precisely because it is a comparison:

> **68% by case presence, 41% quality-adjusted.**

That **honesty delta** is arguably the most valuable figure on the page. A large gap means the
dataset is a facade - rows exist, confidence does not - and it is the single number that tells a
team whether their next hour goes into *writing new cases* or *verifying the ones they have*.
No other eval tool distinguishes those two kinds of work.

The traffic-versus-risk gap remains the headline story (*you test what is common, not what is
dangerous*); the presence-versus-quality gap is the second story (*you have rows, not tests*).

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

## 7. Ask the dataset a question

Everything above is a *sweep*: it computes coverage for topics production already produced.
That leaves an obvious question unanswerable — **"is this specific thing tested?"** — which is
the question people actually have, in the words they actually have it in. The probe is the
inverse lookup: type a query, get a calibrated verdict.

It is also, unexpectedly, the cheapest thing in this plan. One embedding call, cosine against
the cached case embeddings and the topic centroids, no LLM in the verdict path, sub-second.

### 7.1 It must answer three questions, not one

The naive version answers only the first, and is actively misleading for it:

1. **Is there a test for this?** Nearest cases by cosine.
2. **Does production actually ask this?** Nearest centroid and its traffic share.
3. **Would it be adequately covered?** The adequacy (§4.8) of the topic it lands in.

Cross the first two and the real product appears:

| | **Production asks this** | **Production doesn't** |
|---|---|---|
| **Dataset covers it** | Fine. Show the case, move on. | **Dead test weight** — the off-map finding (§5), reached from the other direction |
| **Dataset doesn't** | **A real gap.** Offer to generate. | **A hypothesis, not a gap.** Say so plainly. |

That bottom-right cell is why the naive version is dangerous. A query with no coverage *and* no
traffic is not a hole in the suite - and answering "not covered!" would send a team writing tests
for things nobody asks. Insights should say: *"nothing in production resembles this either -
it may be worth testing anyway, but this is not a gap in your coverage of real traffic."*
Refusing to manufacture work is a feature.

### 7.2 Calibrated verdicts, using the numbers the repo already measured

A raw cosine ("0.62") means nothing to anyone. `curation.ts` has already done the calibration
work for `text-embedding-3-small` - measured paraphrase pairs at 0.82-0.88, related-but-distinct
questions at 0.48-0.56 - so the bands come for free and need no second calibration to maintain:

| Similarity | Verdict | Wording |
|---|---|---|
| >= 0.75 | **Covered** | "Effectively the same question as an existing case." |
| 0.56 - 0.75 | **Adjacent** | "Nearest case asks something related, not this." |
| < 0.56 | **Not covered** | "Nothing in the dataset is close." |

The 0.75 band boundary is deliberately the *same constant* `addCaseToDataset` dedupes on. That
gives the feature a property worth stating out loud:

> **"Covered" means the dataset would reject this query as a duplicate.**

One threshold, one embedding model, two features that can never disagree with each other. If
someone recalibrates the constant, both move together.

### 7.3 Show the expected answer, and don't overclaim

Embedding similarity between a query and a case's *query* measures topical resemblance - it does
not prove the case tests the same behaviour. Two questions can be near-identical in phrasing
while the case's `expectedResults` asserts something else entirely.

So the result always shows the nearest case's expected answer next to its similarity, and the
verdict is phrased as evidence rather than judgment. The human makes the final call. Claiming
"covered" on phrasing alone is the one way this feature loses trust in a single interaction.

### 7.4 Batch mode: coverage against traffic that doesn't exist yet

The single-query probe generalises for free, and the generalisation is the valuable half. Paste
a list - a PRD's user stories, a support macro export, a compliance checklist, a launch spec -
and get a coverage report over questions production has *never seen*.

> *"We launch crypto withdrawals next month. Here are the 15 things users will ask. How much of
> that does our suite cover today?"* — **0 of 15.**

This is forward-looking coverage, and it solves the cold-start problem the rest of this plan
cannot: the topic map only knows the past, so a brand-new surface is invisible to it until it
has already shipped and started failing. Batch probe is the pre-launch gate.

### 7.5 Two dividends

**It seeds `declaredRisk` from real behaviour.** §4.6 asks who declares business criticality and
admits a human has to. Probe queries answer it implicitly: the scenarios people type in are the
ones they are worried about. Log them, and *"queries probed repeatedly that production has never
produced"* becomes a ranked candidate list for declared risk - inferred from what the team
actually fears, not from an LLM guessing at topic labels.

**A gap flows straight into generation.** A "not covered" verdict with traffic nearby is one
click from §6: if real traces sit near the query, curate those (real user language, always
preferred, ranked by the MMR selection already specified); if none do, pass the query itself to
`generateSyntheticCases` as guidance. Same preview -> human -> append landing path, nothing new.

### 7.6 Why this ships in Phase 0

The probe needs **no clustering, no sweep, no topic layer** - only case embeddings and one query
embedding. It works on day one, before `insight_topics` exists, degrading to "nearest cases, no
traffic context" (and saying so).

That makes it the best Phase 0 deliverable in the plan: it is the moment the whole idea becomes
tangible to someone who has not read this document. A coverage percentage is an assertion a
reader has to take on faith. Typing *"what happens if a customer asks to close their account
while a refund is pending"* and getting back **"nothing in your dataset is within 0.4 of this"**
is a demonstration.

```
POST /insights/probe        { query }            -> verdict, nearest cases, topic, traffic, adequacy
POST /insights/probe/batch  { queries[] }        -> the same per query, plus a rollup
```

## 8. Ideas worth doing that the obvious version misses

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

## 9. Shape of the code

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
- `insight_topics.declaredRisk` - the human-owned business criticality (§4.6). The only
  hand-editable field in the whole feature; everything else is derived, which is why it needs a
  real owner and an edit route rather than a config file.
- `insight_case_meta` - per (datasetId, caseKey): `groundTruthConfidence`, its component flags,
  `addedAt`, `lastRunAt`. Separate from `insight_case_embeddings` because confidence changes when
  a review lands, while the embedding only changes when the text does - different write
  frequencies, different invalidation.
- `insight_settings` - per project: `customerKey` (the `traces.metadata` key holding customer
  identity, §4.3), adequacy factor weights, coverage thresholds. Weights must be inspectable and
  editable, or the composite score is a black box nobody trusts.

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
| `POST /insights/probe` | calibrated verdict for one query: nearest cases, topic, traffic, adequacy |
| `POST /insights/probe/batch` | the same per query, plus a rollup - the pre-launch gate |
| `POST /insights/recompute` | force the sweep |

Zod schemas go in `contract/wire.ts` alongside the existing monitor schemas - the
dashboard (`AgentX-eval-front`, separate private repo) consumes that contract, so the
wire shape needs to be settled in this plan's review, before UI work starts.

## 10. Phasing

**Phase 0 - the screen, and the probe.** *(shipped, engine + dashboard)* Case embedding cache, string-grouped topics from
existing `intent` values, count-based coverage, three headline tiles, topic map states,
per-topic panel - plus the single-query and batch **probe** (§7), which needs none of the
topic machinery and is the fastest way to make the idea tangible. Ships the mockup. No
clustering, no sweep. Proves the concept and settles the wire contract.

**Phase 1 - real topics.** *(synonym merging shipped early - see §3.1; the rest outstanding.)*
Consolidation sweep, centroids, soft assignment,
facility-location coverage, sub-mode analysis, and the full attribute row (§4.3) including
unique-session weighting. The numbers become defensible.

**Phase 1.5 - adequacy.** `declaredRisk` and its edit route, ground-truth confidence, the
six-factor adequacy score with its geometric-mean combination, and the presence-vs-quality
honesty delta. Worth its own phase rather than folding into Phase 1: it is the step that turns
three plausible percentages into three defensible ones, and it is where a rushed combination rule
would quietly poison every number downstream.

**Phase 2 - the flywheel.** Generation briefs, MMR trace selection, topic-grounded
synthesis, marginal-coverage-per-case ranking. Insights starts producing work, not just
describing it.

**Phase 3 - the moat.** Snapshots and deltas, drift attribution, novelty alerts,
Good-Turing unknown mass, CI coverage gate.

Each phase is independently shippable and each one leaves the product better than it
found it.

## 11. Open questions - still open

Phase 0 shipped without settling these; each one is now a decision about what Phase 1 does,
not a blocker. #1 and #5 are the two that would change the schema.

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
5. **Who owns `declaredRisk`?** It is the one field a human must set, and the whole
   risk-weighted number depends on it. Seeding it from an LLM pass over topic labels gets a
   usable default on day one, but if nobody ever corrects it the feature is ranking danger by
   guess. Does it belong to whoever owns the agent, or does it need a review step?
6. **Adequacy weights: shipped default or per-project?** Six factors need six weights. A fixed
   default is legible and comparable across projects; per-project weights are honest about
   differing priorities but make two teams' 68% incomparable. Recommendation: ship one default,
   make it visible, allow override later.
7. **Naming.** "Insights" is generic and `attention.ts` already owns the word `insight`
   for its one-line digest. *Coverage*, *Gaps*, or *Dataset Fit* are all sharper. Worth
   deciding before it reaches the wire contract and becomes hard to rename.
