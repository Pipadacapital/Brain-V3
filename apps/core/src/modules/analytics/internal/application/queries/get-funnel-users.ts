/**
 * getFunnelUsers — analytics use-case (ADR-002 sole-read-path) for the funnel STEP drill-down.
 *
 * Paginated list of the VISITORS who DROPPED at a given funnel step — reached that step but not the
 * next — over the per-visitor Gold mart gold_funnel_user, served through the serving view
 * brain_serving.mv_gold_funnel_user via the withSilverBrand seam (I-ST01 — the engine is the sole
 * Gold reader; the UI never queries the lakehouse directly). "Dropped at <step>" is exactly
 * furthest_step = '<step>' (the mart records each visitor's DEEPEST reached step in funnel order
 * session < product_view < cart < checkout < purchase). The window is applied on last_seen_at.
 *
 * NO money — this mart is funnel-stage identity bookkeeping (a step label + a timestamp). Honest
 * no_data (D-2) when the brand/step/window has no visitors. brandId from session (D-1; NEVER body);
 * the ${BRAND_PREDICATE} seam injects brand_id = ? at read time (F-SEC-02).
 *
 * @see db/iceberg/duckdb/gold/gold_funnel_user.py + db/iceberg/duckdb/views/mv_gold_funnel_user.sql
 */

import type { SilverPool } from '@brain/metric-engine';
import { withSilverBrand, BRAND_PREDICATE } from '@brain/metric-engine';

/** The funnel steps a visitor can drop at, in funnel order (matches the mart's furthest_step values). */
export type FunnelStep = 'session' | 'product_view' | 'cart' | 'checkout' | 'purchase';

export interface FunnelUserDto {
  visitor_id: string;
  furthest_step: FunnelStep;
  last_seen_at: string | null; // ISO-8601; null when the mart has no timestamp for the visitor
}

export type FunnelUsersResult =
  | { state: 'no_data'; step: FunnelStep; page: number; page_size: number; total: string }
  | {
      state: 'has_data';
      step: FunnelStep;
      page: number;
      page_size: number;
      total: string; // bigint → string (visitors who dropped at this step in the window)
      visitors: FunnelUserDto[];
    };

export interface FunnelUsersParams {
  step: FunnelStep;
  /** Window lower bound (inclusive) on last_seen_at — YYYY-MM-DD; the caller defaults it. */
  fromStr: string;
  /** Window upper bound (inclusive) on last_seen_at — YYYY-MM-DD; the caller defaults it. */
  toStr: string;
  page?: number;
  pageSize?: number;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/** Date → serving timestamp param string (mirrors the metric-engine readers' window-bound helpers). */
function toServingTs(d: Date): string {
  return d.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

interface VisitorRow {
  visitor_id: string;
  furthest_step: string;
  last_seen_at: Date | string | null;
}
interface CountRow {
  n: number | string;
}

/**
 * getFunnelUsers — the brand's visitors who dropped at `step` within the window, newest-first, paged.
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param deps    - The Gold serving pool (mv_gold_funnel_user).
 * @param params  - step (validated enum) + window + 1-based page/pageSize (clamped server-side).
 */
export async function getFunnelUsers(
  brandId: string,
  deps: { srPool: SilverPool },
  params: FunnelUsersParams,
): Promise<FunnelUsersResult> {
  const { step } = params;
  const pageSize = Math.min(Math.max(1, Math.trunc(params.pageSize || DEFAULT_PAGE_SIZE)), MAX_PAGE_SIZE);
  const page = Math.max(1, Math.trunc(params.page || 1));
  const offset = (page - 1) * pageSize;

  // Window bounds on last_seen_at — inclusive day range (00:00:00 .. 23:59:59).
  const fromTs = toServingTs(new Date(`${params.fromStr}T00:00:00Z`));
  const toTs = toServingTs(new Date(`${params.toStr}T23:59:59Z`));

  const result = await withSilverBrand(deps.srPool, brandId, async (scope) => {
    // Bound params bind to their `?` placeholders in order; the seam appends brandId for BRAND_PREDICATE.
    const totalRows = await scope.runScoped<CountRow>(
      `SELECT COUNT(*) AS n
         FROM brain_serving.mv_gold_funnel_user
        WHERE furthest_step = ?
          AND last_seen_at >= ? AND last_seen_at <= ?
          AND ${BRAND_PREDICATE}`,
      [step, fromTs, toTs],
    );
    const total = String(totalRows[0]?.n ?? '0');
    if (total === '0') return { total: '0', rows: [] as VisitorRow[] };

    // pageSize/offset are clamped integers → safe to interpolate (the serving API has no OFFSET/LIMIT params).
    const rows = await scope.runScoped<VisitorRow>(
      `SELECT visitor_id, furthest_step, last_seen_at
         FROM brain_serving.mv_gold_funnel_user
        WHERE furthest_step = ?
          AND last_seen_at >= ? AND last_seen_at <= ?
          AND ${BRAND_PREDICATE}
        ORDER BY last_seen_at DESC, visitor_id ASC
        OFFSET ${offset} LIMIT ${pageSize}`,
      [step, fromTs, toTs],
    );
    return { total, rows };
  });

  if (result.total === '0') {
    return { state: 'no_data', step, page, page_size: pageSize, total: '0' };
  }

  return {
    state: 'has_data',
    step,
    page,
    page_size: pageSize,
    total: result.total,
    visitors: result.rows.map((r) => ({
      visitor_id: String(r.visitor_id),
      furthest_step: (r.furthest_step as FunnelStep) ?? step,
      last_seen_at:
        r.last_seen_at == null
          ? null
          : r.last_seen_at instanceof Date
            ? r.last_seen_at.toISOString()
            : new Date(r.last_seen_at).toISOString(),
    })),
  };
}
