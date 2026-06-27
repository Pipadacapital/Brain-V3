/**
 * getServingFreshness — the V4-pipeline FRESHNESS + ROW-COUNT surface (observability slice).
 *
 * WHAT it answers: "for the analytics serving tier, which marts have data, how many rows, and how
 * stale is each one?" — the operational health read the data-health surface needs under Brain V4,
 * where Spark materializes Iceberg Silver/Gold and TRINO serves them through `brain_serving.mv_*` views.
 *
 * SOURCE (Brain V4 — StarRocks REMOVED). StarRocks is gone, so there is no
 * `information_schema.materialized_views` with TABLE_ROWS / LAST_REFRESH_FINISHED_TIME / LAST_REFRESH_STATE
 * to read — those were StarRocks-ASYNC-MV specifics. The honest, minimal V4 replacement reads TRINO over
 * Iceberg directly:
 *   1. Enumerate the serving marts that carry a freshness column from `information_schema.columns`
 *      (every `brain_serving.mv_*` view that projects `updated_at` — the Spark-write watermark).
 *   2. For each, read `max(updated_at)` (freshness — when Spark last wrote a row this view sees) and
 *      `count(*)` (the "does this mart have data" / row-count signal). Both are cheap: Trino answers
 *      count from Iceberg metadata and max() from per-file column stats — no full data scan.
 * The `mv_*` name maps 1:1 to its Iceberg mart (mv_gold_funnel ← iceberg.brain_gold.gold_funnel).
 *
 * WHY only the freshness-bearing views: 5 serving views (the snapshot `mv_snap_*`, `mv_gold_customer_scores`,
 * `mv_silver_order_line`) do not project an `updated_at` column, so there is no honest freshness signal to
 * report for them — they are omitted rather than faked as 'never'. Coverage is whatever carries a watermark.
 *
 * NO StarRocks refresh-state under Trino: Trino views always reflect the latest Iceberg snapshot (there is
 * no async refresh to FAIL), so `refreshState` is always null and the verdict derives from age alone
 * (fresh|stale|never). The 'failed' verdict is retained in the type for shape stability but never produced.
 *
 * WHY NOT brand-scoped (no ${BRAND_PREDICATE} / withSilverBrand): this is cross-brand PIPELINE health
 * — "is the serving tier fresh", an admin/ops signal, NOT a tenant data read. The signals here are
 * per-mart aggregates (max(updated_at), count(*)) across all brands; there is nothing tenant-bearing to
 * leak. It is therefore read through the pool's plain `.query` (the read-only Trino pool), deliberately
 * outside the tenant seam — the ONLY place in this module that does so, because the read is pipeline metadata.
 *
 * NO money, NO PII — counts + timestamps + view names only. Fail-soft: Trino down / serving schema absent →
 * honest `{ state: 'no_data' }` (never a 500, never a fabricated freshness).
 *
 * Freshness verdict (text, never colour-only): per the staleness of max(updated_at) against a bounded SLA
 * window, surfaced as 'fresh' | 'stale' | 'failed' | 'never' so the UI renders an icon+label. Worst-of
 * across marts rolls up to the surface-level `status`.
 */

import type { SilverPool } from '@brain/metric-engine';

/** The serving schema the V4 Trino views live in (matches db/trino/views/mv_*.sql + run-trino-views.sh). */
const SERVING_SCHEMA = 'brain_serving';

/**
 * Staleness SLA: a mart whose latest `updated_at` is older than this is 'stale'. The v4-refresh-loop
 * re-materializes the Iceberg Gold/Silver every cycle (default 300s), so a 90m window flags a genuinely-
 * not-converging serving tier without false-alarming on the refresh cadence.
 */
const STALE_AFTER_MINUTES = 90;

/** Per-mart freshness verdict (text+icon in the UI — never colour-only). */
export type MartFreshness = 'fresh' | 'stale' | 'failed' | 'never';

/** One serving mart's freshness + row count. */
export interface ServingMartRow {
  /** The serving view name (e.g. 'mv_gold_funnel'). */
  mv: string;
  /** Row count of the view (count(*)) — best-effort bigint serialized to string (D-1). */
  rows: string;
  /** ISO timestamp of the latest row (max(updated_at)), or null if the mart is empty. */
  lastRefreshAt: string | null;
  /** Minutes since the latest row's updated_at (null when the mart is empty). */
  ageMinutes: number | null;
  /**
   * Refresh state — always null under Trino (a view has no async-refresh state to fail). Retained for
   * shape stability with the StarRocks-era surface; the verdict derives from age alone.
   */
  refreshState: string | null;
  /** The derived freshness verdict. */
  freshness: MartFreshness;
}

