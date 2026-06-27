/**
 * getServingFreshness — the V4-pipeline FRESHNESS + ROW-COUNT surface (observability slice).
 *
 * WHAT it answers: "for the analytics serving tier, which marts have data, how many rows, and how
 * stale is each one?" — the operational health read the data-health surface needs under Brain V4,
 * where Spark materializes Iceberg Silver/Gold and StarRocks `brain_serving.mv_*` async-MVs serve.
 *
 * SOURCE (brand-AGNOSTIC, operational metadata — NOT a per-tenant read): StarRocks
 * `information_schema.materialized_views` for the `brain_serving` schema. That catalog view exposes,
 * per MV, the exact signals this surface needs WITHOUT scanning a single data row:
 *   - TABLE_ROWS                  → per-mv row count (the "does this mart have data" signal).
 *   - LAST_REFRESH_FINISHED_TIME  → freshness: when the MV last tracked its Iceberg Gold/Silver base.
 *   - LAST_REFRESH_STATE          → SUCCESS | FAILED | … (a stale-because-broken-refresh signal).
 * The `mv_*` name maps 1:1 to its Iceberg mart (mv_gold_funnel ← brain_gold.gold_funnel), so this is
 * ALSO the per-mart row-count surface — read cheaply from serving metadata instead of an Iceberg scan.
 *
 * WHY NOT brand-scoped (no ${BRAND_PREDICATE} / withSilverBrand): this is cross-brand PIPELINE health
 * — "is the serving tier fresh", an admin/ops signal, NOT a tenant data read. information_schema carries
 * no brand_id column and no business rows; there is nothing tenant-bearing to leak. It is therefore read
 * through the pool's plain `.query` (as the SELECT-only brain_analytics user), deliberately bypassing the
 * tenant seam — the ONLY place in this module that does so, and only because the source is metadata.
 *
 * NO money, NO PII — counts + timestamps + names only. Fail-soft: StarRocks down / schema absent →
 * honest `{ state: 'no_data' }` (never a 500, never a fabricated freshness).
 *
 * Freshness verdict (text, never colour-only): per the staleness of LAST_REFRESH_FINISHED_TIME against
 * a bounded SLA window, surfaced as 'fresh' | 'stale' | 'failed' | 'never' so the UI renders an
 * icon+label. Worst-of across MVs rolls up to the surface-level `status`.
 */

import type { SilverPool } from '@brain/metric-engine';

/** The serving schema the V4 MVs live in (matches db/starrocks/mv/*.sql + the v4-refresh-loop). */
const SERVING_DB = 'brain_serving';

/**
 * Staleness SLA: an MV whose last successful refresh is older than this is 'stale'. The v4-refresh-loop
 * SYNC-refreshes every cycle (default 300s) and each MV also self-refreshes EVERY 30 MINUTE — so a 90m
 * window flags a genuinely-not-converging serving tier without false-alarming on the async cadence.
 */
const STALE_AFTER_MINUTES = 90;

/** Per-MV freshness verdict (text+icon in the UI — never colour-only). */
export type MartFreshness = 'fresh' | 'stale' | 'failed' | 'never';

/** One serving mart's freshness + row count. */
export interface ServingMartRow {
  /** The serving MV name (e.g. 'mv_gold_funnel'). */
  mv: string;
  /** Row count of the MV (TABLE_ROWS) — best-effort bigint serialized to string (D-1). */
  rows: string;
  /** ISO timestamp of the last finished refresh, or null if never refreshed. */
  lastRefreshAt: string | null;
  /** Minutes since the last finished refresh (null when never refreshed). */
  ageMinutes: number | null;
  /** Raw StarRocks refresh state (SUCCESS | FAILED | …). */
  refreshState: string | null;
  /** The derived freshness verdict. */
  freshness: MartFreshness;
}

export type ServingFreshnessResult =
  | { state: 'no_data' }
  | {
      state: 'has_data';
      /** Worst-of freshness across all MVs: failed > stale > never > fresh. */
      status: MartFreshness;
      /** Count of MVs that are fresh / total — the headline coverage signal. */
      freshCount: number;
      total: number;
      /** Per-mart freshness + row count (sorted by name). */
      marts: ServingMartRow[];
      /** ISO timestamp this surface was computed (so the UI can show "as of"). */
      checkedAt: string;
    };

export interface ServingFreshnessDeps {
  /** StarRocks pool (brain_analytics, SELECT-only). Absent → honest no_data. */
  readonly srPool?: SilverPool;
}

/** Raw row shape from information_schema.materialized_views. */
interface RawMvRow {
  TABLE_NAME: string;
  TABLE_ROWS: number | string | null;
  LAST_REFRESH_FINISHED_TIME: Date | string | null;
  LAST_REFRESH_STATE: string | null;
}

const WORST_ORDER: Record<MartFreshness, number> = { fresh: 0, never: 1, stale: 2, failed: 3 };

function toIso(v: Date | string | null | undefined): string | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function deriveFreshness(refreshState: string | null, ageMinutes: number | null): MartFreshness {
  // A non-SUCCESS refresh state means the serving tier could not track its base — surface it loudly.
  if (refreshState != null && refreshState !== 'SUCCESS' && refreshState !== '') return 'failed';
  if (ageMinutes == null) return 'never';
  return ageMinutes > STALE_AFTER_MINUTES ? 'stale' : 'fresh';
}

/**
 * getServingFreshness — the V4 serving-tier freshness + row-count read.
 *
 * Brand-agnostic operational metadata (see file header). Fail-soft to no_data on any StarRocks error.
 */
export async function getServingFreshness(
  deps: ServingFreshnessDeps,
): Promise<ServingFreshnessResult> {
  if (!deps.srPool) return { state: 'no_data' };

  let raw: RawMvRow[];
  try {
    // Plain pool query — operational metadata, no tenant predicate (see file header).
    // Brain V4: srPool is the Trino query PORT — query() returns the row array directly.
    const rows = await deps.srPool.query(
      `SELECT TABLE_NAME, TABLE_ROWS, LAST_REFRESH_FINISHED_TIME, LAST_REFRESH_STATE
         FROM information_schema.materialized_views
        WHERE TABLE_SCHEMA = ?
        ORDER BY TABLE_NAME ASC`,
      [SERVING_DB],
    );
    raw = (rows as unknown as RawMvRow[]) ?? [];
  } catch {
    // StarRocks down / information_schema unavailable → honest no_data (never a 500).
    return { state: 'no_data' };
  }

  if (raw.length === 0) return { state: 'no_data' };

  const now = Date.now();
  const marts: ServingMartRow[] = raw.map((r) => {
    const lastRefreshAt = toIso(r.LAST_REFRESH_FINISHED_TIME);
    const ageMinutes =
      lastRefreshAt == null ? null : Math.max(0, Math.round((now - new Date(lastRefreshAt).getTime()) / 60000));
    const refreshState = r.LAST_REFRESH_STATE ?? null;
    return {
      mv: r.TABLE_NAME,
      rows: String(r.TABLE_ROWS ?? 0),
      lastRefreshAt,
      ageMinutes,
      refreshState,
      freshness: deriveFreshness(refreshState, ageMinutes),
    };
  });

  const status = marts.reduce<MartFreshness>(
    (worst, m) => (WORST_ORDER[m.freshness] > WORST_ORDER[worst] ? m.freshness : worst),
    'fresh',
  );
  const freshCount = marts.filter((m) => m.freshness === 'fresh').length;

  return {
    state: 'has_data',
    status,
    freshCount,
    total: marts.length,
    marts,
    checkedAt: new Date(now).toISOString(),
  };
}
