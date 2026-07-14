/**
 * ingest-dedup.repository.ts — ADR-0012 cross-brand ingest dedup helpers for the collector drainer.
 *
 * The collector connects as brain_app and its drainer claims a CROSS-BRAND batch from
 * data_plane.collector_spool (all brands at once — brand_id + event_id projected from raw_body). A
 * single per-brand RLS predicate can't cover a multi-brand batch, so these two calls go through the
 * 0130 SECURITY DEFINER functions (data_plane.filter_unseen_events / mark_events_seen) which bypass
 * ingest_dedup's per-brand RLS and key the (brand_id, event_id) pair EXPLICITLY on every row.
 *
 * ORDER IS CRITICAL at the call site (drain-events.usecase.ts): produce to Kafka FIRST, then
 * markEventsSeen + markDrained in the SAME claim transaction. A crash between produce and commit →
 * the ids stay unseen → the spool re-drains → a dup is re-produced and Silver backstops it. Never a
 * lost event. Marking before producing would be the unsafe order (a crash would drop the event).
 */
import type { ClientBase } from 'pg';

/** A keyable spool entry: both brand_id and event_id present (the only rows we can dedup). */
export interface DedupPair {
  readonly brandId: string;
  readonly eventId: string;
}

/**
 * Return the set of event_ids from `pairs` whose (brand_id, event_id) is NOT yet in ingest_dedup —
 * the events the drainer should still produce. Empty input → empty set (no query). event_id is
 * globally unique (uuid), so a Set of event_ids is a safe membership key for the produced filter.
 */
export async function filterUnseenEventIds(
  client: ClientBase,
  pairs: DedupPair[],
): Promise<Set<string>> {
  if (pairs.length === 0) return new Set<string>();

  const brandIds = pairs.map((p) => p.brandId);
  const eventIds = pairs.map((p) => p.eventId);

  const result = await client.query<{ event_id: string }>(
    `SELECT event_id FROM data_plane.filter_unseen_events($1::uuid[], $2::uuid[])`,
    [brandIds, eventIds],
  );

  return new Set<string>(result.rows.map((r) => r.event_id));
}

/**
 * Record `pairs` as ingested (INSERT … ON CONFLICT DO NOTHING inside the SECURITY DEFINER fn). MUST
 * run on the SAME client/transaction as the spool markDrained so mark-seen + mark-drained commit
 * atomically after a successful produce. Empty input → no-op (no query).
 */
export async function markEventsSeen(
  client: ClientBase,
  pairs: DedupPair[],
): Promise<void> {
  if (pairs.length === 0) return;

  const brandIds = pairs.map((p) => p.brandId);
  const eventIds = pairs.map((p) => p.eventId);

  await client.query(
    `SELECT data_plane.mark_events_seen($1::uuid[], $2::uuid[])`,
    [brandIds, eventIds],
  );
}
