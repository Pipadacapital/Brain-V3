/**
 * getCohortUsers — analytics use-case (ADR-002 sole-read-path) for the cohort-cell drill-down.
 *
 * Where getCohortRetention is the AGGREGATE curve (one row per cohort_month) and gold_cohort_member
 * is the per-customer membership, THIS read lists the actual customers inside ONE cohort CELL —
 * (acquisition month = cohort_month, months-since = period_index) — paginated. It reads the
 * user-grain serving view brain_serving.mv_gold_cohort_member through the withSilverBrand seam
 * (I-ST01 — the engine is the sole Gold reader; the UI never queries the lakehouse directly), and
 * LEFT-JOINs brain_serving.mv_gold_customer_360 to enrich each member with LTV / lifetime orders /
 * currency / lifecycle stage WHERE a 360 row exists (cold cycles may not have built it yet → nulls).
 *
 * Brand from session (D-1; NEVER request body); the ${BRAND_PREDICATE} seam injects brand_id = ? at
 * read time (F-SEC-02). cohort_month + period are STRICTLY validated then interpolated (no `?` for
 * caller params — the serving read binds only the single brand `?`; consistent with the other serving reads).
 * Money is bigint MINOR units serialized to string (I-S07/D-1). Honest no_data (D-2) when the cell is
 * empty. PII posture: the 360 mart carries NO raw name/email/phone — `name` is an honest reserved null.
 *
 * @see db/iceberg/duckdb/gold/gold_cohort_member.py + db/iceberg/duckdb/views/mv_gold_cohort_member.sql
 * @see apps/core/.../analytics/.../get-cohort-retention.ts — the aggregate sibling
 */

import type { SilverPool } from '@brain/metric-engine';
import { withSilverBrand, BRAND_PREDICATE } from '@brain/metric-engine';

/** One customer inside a cohort cell, enriched from the 360 mart where available. */
export interface CohortUserDto {
  /** Canonical customer (brain_id from gold_customer_360). */
  customer_key: string;
  /** Recognized orders this customer placed in this period (bigint → string). */
  order_count_in_period: string;
  /** True when the customer was active (ordered) in this period. */
  active: boolean;
  /**
   * Display name from the 360 mart WHERE available. The Gold 360 mart carries NO raw PII name
   * (privacy posture — only hashed identifiers reach Gold), so this is an honest reserved null
   * until a non-PII display name is folded onto the mart.
   */
  name: string | null;
  /** Lifetime value, bigint MINOR units → string; null when no 360 row (cold cycle / anon-only). */
  lifetime_value_minor: string | null;
  /** Lifetime recognized orders, bigint → string; null when no 360 row. */
  lifetime_orders: string | null;
  /** Currency of lifetime_value_minor (per-customer dominant; never blended); null when no 360 row. */
  currency_code: string | null;
  /** B2 lifecycle stage from the 360 mart; null when no 360 row. */
  lifecycle_stage: string | null;
}

export type CohortUsersResult =
  | {
      state: 'no_data';
      cohort_month: string;
      period: number;
      page: number;
      page_size: number;
      total: string;
      generated_at: string;
    }
  | {
      state: 'has_data';
      cohort_month: string;
      period: number;
      page: number;
      page_size: number;
      total: string; // bigint → string (total members in the cell)
      users: CohortUserDto[];
      generated_at: string;
    };

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const COHORT_MONTH_RE = /^\d{4}-\d{2}$/;

function minorOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).split('.')[0] ?? '';
  return /^-?\d+$/.test(s) ? s : null;
}
function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

interface MemberRow {
  customer_key: string;
  order_count_in_period: string | number | null;
  active: boolean | string | number | null;
  lifetime_value_minor: string | number | null;
  lifetime_orders: string | number | null;
  currency_code: string | null;
  lifecycle_stage: string | null;
}

/**
 * getCohortUsers — the paginated customer list inside one cohort cell (cohort_month × period).
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param params  - cohort_month 'YYYY-MM', period (whole-months-since, int >= 0), 1-based page + size.
 * @param deps    - The Gold serving pool (mv_gold_cohort_member + mv_gold_customer_360).
 */
