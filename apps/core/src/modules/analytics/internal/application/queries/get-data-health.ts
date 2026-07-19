/**
 * getDataHealth — bounded data-pipeline health read (D-2 allowed exception).
 *
 * Surfaces raw ingestion + connector-sync state for the active brand:
 *   - eventVolume: per-day Bronze event counts over a bounded recent window (last 30 days)
 *   - lastIngestAt: MAX(ingested_at) across Bronze
 *   - syncState:   connector_sync_status.state (latest row by last_sync_at)
 *   - lastSyncAt:  connector_sync_status.last_sync_at (latest)
 *
 * BRONZE SOURCE (ADR-0010): the PG bronze_events table is RETIRED — Iceberg is the SOLE source.
 * Reads the Kafka Connect collector lane over Trino via the lift view
 * (collector_events_connect_lifted) through the
 * withSilverBrand seam (brand predicate injected at ${BRAND_PREDICATE} — the SAME isolation
 * mechanism the metric-engine Silver reads use; a caller cannot forget the predicate).
 * connector_sync_status is NOT a Bronze table — it stays on Postgres.
 *
 * F-SEC-02: the Iceberg path is brand-scoped by the withSilverBrand seam. Honest-empty: 'no_data'
 * only when NO Bronze rows exist (or StarRocks isn't wired).
 */

import type { EngineDeps, SilverPool } from '@brain/metric-engine';
import { withBrandTxn, withSilverBrand, BRAND_PREDICATE } from '@brain/metric-engine';
import { COLLECTOR_EVENTS_VIEW, COLLECTOR_PREDICATE } from './_bronze-source.js';
import { hasSilver } from './_bronze-source.js';
import { log } from '../../../../../log.js';

export interface DataHealthVolumeBucket {
  bucket: string; // 'YYYY-MM-DD'
  count: string;  // bigint serialized to string (D-1)
}

export type DataHealthResult =
  | { state: 'no_data' }
  | {
      state: 'has_data';
      eventVolume: DataHealthVolumeBucket[];
      lastIngestAt: string | null; // ISO timestamp
      syncState: string | null;
      lastSyncAt: string | null;   // ISO timestamp
    };

/** Bounded window for the event-volume histogram. */
const VOLUME_WINDOW_DAYS = 30;

/** The Iceberg Bronze table over Trino (Brain V4 — StarRocks removed); Trino's default catalog is `iceberg`. */
// COLLECTOR_EVENTS_VIEW + the (constant TRUE) collector predicate come from the shared _bronze-source
// (ADR-0010 — the BRONZE_SOURCE switch is removed; the connect lift view is the only source).

export interface DataHealthDeps extends EngineDeps {
  /** StarRocks pool — required to read the Iceberg Bronze catalog. Absent → honest no_data. */
  readonly srPool?: SilverPool;
}

/** Read the connector_sync_status row (latest) for the brand from Postgres (both modes). */
async function readSyncStatus(
  deps: EngineDeps,
  brandId: string,
): Promise<{ state: string | null; lastSyncAt: string | null }> {
  return withBrandTxn(deps.pool, brandId, async (client) => {
    const syncResult = await client.query<{ state: string | null; last_sync_at: Date | null }>(
      `SELECT state, last_sync_at
       FROM connector_sync_status
       WHERE brand_id = $1
       ORDER BY last_sync_at DESC NULLS LAST
       LIMIT 1`,
      [brandId],
    );
    const row = syncResult.rows[0];
    return { state: row?.state ?? null, lastSyncAt: row?.last_sync_at?.toISOString() ?? null };
  });
}

