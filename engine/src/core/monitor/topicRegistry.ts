import { nanoid } from "nanoid";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../storage/db.js";
import { cosine, normalizeText } from "../shared/vector.js";
import { logger } from "../../log.js";

// The topic registry: stable identities for the subjects the classifier keeps seeing, resolved at
// WRITE time instead of re-derived from free-text `intent` strings on every read.
//
// What this replaces. Topics were the distinct `intent` values in monitor_classifications, and
// because an LLM writing a free-text label drifts ("refund request" / "request a refund"), every
// reader had to clean up after it: core/insights/coverage.ts merges synonymous labels by centroid
// at read time, and its own comment records the bill for not doing this earlier - an install
// reporting "Refund request" covered and "Request a refund" MISSING, one topic counted twice with
// half of it a phantom gap. That merge stays (it is the only thing that can help rows written
// before this table existed), but from here on the duplicate is prevented rather than repaired.
//
// Why a label the classifier reused is not enough. topics.ts asks the model, in words, to return
// an existing label verbatim when one fits. That is a request, not a constraint, and the drift
// above is what it looks like when the model declines. A registry turns the vocabulary into data,
// which is also the precondition for a closed-set classifier that literally cannot answer outside
// it - see docs/topic-registry-and-system-one-classification.md.

export type TopicStatus = "candidate" | "active" | "retired";

export type TopicRow = {
  id: string;
  projectId: string | null;
  label: string;
  normalizedLabel: string;
  description: string | null;
  status: string;
  aliases: unknown;
  centroidSum: unknown;
  memberCount: number;
  embeddedMemberCount: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
};

// Cosine at or above which two topics are the same subject. Calibrated in
// docs/insights-topic-coverage-plan.md §3.1 against a real install's centroids:
//
//   refund request / request a refund              0.909  must merge
//   reset password / reset forgotten password      0.902  must merge
//   order tracking / missing package               0.822  must NOT
//   refund policy inquiry / request a refund       0.813  must NOT
//
// ~0.05 of margin either side. Deliberately not curation.ts's 0.75, which compares two single
// query strings; these are centroids of averaged input+output embeddings and run much higher.
//
// Lives here rather than in coverage.ts (which owned it first) so the write-time and read-time
// merges cannot drift apart - shared/vector.ts's header makes the same point about cosine itself:
// two paths asking one question must not answer it with two different formulas.
export const TOPIC_MERGE_THRESHOLD = 0.87;

// Sightings before a candidate becomes part of the vocabulary. Two jobs, and the second is the
// reason it is not 1:
//
// 1. One strange trace must not mint a permanent topic. Novel labels are cheap to create and
//    expensive to retract, so a topic earns its place by recurring.
// 2. It buys the evidence the merge decision needs. A brand-new topic's "centroid" is one trace
//    embedding, and comparing THAT to an established centroid is the wrong threshold regime
//    entirely - a single member sits further from any centroid than two centroids sit from each
//    other, so 0.87 (calibrated centroid-to-centroid) would refuse merges it should make. Holding
//    a label as a candidate until it has accumulated members means the merge check at promotion
//    runs on the comparison the constant was actually measured for.
export const TOPIC_PROMOTION_SIGHTINGS = 3;

// How many topics a classifier prompt is shown as reuse candidates. Unchanged from the cap
// topics.ts applied to its old 30-day GROUP BY: the prompt stays small, and the vocabulary stays
// the things that actually recur.
export const TOPIC_CANDIDATE_LIMIT = 30;

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function asVector(value: unknown): number[] | null {
  return Array.isArray(value) && value.length > 0 && value.every(v => typeof v === "number")
    ? (value as number[])
    : null;
}

// Running sum of member embeddings, NOT their mean. Cosine is scale-invariant, so a sum compares
// identically to the unit centroid shared/vector.ts's centroid() would build from the same
// members - and unlike a mean, a sum is exact under incremental accumulation, so a topic never
// has to re-read its members to stay correct. Differing lengths truncate to the shortest, the
// same rule centroid() applies, because a length mismatch means two embedding models got mixed
// and padding zeros would drag the direction toward the origin.
function accumulate(sum: number[] | null, vector: number[]): number[] {
  if (!sum) {
    return [...vector];
  }
  const dims = Math.min(sum.length, vector.length);
  const next = sum.slice(0, dims);
  for (let i = 0; i < dims; i++) {
    next[i] = (next[i] ?? 0) + (vector[i] ?? 0);
  }
  return next;
}

async function listTopicRows(db: Db): Promise<TopicRow[]> {
  const cond = eq(db.schema.monitorTopics.projectId, db.projectId);
  const rows =
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.monitorTopics).where(cond).all()
      : await db.db.select().from(db.schema.monitorTopics).where(cond);
  return rows as TopicRow[];
}

