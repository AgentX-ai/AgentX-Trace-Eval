import type { Db } from "../../storage/db.js";
import { getProfile } from "./profiles.js";

// Self-host has no agent registry: an "agent" here is just the set of distinct names traces
// have been ingested under (routes/ingest.ts's POST /traces uses the trace's `name` as the
// agentId Monitor signals/profiles are scoped to, see detect.ts/signals.ts). Matches
// AgentX-web-front's AgentMonitoringSelectableAgent contract (src/types/agentMonitoring.ts): no
// teams either, so `kind` is always "agent" and `monitoringAgentId` always equals `_id` (the
// team/manager-agent distinction that field exists for on the hosted SaaS doesn't apply here).
export async function listAgentsWire(db: Db) {
  const rows =
    db.kind === "sqlite"
      ? db.db.select({ name: db.schema.traces.name }).from(db.schema.traces).all()
      : await db.db.select({ name: db.schema.traces.name }).from(db.schema.traces);
  const names = Array.from(new Set(rows.map(r => r.name))).sort();

  return Promise.all(
    names.map(async name => ({
      _id: name,
      name,
      kind: "agent" as const,
      // Every agent self-host knows about arrived via the SDK, never AgentX's own native
      // agent-builder, so this is always "external" (matches the dashboard's "External" badge).
      agentType: "external" as const,
      monitoringAgentId: name,
      monitoringProfile: await getProfile(db, name),
    }))
  );
}