/** Bronze reads (exists / volume / lastIngest) from the Iceberg catalog via the brand-scoped seam. */
async function readBronzeIceberg(
  srPool: SilverPool,
  brandId: string,
): Promise<{ exists: boolean; volume: DataHealthVolumeBucket[]; lastIngestAt: string | null }> {
  try {
    // PERF: the existence/MAX-ingest HEAD read and the per-day VOLUME histogram hit DIFFERENT
    // connections via TWO withSilverBrand scopes run concurrently under Promise.all — cold
    // data-health no longer pays head-latency THEN volume-latency serially; it pays max(of the
    // two). Each scope keeps its single query serial (we NEVER Promise.all *within* one scope —
    // that trips pg's "client already executing a query"); the fan-out is strictly ACROSS scopes.
    // The volume scan runs even when the brand has zero Bronze rows (the early-empty case below
    // discards it), which is the cheap, rare branch — the common has-data path is the one halved.
    const [headRows, volumeRows] = await Promise.all([
      withSilverBrand(srPool, brandId, (scope) =>
        scope.runScoped<{ n: number | string; last_ingest_at: Date | string | null }>(
          `SELECT COUNT(*) AS n, MAX(ingested_at) AS last_ingest_at FROM ${COLLECTOR_EVENTS_VIEW} WHERE ${COLLECTOR_PREDICATE} AND ${BRAND_PREDICATE}`,
        ),
      ),
      // Per-day volume over the bounded window. date_trunc + interval math; the brand predicate
      // is appended by the seam. VOLUME_WINDOW_DAYS is a constant, never user-interpolated.
      withSilverBrand(srPool, brandId, (scope) =>
        scope.runScoped<{ bucket: Date | string; count: number | string }>(
          `SELECT date_trunc('day', occurred_at) AS bucket, COUNT(*) AS count
             FROM ${COLLECTOR_EVENTS_VIEW}
            WHERE occurred_at >= (now() - INTERVAL ${VOLUME_WINDOW_DAYS} DAY) AND ${COLLECTOR_PREDICATE} AND ${BRAND_PREDICATE}
            GROUP BY 1 ORDER BY 1 ASC`,
        ),
      ),
    ]);
    // Early-empty semantics preserved: no Bronze rows → honest no-data (volume discarded).
    if (Number(headRows[0]?.n ?? 0) === 0) {
      return { exists: false, volume: [], lastIngestAt: null };
    }
    const toIso = (v: Date | string | null | undefined): string | null =>
      v == null ? null : (v instanceof Date ? v : new Date(v)).toISOString();
    return {
      exists: true,
      volume: volumeRows.map((r) => ({
        bucket: (toIso(r.bucket) ?? '').split('T')[0] as string,
        count: String(r.count),
      })),
      lastIngestAt: toIso(headRows[0]?.last_ingest_at),
    };
  } catch (err) {
    // The Iceberg Bronze catalog isn't materialized/reachable yet (fresh env, or a transient
    // external-catalog error that isn't the 'unknown table' the seam already swallows). Degrade to
    // honest no-data so the dashboard's foundation signals stay up instead of 500-ing. Observable.
    log.warn('get-data-health: Iceberg Bronze read degraded to empty — catalog unavailable', {
      brand_id: brandId,
      err,
    });
    return { exists: false, volume: [], lastIngestAt: null };
  }
}

/**
 * getDataHealth — returns ingestion + sync health for the brand.
 *
 * @param brandId - Brand UUID (from session — D-1).
 * @param deps    - pg.Pool (+ optional srPool when reading Bronze from Iceberg).
 */
export async function getDataHealth(
  brandId: string,
  deps: DataHealthDeps,
): Promise<DataHealthResult> {
  // no StarRocks wired → honest no_data (PG bronze retired)
  if (!hasSilver(deps)) return { state: 'no_data' };

  // ── Iceberg Bronze source — brand-isolated via the withSilverBrand seam ────────────
  // PERF: the Trino Bronze read (srPool) and the PG sync-status read (deps.pool) hit DIFFERENT
  // pools, so run them concurrently — the slow Trino scan no longer waits on the PG round-trip.
  // sync is discarded when Bronze is empty; computing it eagerly is a cheap PG query.
  const [bronze, sync] = await Promise.all([
    readBronzeIceberg(deps.srPool, brandId),
    readSyncStatus(deps, brandId),
  ]);
  if (!bronze.exists) return { state: 'no_data' };
  return {
    state: 'has_data',
    eventVolume: bronze.volume,
    lastIngestAt: bronze.lastIngestAt,
    syncState: sync.state,
    lastSyncAt: sync.lastSyncAt,
  };
}