/**
 * The vocabulary: topics that have earned their place, most-seen first. This is what a classifier
 * prompt offers as reuse candidates, and what a closed-set classifier would offer as options.
 *
 * Candidates are deliberately excluded - a label seen once is not yet a topic, and showing it as
 * a reuse candidate would promote it by suggestion before it ever recurred on its own.
 */
export async function listActiveTopics(db: Db, limit = TOPIC_CANDIDATE_LIMIT): Promise<TopicRow[]> {
  const rows = await listTopicRows(db);
  return rows
    .filter(row => row.status === "active")
    .sort((a, b) => b.memberCount - a.memberCount || a.label.localeCompare(b.label))
    .slice(0, limit);
}

export async function getTopic(db: Db, id: string): Promise<TopicRow | null> {
  const cond = and(eq(db.schema.monitorTopics.id, id), eq(db.schema.monitorTopics.projectId, db.projectId));
  const rows =
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.monitorTopics).where(cond).all()
      : await db.db.select().from(db.schema.monitorTopics).where(cond);
  return (rows as TopicRow[])[0] ?? null;
}

// Both arms are identical on purpose: drizzle's sqlite and pg query builders are separate generic
// overloads, so `db.db.update(...)` is not callable until db.kind narrows the union. Same idiom as
// core/evaluate/models.ts's clearDefaultPortabilityModel.
async function updateTopic(db: Db, id: string, patch: Partial<TopicRow>): Promise<void> {
  if (db.kind === "sqlite") {
    await db.db.update(db.schema.monitorTopics).set(patch).where(eq(db.schema.monitorTopics.id, id));
  } else {
    await db.db.update(db.schema.monitorTopics).set(patch).where(eq(db.schema.monitorTopics.id, id));
  }
}

// Absorb `from` into `into`: aliases, counts and centroid mass move over, the surviving row's
// window widens to cover both, and every classification already pointing at the loser is
// re-pointed. Re-pointing is the part that must not be skipped - a merged-away topic id left on
// historical rows is a dangling reference, and the history is the whole reason the registry
// carries counts at all.
async function mergeTopics(db: Db, from: TopicRow, into: TopicRow): Promise<TopicRow> {
  const fromSum = asVector(from.centroidSum);
  const intoSum = asVector(into.centroidSum);
  const mergedSum = fromSum && intoSum ? accumulate(intoSum, fromSum) : (intoSum ?? fromSum);
  const aliases = new Set(asStringArray(into.aliases));
  aliases.add(from.label);
  for (const alias of asStringArray(from.aliases)) {
    aliases.add(alias);
  }

  const merged: TopicRow = {
    ...into,
    aliases: [...aliases],
    centroidSum: mergedSum,
    memberCount: into.memberCount + from.memberCount,
    embeddedMemberCount: into.embeddedMemberCount + from.embeddedMemberCount,
    firstSeenAt: from.firstSeenAt < into.firstSeenAt ? from.firstSeenAt : into.firstSeenAt,
    lastSeenAt: from.lastSeenAt > into.lastSeenAt ? from.lastSeenAt : into.lastSeenAt,
  };

  await updateTopic(db, into.id, {
    aliases: merged.aliases,
    centroidSum: merged.centroidSum,
    memberCount: merged.memberCount,
    embeddedMemberCount: merged.embeddedMemberCount,
    firstSeenAt: merged.firstSeenAt,
    lastSeenAt: merged.lastSeenAt,
  });
  if (db.kind === "sqlite") {
    await db.db
      .update(db.schema.monitorClassifications)
      .set({ topicId: into.id })
      .where(eq(db.schema.monitorClassifications.topicId, from.id));
    await db.db.delete(db.schema.monitorTopics).where(eq(db.schema.monitorTopics.id, from.id));
  } else {
    await db.db
      .update(db.schema.monitorClassifications)
      .set({ topicId: into.id })
      .where(eq(db.schema.monitorClassifications.topicId, from.id));
    await db.db.delete(db.schema.monitorTopics).where(eq(db.schema.monitorTopics.id, from.id));
  }
  return merged;
}

