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
 * GUC DISCIPLINE (the RLS seam): ingest_dedup has FORCE RLS with
 * `brand_id = current_setting('app.current_brand_id', true)::uuid`. Each helper sets the brand GUC
 * ITSELF, transaction-locally, inside an explicit BEGIN/COMMIT on the caller's client. A bare
 * `set_config(..., is_local => true)` OUTSIDE a transaction is a silent no-op (it expires with its
 * own implicit transaction) — and on a REUSED pooled connection a previously-expired local GUC
 * reads back as '' (not NULL), so the policy's uuid cast then throws
 * `invalid input syntax for type uuid: ""` on every call. Owning the transaction here makes the
 * gate correct on any client; callers do NOT need to (and should not) set the GUC themselves.
 * brand_id is still passed explicitly for the equality predicate and is ALWAYS the connector's
 * enumerated brand (MT-1) — never from env or payload.
 */
import type { PoolClient } from 'pg';

/** Run `fn` inside BEGIN/COMMIT with the brand GUC set transaction-locally (see header). */
async function withBrandTxn<T>(
  client: PoolClient,
  brandId: string,
  fn: () => Promise<T>,
): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query(`SELECT set_config('app.current_brand_id', $1, true)`, [brandId]);
    const out = await fn();
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}

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

  const result = await withBrandTxn(client, brandId, () =>
    client.query<{ event_id: string }>(
      `SELECT event_id FROM data_plane.ingest_dedup
       WHERE brand_id = $1 AND event_id = ANY($2::uuid[])`,
      [brandId, eventIds],
    ),
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

  await withBrandTxn(client, brandId, () =>
    client.query(
      `INSERT INTO data_plane.ingest_dedup (brand_id, event_id)
       SELECT $1, unnest($2::uuid[])
       ON CONFLICT DO NOTHING`,
      [brandId, eventIds],
    ),
  );
}
