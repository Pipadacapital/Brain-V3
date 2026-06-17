/**
 * getDataHealth — bounded data-pipeline health read (D-2 allowed exception).
 *
 * Surfaces raw ingestion + connector-sync state for the active brand:
 *   - eventVolume: per-day bronze_events counts over a bounded recent window (last 30 days)
 *   - lastIngestAt: MAX(ingested_at) across bronze_events
 *   - syncState:   connector_sync_status.state (latest row by last_sync_at)
 *   - lastSyncAt:  connector_sync_status.last_sync_at (latest)
 *
 * This is a bounded row/aggregate read of operational pipeline tables — NOT a
 * revenue/order metric computation. Like get-recent-activity, it is explicitly
 * permitted by D-2 (operational health surface, not the sanctioned metric path).
 *
 * F-SEC-02: all reads happen inside withBrandTxn (GUC transaction-scoped, RLS-enforced).
 * Honest-empty: state:'no_data' only when the brand has NO bronze_events at all.
 */

import type { EngineDeps } from '@brain/metric-engine';
import { withBrandTxn } from '@brain/metric-engine';

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

/**
 * getDataHealth — returns ingestion + sync health for the brand.
 *
 * @param brandId - Brand UUID (from session — D-1).
 * @param deps    - EngineDeps with raw pg.Pool.
 */
export async function getDataHealth(
  brandId: string,
  deps: EngineDeps,
): Promise<DataHealthResult> {
  return withBrandTxn(deps.pool, brandId, async (client) => {
    // EXISTS check — honest-empty (D-2). No bronze rows → no_data.
    const existsResult = await client.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM bronze_events WHERE brand_id = $1) AS exists`,
      [brandId],
    );
    if (existsResult.rows[0]?.exists !== true) {
      return { state: 'no_data' };
    }

    // Per-day event volume over a bounded window (VOLUME_WINDOW_DAYS — interval literal
    // is a constant, never user-interpolated). occurred_at is the event timestamp.
    const volumeResult = await client.query<{ bucket: Date; count: string }>(
      `SELECT date_trunc('day', occurred_at)::date AS bucket,
              COUNT(*)::text AS count
       FROM bronze_events
       WHERE brand_id = $1
         AND occurred_at >= (now() - ($2::int * INTERVAL '1 day'))
       GROUP BY 1
       ORDER BY 1 ASC`,
      [brandId, VOLUME_WINDOW_DAYS],
    );

    // Last ingest timestamp across all bronze rows (not window-bounded).
    const ingestResult = await client.query<{ last_ingest_at: Date | null }>(
      `SELECT MAX(ingested_at) AS last_ingest_at FROM bronze_events WHERE brand_id = $1`,
      [brandId],
    );

    // Latest connector sync status for the brand (newest by last_sync_at).
    // LEFT-of-nothing: a brand may have bronze rows but no connector_sync_status row yet.
    const syncResult = await client.query<{ state: string | null; last_sync_at: Date | null }>(
      `SELECT state, last_sync_at
       FROM connector_sync_status
       WHERE brand_id = $1
       ORDER BY last_sync_at DESC NULLS LAST
       LIMIT 1`,
      [brandId],
    );

    const syncRow = syncResult.rows[0];

    return {
      state: 'has_data',
      eventVolume: volumeResult.rows.map((row) => ({
        bucket: row.bucket.toISOString().split('T')[0] as string,
        count: row.count,
      })),
      lastIngestAt: ingestResult.rows[0]?.last_ingest_at?.toISOString() ?? null,
      syncState: syncRow?.state ?? null,
      lastSyncAt: syncRow?.last_sync_at?.toISOString() ?? null,
    };
  });
}