// A candidate that has hit the sighting bar either becomes a topic in its own right, or turns out
// to be a second name for one that already exists. The check runs HERE, not at creation, for the
// threshold-regime reason on TOPIC_PROMOTION_SIGHTINGS: by now the candidate has a centroid built
// from several members, which is the comparison 0.87 was calibrated against.
//
// Merge targets are active topics only. A retired topic is out of the vocabulary on purpose and
// must not quietly collect new traffic by similarity - though it still absorbs its OWN label by
// exact match below, because retirement removes a topic from the menu, not from history.
async function promoteOrMerge(db: Db, topic: TopicRow, siblings: TopicRow[]): Promise<TopicRow> {
  const sum = asVector(topic.centroidSum);
  if (sum) {
    let best: { row: TopicRow; score: number } | null = null;
    for (const other of siblings) {
      if (other.id === topic.id || other.status !== "active") {
        continue;
      }
      const otherSum = asVector(other.centroidSum);
      if (!otherSum) {
        continue;
      }
      const score = cosine(sum, otherSum);
      if (score >= TOPIC_MERGE_THRESHOLD && (!best || score > best.score)) {
        best = { row: other, score };
      }
    }
    if (best) {
      logger.info(
        { from: topic.label, into: best.row.label, cosine: Number(best.score.toFixed(4)) },
        "topic registry: merged a candidate into an existing topic"
      );
      return mergeTopics(db, topic, best.row);
    }
  }
  await updateTopic(db, topic.id, { status: "active" });
  return { ...topic, status: "active" };
}

export type ResolveTopicInput = {
  /** The label the classifier wrote for this trace. */
  label: string;
  /**
   * The classification's input+output embedding - the SAME vector coverage.ts groups by, so the
   * merge threshold keeps comparing the thing it was calibrated on. Null whenever embeddings are
   * unavailable (no OPENAI_API_KEY, or the call failed), which degrades resolution to exact label
   * and alias matching: still correct, just blind to synonyms.
   */
  embedding: number[] | null;
  /** Defaults to now; injectable so tests and backfills can write at a chosen time. */
  now?: Date;
};

/**
 * Resolve a classifier label to a stable topic, creating or merging as needed, and return the
 * topic the caller should record. Never throws: a registry failure must not cost the caller its
 * classification, which is still perfectly usable with a null topicId (every reader falls back to
 * the free-text `intent`), so failures log and return null.
 *
 * Resolution order, most certain evidence first:
 *   1. exact normalized label  - the same words are the same topic, always
 *   2. a recorded alias        - a label that merged in once resolves by lookup, not by cosine
 *   3. create a candidate      - and let promoteOrMerge decide later what it really is
 */
export async function resolveTopic(db: Db, input: ResolveTopicInput): Promise<TopicRow | null> {
  const label = input.label.trim();
  const normalized = normalizeText(label);
  if (!normalized) {
    return null;
  }
  const now = input.now ?? new Date();
  const embedding = input.embedding && input.embedding.length > 0 ? input.embedding : null;

  try {
    const rows = await listTopicRows(db);
    const existing =
      rows.find(row => row.normalizedLabel === normalized) ??
      rows.find(row => asStringArray(row.aliases).some(alias => normalizeText(alias) === normalized));

    if (existing) {
      const embeddedMemberCount = existing.embeddedMemberCount + (embedding ? 1 : 0);
      const centroidSum = embedding ? accumulate(asVector(existing.centroidSum), embedding) : existing.centroidSum;
      const seen: TopicRow = {
        ...existing,
        centroidSum,
        memberCount: existing.memberCount + 1,
        embeddedMemberCount,
        lastSeenAt: now,
      };
      await updateTopic(db, existing.id, {
        centroidSum: seen.centroidSum,
        memberCount: seen.memberCount,
        embeddedMemberCount: seen.embeddedMemberCount,
        lastSeenAt: seen.lastSeenAt,
      });
      // Promotion is checked on every sighting rather than only on the Nth, so a candidate that
      // crossed the bar while embeddings were unavailable still promotes once one arrives.
      if (seen.status === "candidate" && seen.memberCount >= TOPIC_PROMOTION_SIGHTINGS) {
        return await promoteOrMerge(db, seen, rows);
      }
      return seen;
    }

    const created: TopicRow = {
      id: nanoid(),
      projectId: db.projectId,
      label,
      normalizedLabel: normalized,
      description: null,
      status: "candidate",
      aliases: [],
      centroidSum: embedding ? [...embedding] : null,
      memberCount: 1,
      embeddedMemberCount: embedding ? 1 : 0,
      firstSeenAt: now,
      lastSeenAt: now,
    };
    try {
      if (db.kind === "sqlite") {
        await db.db.insert(db.schema.monitorTopics).values(created);
      } else {
        await db.db.insert(db.schema.monitorTopics).values(created);
      }
      return created;
    } catch (err) {
      // Lost the race on monitor_topics_project_label: another trace classified at the same
      // instant coined the same label first. Its row is the truth - recurse once to take the
      // existing-topic path against it, rather than failing a classification over a collision the
      // unique index exists precisely to make harmless.
      const winner = (await listTopicRows(db)).find(row => row.normalizedLabel === normalized);
      if (!winner) {
        throw err;
      }
      return await resolveTopic(db, input);
    }
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : err, label }, "Topic resolution failed:");
    return null;
  }
}
