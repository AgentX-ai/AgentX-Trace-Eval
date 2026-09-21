import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import { openTestDb, type TestDb } from "./dbHarness.js";
import type { Db } from "../storage/db.js";
import {
  TOPIC_MERGE_THRESHOLD,
  TOPIC_PROMOTION_SIGHTINGS,
  getTopic,
  listActiveTopics,
  resolveTopic,
  type TopicRow,
} from "../core/monitor/topicRegistry.js";

// The registry is a pure function of one small table, and resolveTopic takes the embedding as an
// argument rather than computing one - so unlike the coverage tests next door, nothing here needs
// the embedder mocked. Vectors are injected directly, on a unit circle whose cosines are exactly
// cos(angle difference), which makes every threshold assertion arithmetic instead of a guess about
// what an embedding model will do that day.

let test: TestDb;
let db: Db;

/** A unit vector at `angle` radians, padded to 4 dimensions so nothing depends on dimensionality. */
const unit = (angle: number): number[] => [Math.cos(angle), Math.sin(angle), 0, 0];

// acos(0.87) is ~0.5156 rad, so the merge decision turns at ~29.5 degrees of separation.
// 0.30 rad is cos ~= 0.955 (must merge); 0.90 rad is cos ~= 0.622 (must not). Both sit far enough
// from the boundary that a change to TOPIC_MERGE_THRESHOLD would have to be drastic to flip them,
// and the two guard assertions below fail loudly if it ever is.
const SYNONYM = 0.3;
const DISTINCT = 0.9;

/** Resolves `label` n times, as n separate traces would - the only way a topic accumulates. */
async function sight(label: string, angle: number | null, times = 1): Promise<TopicRow | null> {
  let last: TopicRow | null = null;
  for (let i = 0; i < times; i++) {
    last = await resolveTopic(db, { label, embedding: angle === null ? null : unit(angle) });
  }
  return last;
}

// Project-scoped on purpose: the harness's database also carries the seeded example project, and
// every case below runs against its own project in the same file.
async function countTopics(): Promise<number> {
  const cond = eq(db.schema.monitorTopics.projectId, db.projectId);
  const rows =
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.monitorTopics).where(cond).all()
      : await db.db.select().from(db.schema.monitorTopics).where(cond);
  return rows.length;
}

beforeAll(async () => {
  test = await openTestDb();
});

afterAll(async () => {
  await test.close();
});

