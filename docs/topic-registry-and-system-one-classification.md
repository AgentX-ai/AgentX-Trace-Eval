# Topic registry, and two-stage classification with a System One model

**Status:** Phase 1 (the registry) is implemented in this change. Phase 2 (the System One decider)
is design. The two ship separately on purpose — the registry is worth having on its own, and it is
the precondition for the decider, which cannot exist without a stable option set to choose from.

| Shipped here | Where |
|---|---|
| `monitor_topics` table, both dialects | `engine/src/storage/schema.sqlite.ts`, `schema.pg.ts`, `storage/db.ts` |
| `monitor_classifications.topic_id` | same |
| Resolution, promotion, write-time merge | `engine/src/core/monitor/topicRegistry.ts` |
| Classifier wiring + registry-backed candidates | `engine/src/core/monitor/topics.ts` |
| Shared merge threshold | `engine/src/core/insights/coverage.ts` imports it now |
| Backup coverage | `engine/src/core/export/exportData.ts` |
| Tests | `engine/src/test/topicRegistry.integration.test.ts` |

## 1. The problem

Topics classifies a sampled trace into `{intent, sentiment, issueType}` (`core/monitor/topics.ts`'s
`runClassification`). Two of those three are already small enums. The third, `intent`, is free text,
and the prompt asks the model — in words — to reuse an existing label verbatim when one fits.

That is a request, not a constraint, and the drift it fails to prevent has a measured cost.
`core/insights/coverage.ts` had to grow a read-time merge because a real install carried both
"Refund request" (7 cases, reported covered) and "Request a refund" (0 cases, reported **missing**):
one topic counted twice, half of it a phantom gap, its traffic share split down the middle. Same for
"Reset Password" / "Reset forgotten password".

There are three more costs behind that one:

- **The vocabulary was a query, not a table.** Topics were the distinct `intent` strings in a rolling
  30-day `GROUP BY`, recomputed *on every classified trace*. It scans the whole window, so it grows
  with traffic, and a topic that goes quiet for 31 days silently drops out of the candidate list and
  gets re-coined under a new name.
- **Nothing could hold the vocabulary still.** Every reader had to defend itself against synonyms.
- **The whole feature is gated on LLM spend.** `topicsEnabled` defaults to **false**, and the file's
  own header explains why: "real LLM spend per sampled trace." A frontier model is being paid to pick
  an item from a list.

## 2. The shape of the fix

Two stages, each doing the thing it is actually good at:

| Stage | Job | Called |
|---|---|---|
| **Decider** | Pick from the known vocabulary; rate sentiment and issue type | Every classified trace |
| **Author** | Coin a label for something the vocabulary has no word for | Only on novelty |

The LLM stops being the classifier and becomes the **vocabulary author**, invoked at the frontier of
what the taxonomy does not yet cover. On mature traffic that is a small and shrinking fraction.

This only works if "the known vocabulary" is a real thing a decider can be handed. Today it is a
`GROUP BY`. Phase 1 makes it a table.

## 3. Phase 1: the registry (shipped)

One row per subject the classifier has seen. `monitor_classifications.intent` stays exactly as the
model wrote it; `topic_id` is the stable identity beside it, so nothing that reads `intent` today
changes behaviour and rows written before the registry keep working.

### Resolution order

Most certain evidence first (`resolveTopic`):

1. **Exact normalized label.** The same words are the same topic, always.
2. **A recorded alias.** A label that merged in once resolves by lookup, never by cosine again.
3. **Create a candidate.** And let promotion decide later what it really is.

### Promotion, and why the merge waits for it

A new label enters as `candidate` and becomes `active` after `TOPIC_PROMOTION_SIGHTINGS` (3) sightings.
Only active topics are offered as reuse candidates, so one strange trace cannot mint permanent
vocabulary.

The less obvious job of that staging state is **buying the evidence the merge decision needs.**

The obvious design is to merge at creation: embed the incoming trace, compare it to every existing
topic centroid, reuse the nearest above threshold. That is the wrong comparison. `TOPIC_MERGE_THRESHOLD`
(0.87) was calibrated **centroid-to-centroid** — averaged vectors against averaged vectors:

| pair | cosine | verdict |
|---|---|---|
| refund request / request a refund | 0.909 | must merge |
| reset password / reset forgotten password | 0.902 | must merge |
| order tracking / missing package | 0.822 | must **not** |
| refund policy inquiry / request a refund | 0.813 | must **not** |

A single member sits further from a centroid than two centroids sit from each other, because a
centroid has averaged the noise out and one trace has not. Feeding a lone trace vector into a
threshold measured on centroids would refuse merges it should make — and lowering the threshold to
compensate would start merging "order tracking" into "missing package", which are different
questions with different correct answers.

So the merge check runs at **promotion**, where the candidate has accumulated several members and
the comparison is the one the constant was measured for. Merge targets are active topics only: a
retired topic is out of the vocabulary deliberately and must not quietly collect traffic by
similarity, though it still absorbs its own label by exact match, because retirement removes a topic
from the menu, not from history.

When a candidate merges, the survivor takes its aliases, counts and centroid mass, and every
classification pointing at the loser is re-pointed before the loser is deleted.

### Two implementation notes

**The centroid column stores a running sum, not a mean.** Cosine is scale-invariant, so a sum
compares identically to the unit centroid `shared/vector.ts`'s `centroid()` would build from the same
members — and unlike a mean, a sum is exact under incremental accumulation, so a topic never has to
re-read its members to stay correct.

**The threshold now lives in one place.** `topicRegistry.ts` owns it and `coverage.ts` imports it.
Two merges keyed on one number must read it from one place, or an install ends up disagreeing with
itself about how many topics it has.

### What upgrading looks like

An install with history but an empty registry starts with a short candidate list, and the model
drifts for a few traces. That is self-healing rather than permanent: each label becomes a candidate,
and promotion folds the synonyms back together on centroid evidence once they recur. A one-time
backfill from existing classifications would shorten that window and is worth doing if anyone feels
it; it is not required for correctness.

## 4. Phase 2: the System One decider (design)

[Jev](https://openrouter.ai/typesafe/jev-1.13) (TypeSafe AI, `jev-1.13.0`, aliases `jev-latest` /
`jev-preview`) is a *System One* model: it takes unstructured state plus typed questions and returns
**calibrated probabilities over a predefined answer set**. It generates no text at all.

| | Jev |
|---|---|
| Endpoint | `POST https://api.typesafe.ai/v1/systemone`, body `{model, state, questions}` |
| Question types | `noul` (yes/no probability), `choice` (enum + probabilities + confidence), `score` (scale + legend + probabilities + confidence) |
| Batching | All questions answered in one request, in parallel, against one state |
| Context | 64K per request; 32K for state plus the single longest question |
| Cost / latency | ~$0.042/M input, **$0 output**; 70–500ms |
| Text output | **None.** No labels, no justifications, no explanations |

Topics is a closed-set classification problem whose output contains no prose. That is Jev's design
target, not an adaptation of it.

### The call

One request per trace, carrying all three questions:

```
state: <trace input + output, truncated to the state budget>
questions:
  topic:      { type: "choice", options: [...active topics..., "none_of_these"] }
  sentiment:  { type: "choice", options: [positive, neutral, negative] }
  issue_type: { type: "choice", options: [none, refusal, hallucination, off_topic, incomplete, other] }
```

Then:

- **Confident topic** → record it. No LLM call.
- **`none_of_these`, low confidence, or mass split across two topics** → call the platform model, and
  narrow its job to coining the label. Sentiment and issue type already came back calibrated.

`choice` makes label reuse a **hard constraint** rather than a prompt instruction. The drift that
forced read-time merging becomes structurally impossible for anything the decider handles: the model
cannot emit a label that is not in the option set.

### Narrowing a growing vocabulary

`choice` over 200 topics is both a calibration problem and a state-budget problem. The registry
already stores centroids and classifications already carry embeddings, so the natural narrowing is
kNN: retrieve the ~20 nearest topics by cosine, then let the decider choose among those. Retrieval by
vector, decision by calibrated classifier, generation only for novelty.

### Engine work it needs

Jev is **not** OpenAI-compatible, including through OpenRouter — it answers on
`POST /api/alpha/decisions` there, and `chat/completions` returns HTTP 400 for the slug. That matters
concretely: `resolveModelRouting` (`core/evaluate/judge.ts`) routes any model id containing a slash to
the OpenRouter client over chat completions, so typing `typesafe/jev-latest` into any model field
today produces a 400 on every call. A `systemone` transport is required — it cannot be configured in.

