/**
 * getDataHealth — bounded data-pipeline health read (D-2 allowed exception).
 *
 * Surfaces raw ingestion + connector-sync state for the active brand:
 *   - eventVolume: per-day Bronze event counts over a bounded recent window (last 30 days)
 *   - lastIngestAt: MAX(ingested_at) across Bronze
 *   - syncState:   connector_sync_status.state (latest row by last_sync_at)
 *   - lastSyncAt:  connector_sync_status.last_sync_at (latest)
 *
 * BRONZE SOURCE (ADR-0002 Slice 5): the PG bronze_events table is RETIRED — Iceberg is the SOLE
 * source. Reads collector_events from the StarRocks external Iceberg catalog through the
 * withSilverBrand seam (brand predicate injected at ${BRAND_PREDICATE} — the SAME isolation
 * mechanism the metric-engine Silver reads use; a caller cannot forget the predicate).
 * connector_sync_status is NOT a Bronze table — it stays on Postgres.
 *
 * F-SEC-02: the Iceberg path is brand-scoped by the withSilverBrand seam. Honest-empty: 'no_data'
 * only when NO Bronze rows exist (or StarRocks isn't wired).
 */

import type { EngineDeps, SilverPool } from '@brain/metric-engine';
import { withBrandTxn, withSilverBrand, BRAND_PREDICATE } from '@brain/metric-engine';
import { hasSilver } from './_bronze-source.js';

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

/** The Iceberg Bronze table in the StarRocks external catalog (db/starrocks/external_iceberg_catalog.sql). */
const ICEBERG_BRONZE = 'brain_bronze_local.brain_bronze.collector_events';

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
  return withSilverBrand(srPool, brandId, async (scope) => {
   try {
    const existsRows = await scope.runScoped<{ n: number | string }>(
      `SELECT COUNT(*) AS n FROM ${ICEBERG_BRONZE} WHERE ${BRAND_PREDICATE}`,
    );
    if (Number(existsRows[0]?.n ?? 0) === 0) {
      return { exists: false, volume: [], lastIngestAt: null };
    }
    // Per-day volume over the bounded window. StarRocks date_trunc + date_sub; the brand predicate
    // is appended by the seam. VOLUME_WINDOW_DAYS is a constant, never user-interpolated.
    const volumeRows = await scope.runScoped<{ bucket: Date | string; count: number | string }>(
      `SELECT date_trunc('day', occurred_at) AS bucket, COUNT(*) AS count
         FROM ${ICEBERG_BRONZE}
        WHERE occurred_at >= date_sub(now(), INTERVAL ${VOLUME_WINDOW_DAYS} DAY) AND ${BRAND_PREDICATE}
        GROUP BY 1 ORDER BY 1 ASC`,
    );
    const ingestRows = await scope.runScoped<{ last_ingest_at: Date | string | null }>(
      `SELECT MAX(ingested_at) AS last_ingest_at FROM ${ICEBERG_BRONZE} WHERE ${BRAND_PREDICATE}`,
    );
    const toIso = (v: Date | string | null | undefined): string | null =>
      v == null ? null : (v instanceof Date ? v : new Date(v)).toISOString();
    return {
      exists: true,
      volume: volumeRows.map((r) => ({
        bucket: (toIso(r.bucket) ?? '').split('T')[0] as string,
        count: String(r.count),
      })),
      lastIngestAt: toIso(ingestRows[0]?.last_ingest_at),
    };
   } catch (err) {
     // The Iceberg Bronze catalog isn't materialized/reachable yet (fresh env, or a transient
     // external-catalog error that isn't the 'unknown table' the seam already swallows). Degrade to
     // honest no-data so the dashboard's foundation signals stay up instead of 500-ing. Observable.
     console.warn(
       `[get-data-health] Iceberg Bronze read degraded to empty — catalog unavailable: ${err instanceof Error ? err.message : String(err)}`,
     );
     return { exists: false, volume: [], lastIngestAt: null };
   }
  });
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
  const bronze = await readBronzeIceberg(deps.srPool, brandId);
  if (!bronze.exists) return { state: 'no_data' };
  const sync = await readSyncStatus(deps, brandId);
  return {
    state: 'has_data',
    eventVolume: bronze.volume,
    lastIngestAt: bronze.lastIngestAt,
    syncState: sync.state,
    lastSyncAt: sync.lastSyncAt,
  };
}