describe("topic registry", () => {
  beforeAll(async () => {
    db = test.scoped(await test.newProject("Registry"));
  });

  it("gives one identity to labels differing only in casing and whitespace", async () => {
    const scoped = test.scoped(await test.newProject("Identity"));
    const previous = db;
    db = scoped;
    try {
      const first = await sight("Refund request", 0);
      const second = await sight("  refund   REQUEST ", 0);

      expect(first?.id).toBeTruthy();
      expect(second?.id).toBe(first?.id);
      expect(second?.memberCount).toBe(2);
      // The display label stays as first written, not overwritten by the sloppier spelling.
      expect(second?.label).toBe("Refund request");
      expect(await countTopics()).toBe(1);
    } finally {
      db = previous;
    }
  });

  it("holds a new label as a candidate until it recurs, then promotes it", async () => {
    const scoped = test.scoped(await test.newProject("Promotion"));
    const previous = db;
    db = scoped;
    try {
      const once = await sight("order tracking", 0);
      expect(once?.status).toBe("candidate");
      // A label seen once is not yet vocabulary - offering it as a reuse candidate would promote
      // it by suggestion before it ever recurred on its own.
      expect(await listActiveTopics(db)).toEqual([]);

      const promoted = await sight("order tracking", 0, TOPIC_PROMOTION_SIGHTINGS - 1);
      expect(promoted?.status).toBe("active");
      expect(promoted?.memberCount).toBe(TOPIC_PROMOTION_SIGHTINGS);
      expect((await listActiveTopics(db)).map(t => t.label)).toEqual(["order tracking"]);
    } finally {
      db = previous;
    }
  });

  it("merges a synonym into the established topic instead of promoting it", async () => {
    const scoped = test.scoped(await test.newProject("Merge"));
    const previous = db;
    db = scoped;
    try {
      const established = await sight("refund request", 0, TOPIC_PROMOTION_SIGHTINGS);
      expect(established?.status).toBe("active");

      // A second label for the same subject: different words, neighbouring vectors.
      const synonym = await sight("request a refund", SYNONYM, TOPIC_PROMOTION_SIGHTINGS);

      // Guard the geometry the assertion below depends on, so a threshold change fails here with
      // an explanation rather than as a mystery in the merge assertion.
      expect(Math.cos(SYNONYM)).toBeGreaterThanOrEqual(TOPIC_MERGE_THRESHOLD);

      expect(synonym?.id).toBe(established?.id);
      expect(await countTopics()).toBe(1);
      expect(synonym?.aliases).toContain("request a refund");
      // Both labels' traffic counts toward one topic - the phantom-gap bug this table exists to
      // prevent was exactly this total being split across two rows.
      expect(synonym?.memberCount).toBe(TOPIC_PROMOTION_SIGHTINGS * 2);
    } finally {
      db = previous;
    }
  });

  it("keeps a merged-away label resolving to the survivor by alias, without cosine", async () => {
    const scoped = test.scoped(await test.newProject("Alias"));
    const previous = db;
    db = scoped;
    try {
      const established = await sight("refund request", 0, TOPIC_PROMOTION_SIGHTINGS);
      await sight("request a refund", SYNONYM, TOPIC_PROMOTION_SIGHTINGS);

      // No embedding this time: if the alias were not recorded, this would mint a new topic.
      const again = await sight("request a refund", null);
      expect(again?.id).toBe(established?.id);
      expect(await countTopics()).toBe(1);
    } finally {
      db = previous;
    }
  });

  it("does not merge neighbouring topics that are genuinely different questions", async () => {
    const scoped = test.scoped(await test.newProject("Distinct"));
    const previous = db;
    db = scoped;
    try {
      await sight("order tracking", 0, TOPIC_PROMOTION_SIGHTINGS);
      const other = await sight("missing package", DISTINCT, TOPIC_PROMOTION_SIGHTINGS);

      expect(Math.cos(DISTINCT)).toBeLessThan(TOPIC_MERGE_THRESHOLD);
      expect(other?.status).toBe("active");
      expect(await countTopics()).toBe(2);
      expect((await listActiveTopics(db)).map(t => t.label).sort()).toEqual(["missing package", "order tracking"]);
    } finally {
      db = previous;
    }
  });

  it("re-points existing classifications when their topic is merged away", async () => {
    const scoped = test.scoped(await test.newProject("Repoint"));
    const previous = db;
    db = scoped;
    try {
      const survivor = await sight("refund request", 0, TOPIC_PROMOTION_SIGHTINGS);

      // Two sightings of the synonym, each recorded on a classification row the way
      // runClassification would, then the third that triggers the merge.
      const doomed = await sight("request a refund", SYNONYM);
      const classificationId = nanoid();
      const row = {
        id: classificationId,
        traceId: nanoid(),
        agentId: null,
        intent: "request a refund",
        sentiment: "neutral",
        issueType: "none",
        createdAt: new Date(),
        projectId: db.projectId,
        embedding: unit(SYNONYM),
        inputEmbedding: null,
        topicId: doomed?.id ?? null,
      };
      if (db.kind === "sqlite") {
        await db.db.insert(db.schema.monitorClassifications).values(row);
      } else {
        await db.db.insert(db.schema.monitorClassifications).values(row);
      }

      await sight("request a refund", SYNONYM, TOPIC_PROMOTION_SIGHTINGS - 1);

      expect(await getTopic(db, doomed!.id)).toBeNull();
      const cond = eq(db.schema.monitorClassifications.id, classificationId);
      const rows =
        db.kind === "sqlite"
          ? db.db.select().from(db.schema.monitorClassifications).where(cond).all()
          : await db.db.select().from(db.schema.monitorClassifications).where(cond);
      // A merged-away id left behind on history would be a dangling reference, and the history is
      // the whole reason the registry carries counts.
      expect((rows as { id: string; topicId: string | null }[])[0]?.topicId).toBe(survivor?.id);
    } finally {
      db = previous;
    }
  });

  it("still resolves and promotes with no embeddings at all", async () => {
    const scoped = test.scoped(await test.newProject("NoEmbeddings"));
    const previous = db;
    db = scoped;
    try {
      // What an install with no OPENAI_API_KEY looks like: labels still get stable identities,
      // the registry is just blind to synonyms it cannot see.
      const topic = await sight("password reset", null, TOPIC_PROMOTION_SIGHTINGS);
      expect(topic?.status).toBe("active");
      expect(topic?.centroidSum).toBeNull();
      expect(topic?.embeddedMemberCount).toBe(0);
      expect(topic?.memberCount).toBe(TOPIC_PROMOTION_SIGHTINGS);

      const synonym = await sight("reset my password", null, TOPIC_PROMOTION_SIGHTINGS);
      expect(synonym?.id).not.toBe(topic?.id);
      expect(await countTopics()).toBe(2);
    } finally {
      db = previous;
    }
  });

  it("promotes a candidate that only becomes embeddable later", async () => {
    const scoped = test.scoped(await test.newProject("LateEmbedding"));
    const previous = db;
    db = scoped;
    try {
      // The key gets configured partway through: promotion is checked on every sighting, not only
      // the Nth, so a candidate already past the bar promotes on its next one.
      const blind = await sight("billing question", null, TOPIC_PROMOTION_SIGHTINGS);
      expect(blind?.status).toBe("active");

      const withVector = await sight("billing question", 0);
      expect(withVector?.embeddedMemberCount).toBe(1);
      expect(withVector?.centroidSum).toEqual(unit(0));
    } finally {
      db = previous;
    }
  });

  it("ignores an empty label rather than minting a nameless topic", async () => {
    const scoped = test.scoped(await test.newProject("Empty"));
    const previous = db;
    db = scoped;
    try {
      expect(await sight("   ", 0)).toBeNull();
      expect(await countTopics()).toBe(0);
    } finally {
      db = previous;
    }
  });

  it("keeps one project's vocabulary out of another's", async () => {
    const a = test.scoped(await test.newProject("TenantA"));
    const b = test.scoped(await test.newProject("TenantB"));
    const previous = db;
    try {
      db = a;
      const inA = await sight("refund request", 0, TOPIC_PROMOTION_SIGHTINGS);
      db = b;
      const inB = await sight("refund request", 0, TOPIC_PROMOTION_SIGHTINGS);

      // Same label, same vectors, two projects: the unique index is project-scoped, so these are
      // two topics and neither project's list can see the other's.
      expect(inB?.id).not.toBe(inA?.id);
      expect((await listActiveTopics(b)).map(t => t.id)).toEqual([inB?.id]);
      expect((await listActiveTopics(a)).map(t => t.id)).toEqual([inA?.id]);
    } finally {
      db = previous;
    }
  });
});