export type ServingFreshnessResult =
  | { state: 'no_data' }
  | {
      state: 'has_data';
      /** Worst-of freshness across all marts: failed > stale > never > fresh. */
      status: MartFreshness;
      /** Count of marts that are fresh / total — the headline coverage signal. */
      freshCount: number;
      total: number;
      /** Per-mart freshness + row count (sorted by name). */
      marts: ServingMartRow[];
      /** ISO timestamp this surface was computed (so the UI can show "as of"). */
      checkedAt: string;
    };

export interface ServingFreshnessDeps {
  /** Trino pool (read-only, over Iceberg). Absent → honest no_data. */
  readonly srPool?: SilverPool;
}

/** A serving view that carries a freshness watermark (from information_schema.columns). */
interface FreshnessViewRow {
  table_name: string;
}

/** Per-mart aggregate row from the UNION-ALL freshness probe. */
interface MartAggRow {
  mv: string;
  last_refresh_at: string | null;
  row_count: string | number | null;
}

const WORST_ORDER: Record<MartFreshness, number> = { fresh: 0, never: 1, stale: 2, failed: 3 };

/** Defense-in-depth: only identifiers that match this are interpolated into the UNION query. */
const SAFE_MV_NAME = /^mv_[a-z0-9_]+$/;

function toIso(v: Date | string | null | undefined): string | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function deriveFreshness(refreshState: string | null, ageMinutes: number | null): MartFreshness {
  // A non-SUCCESS refresh state means the serving tier could not track its base — surface it loudly.
  // (Under Trino refreshState is always null, so this branch is dormant; kept for shape stability.)
  if (refreshState != null && refreshState !== 'SUCCESS' && refreshState !== '') return 'failed';
  if (ageMinutes == null) return 'never';
  return ageMinutes > STALE_AFTER_MINUTES ? 'stale' : 'fresh';
}

/**
 * getServingFreshness — the V4 serving-tier freshness + row-count read (Trino over Iceberg).
 *
 * Brand-agnostic pipeline health (see file header). Fail-soft to no_data on any Trino error / absent schema.
 */
export async function getServingFreshness(
  deps: ServingFreshnessDeps,
): Promise<ServingFreshnessResult> {
  if (!deps.srPool) return { state: 'no_data' };

  // ── 1. Enumerate the serving marts that expose a freshness watermark (updated_at). ──
  // Plain pool query — pipeline metadata, no tenant predicate (see file header). Trino's
  // information_schema lists views/tables for the default (iceberg) catalog.
  let viewNames: string[];
  try {
    const cols = await deps.srPool.query<FreshnessViewRow>(
      `SELECT table_name
         FROM information_schema.columns
        WHERE table_schema = ?
          AND column_name = 'updated_at'
          AND table_name LIKE 'mv\\_%' ESCAPE '\\'
        ORDER BY table_name`,
      [SERVING_SCHEMA],
    );
    viewNames = (cols ?? [])
      .map((r) => r.table_name)
      .filter((n): n is string => typeof n === 'string' && SAFE_MV_NAME.test(n));
  } catch {
    // Trino down / information_schema unavailable → honest no_data (never a 500).
    return { state: 'no_data' };
  }
  if (viewNames.length === 0) return { state: 'no_data' };

  // ── 2. Probe each mart for freshness (max(updated_at)) + row count (count(*)) in ONE round-trip. ──
  // Both aggregates are answered from Iceberg metadata / column stats — no data scan.
  const unionSql = viewNames
    .map(
      (mv) =>
        `SELECT '${mv}' AS mv, CAST(max(updated_at) AS varchar) AS last_refresh_at, ` +
        `CAST(count(*) AS varchar) AS row_count FROM ${SERVING_SCHEMA}."${mv}"`,
    )
    .join('\nUNION ALL\n');

  let raw: MartAggRow[];
  try {
    raw = (await deps.srPool.query<MartAggRow>(unionSql)) ?? [];
  } catch {
    // A missing serving view / Iceberg schema (fresh env) → honest no_data (never a 500).
    return { state: 'no_data' };
  }
  if (raw.length === 0) return { state: 'no_data' };

  const now = Date.now();
  const marts: ServingMartRow[] = raw
    .map((r) => {
      const lastRefreshAt = toIso(r.last_refresh_at);
      const ageMinutes =
        lastRefreshAt == null
          ? null
          : Math.max(0, Math.round((now - new Date(lastRefreshAt).getTime()) / 60000));
      return {
        mv: r.mv,
        rows: String(r.row_count ?? 0),
        lastRefreshAt,
        ageMinutes,
        refreshState: null,
        freshness: deriveFreshness(null, ageMinutes),
      };
    })
    .sort((a, b) => a.mv.localeCompare(b.mv));

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