Sketch, smallest first:

1. `packages/judge-core`: `callSystemOne({state, questions, client})` beside `callJudgeJson`. Plain
   `fetch`, no SDK, same `{payload, usage, error, failureReason}` result type so caller error handling
   is unchanged.
2. `core/settings/appSettings.ts`: a `typesafeApiKey`. It must go in the `FLAGS` array as well as the
   type and the patch — the comment there records that a key column missing from that list is
   silently destroyed by settings consolidation.
3. `core/evaluate/judge.ts`: a cached client (same idiom as `getGemini`), `ModelRouting` widened with
   a `systemone` transport, branching **before** the slash rule.
4. Metering stays inside `callJudgeJson`'s `checkAndRecordJudgeCall`, so Jev calls still count against
   daily quota and the ledger. Cheap is not free.

## 5. What it costs, and what it does not save

Illustrative arithmetic on a 2,000-token trace, per 1,000 classified traces:

| | per 1k traces |
|---|---|
| Decider (Jev, ~$0.042/M in, $0 out) | **~$0.08** |
| Platform LLM classifier at $2.50/M in | ~$5.00 |
| Two embedding calls (`text-embedding-3-small`, $0.02/M) | ~$0.08 |

Two honest readings of that table:

- The classification call stops being the reason Topics is opt-in.
- **The embeddings do not go away, and they become the dominant hot-path cost.** `runClassification`
  makes two `computeEmbedding` calls per trace, they are OpenAI-only, and the Map view, the coverage
  map and the registry's own merge all depend on them. "Topics on by default at 100%" is a decision
  about embeddings at least as much as about the classifier.

## 6. Guards, and how we would prove it

**Guards on vocabulary growth** — shipped in Phase 1, and the reason novelty escalation does not
recreate the drift from the other end: candidate staging (a label earns its place by recurring) and
write-time merging (a synonym folds into the topic it duplicates).

**Shadow first.** Run the decider alongside the LLM classifier on the same traces and compare before
flipping. Note that `core/monitor/agreement.ts`'s Krippendorff implementation is binary-only, so
multi-class agreement needs a small extension — or start with raw agreement plus a per-class confusion
matrix and add the chance correction after.

**Calibrated is not correct.** Jev's confidence measures how concentrated its probabilities are, not
whether the answer is right. It is a good routing signal and a bad proof, which is exactly why the
rollout gates on agreement against human labels rather than on the model's own confidence.

**Cold start.** An empty registry sends every trace to the LLM path. The savings curve starts at zero
and climbs as the vocabulary fills.

**State budget.** `JSON.stringify` of a fat trace payload can exceed 32K on its own. Truncation is
required, and the current path does not do it.

## 7. Relationship to `insights-topic-coverage-plan.md`

That plan's §3.1 proposes an `insight_topics` table built by a **post-hoc consolidation sweep** that
clusters classification embeddings. This supersedes the table, not the goal: `monitor_topics` is the
same entity (stable id, label, aliases, centroid, counts) populated **at write time** by the classifier
instead of by a sweep, which is the only point where a duplicate can be prevented rather than repaired.

Still open from that plan and unaffected here: full agglomerative clustering, per-topic radius/spread,
and soft (softmax) assignment. `coverage.ts`'s `groupByIntent` / `mergeSynonymousTopics` stays as-is —
it is the only thing that can help rows written before this table existed.

## 8. Open questions

- **Backfill the registry from existing classifications on first boot?** Shortens the upgrade window;
  costs a one-time pass over the classification table.
- **Who writes `description`?** The column exists and nothing fills it. A `choice` option classifies
  better with a sentence than with a bare label, and the natural author is the same LLM that coined
  the label — one extra sentence on a call that is already happening.
- **Does `topicId` replace `intent` for readers, and when?** Phase 1 is deliberately additive. Moving
  `getTopIntents`, the Topics tab and coverage onto `topicId` is a separate, mechanical change that
  should not ride along with the schema.
- **Sentiment and issue type are already enums.** They could move to the decider before the topic
  question does, which would be a smaller and lower-risk first cut than the full two-stage flow.
