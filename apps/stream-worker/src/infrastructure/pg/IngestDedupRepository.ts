/**
 * IngestDedupRepository — ADR-0012 durable event_id dedup gate (data_plane.ingest_dedup).
 *
 * The connector emit path (shiprocket re-pull, backfill, retry, replay) re-derives the SAME
 * deterministic event_id for a given logical event, so one rule — "have I already ingested this
 * event_id?" — collapses every duplicate source. These two helpers are the read + write halves of
 * that rule, run at the ingest boundary BEFORE the Kafka produce:
 *
 *   1. filterUnseenEventIds — which of these ids have NOT been ingested yet (the ones to produce).
 *   2. markEventIdsSeen     — record the ids we DID produce (INSERT … ON CONFLICT DO NOTHING).
 *
 * ORDER IS CRITICAL at the call site: produce FIRST, mark AFTER. A crash between produce and mark at
 * worst re-produces a dup on job retry (Silver's per-lane dedup backstops it) — it NEVER loses an
 * event. Marking before producing would be the unsafe order (a crash would drop the event forever).
 *
 * Both helpers take a `pg` PoolClient that ALREADY carries the brand GUC (app.current_brand_id) —
 * ingest_dedup has FORCE RLS, so the caller MUST set_config the brand context first (see the emit
 * site in shiprocket-shipment-repull/run.ts). brand_id is passed explicitly for the equality
 * predicate and is ALWAYS the connector's enumerated brand (MT-1) — never from env or payload.
 */
import type { PoolClient } from 'pg';

/**
 * Return the subset of `eventIds` that have NOT yet been ingested for this brand (the NEW ones).
 * Empty input → empty set (no query). The result preserves the input ids; it never invents ids.
 */
export async function filterUnseenEventIds(
  client: PoolClient,
  brandId: string,
  eventIds: string[],
): Promise<Set<string>> {
  if (eventIds.length === 0) return new Set<string>();

  const result = await client.query<{ event_id: string }>(
    `SELECT event_id FROM data_plane.ingest_dedup
     WHERE brand_id = $1 AND event_id = ANY($2::uuid[])`,
    [brandId, eventIds],
  );

  const seen = new Set<string>(result.rows.map((r) => r.event_id));
  return new Set<string>(eventIds.filter((id) => !seen.has(id)));
}

/**
 * Record `eventIds` as ingested for this brand. Idempotent via ON CONFLICT DO NOTHING (a concurrent
 * replica or a job retry that re-produces the same id is a no-op). Empty input → no-op (no query).
 */
export async function markEventIdsSeen(
  client: PoolClient,
  brandId: string,
  eventIds: string[],
): Promise<void> {
  if (eventIds.length === 0) return;

  await client.query(
    `INSERT INTO data_plane.ingest_dedup (brand_id, event_id)
     SELECT $1, unnest($2::uuid[])
     ON CONFLICT DO NOTHING`,
    [brandId, eventIds],
  );
}