export async function getCohortUsers(
  brandId: string,
  params: { cohortMonth: string; period: number; page?: number; pageSize?: number },
  deps: { srPool: SilverPool },
): Promise<CohortUsersResult> {
  const generatedAt = new Date().toISOString();
  const pageSize = Math.min(Math.max(1, Math.trunc(params.pageSize || DEFAULT_PAGE_SIZE)), MAX_PAGE_SIZE);
  const page = Math.max(1, Math.trunc(params.page || 1));
  const offset = (page - 1) * pageSize;

  // Strict validation BEFORE interpolation (the serving read binds only the brand `?`; caller params are
  // interpolated, so they must be proven-safe first). Invalid cohort cell ⇒ honest no_data.
  const cohortMonth = String(params.cohortMonth || '');
  const period = Math.trunc(Number(params.period));
  const empty: CohortUsersResult = {
    state: 'no_data', cohort_month: cohortMonth, period: Number.isFinite(period) ? period : 0,
    page, page_size: pageSize, total: '0', generated_at: generatedAt,
  };
  if (!COHORT_MONTH_RE.test(cohortMonth) || !Number.isFinite(period) || period < 0) return empty;

  // cohort_month is a first-of-month DATE in the mart ⇒ exact DATE equality. period is an int.
  const cohortDateLit = `DATE '${cohortMonth}-01'`;
  const cellPredicate = `cohort_month = ${cohortDateLit} AND period_index = ${period}`;

  const result = await withSilverBrand(deps.srPool, brandId, async (scope) => {
    // ── total members in the cell — BRAND_PREDICATE last ⇒ brand `?` binds positionally ──
    const totalRows = await scope.runScoped<{ n: number | string }>(
      `SELECT COUNT(*) AS n FROM brain_serving.mv_gold_cohort_member
        WHERE ${cellPredicate} AND ${BRAND_PREDICATE}`,
    );
    const total = String(totalRows[0]?.n ?? '0').split('.')[0] ?? '0';
    if (total === '0') return { total: '0', rows: [] as MemberRow[] };

    // ── page of members, LEFT-JOINed to the 360 mart for LTV enrichment ──────────────────
    // The cohort_member page is brand-scoped in the subquery (BRAND_PREDICATE); the 360 join is
    // brand-scoped transitively via c.brand_id = cm.brand_id (the page already pins one brand).
    // offset/pageSize/period are clamped/validated ints; cohort_month is regex-checked.
    const rows = await scope.runScoped<MemberRow>(
      `SELECT cm.customer_key,
              cm.order_count_in_period,
              cm.active,
              c.lifetime_value_minor,
              c.lifetime_orders,
              c.currency_code,
              c.lifecycle_stage
         FROM (
           SELECT brand_id, customer_key, order_count_in_period, active
             FROM brain_serving.mv_gold_cohort_member
            WHERE ${cellPredicate} AND ${BRAND_PREDICATE}
            ORDER BY order_count_in_period DESC, customer_key ASC
            OFFSET ${offset} LIMIT ${pageSize}
         ) cm
         LEFT JOIN brain_serving.mv_gold_customer_360 c
           ON c.brand_id = cm.brand_id AND c.brain_id = cm.customer_key
        ORDER BY cm.order_count_in_period DESC, cm.customer_key ASC`,
    );
    return { total, rows };
  });

  if (result.total === '0') return empty;
  return {
    state: 'has_data',
    cohort_month: cohortMonth,
    period,
    page,
    page_size: pageSize,
    total: result.total,
    generated_at: generatedAt,
    users: result.rows.map((r) => ({
      customer_key: String(r.customer_key),
      order_count_in_period: (minorOrNull(r.order_count_in_period) ?? '0'),
      active: r.active === true || String(r.active).toLowerCase() === 'true' || Number(r.active) === 1,
      name: null, // 360 mart carries no raw PII name — honest reserved null (privacy posture).
      lifetime_value_minor: minorOrNull(r.lifetime_value_minor),
      lifetime_orders: minorOrNull(r.lifetime_orders),
      currency_code: strOrNull(r.currency_code),
      lifecycle_stage: strOrNull(r.lifecycle_stage),
    })),
  };
}
