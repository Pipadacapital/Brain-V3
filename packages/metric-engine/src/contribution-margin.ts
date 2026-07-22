/**
 * @brain/metric-engine — computeContributionMargin (CM1 / CM2, the True-CM2 moat).
 *
 * The SOLE emitter of the margin signal. CM (per METRICS.md):
 *   CM1 = realized_revenue − COGS − other variable costs (shipping, packaging, payment/marketplace
 *         fees) — costs from the per-brand cost_input structure (0055).
 *   CM2 = CM1 − marketing spend (ad_spend_ledger) allocated to the period.
 *
 * Money is BIGINT minor units, INTEGER arithmetic only (I-S07 — no float). A cost_input is either a
 * percentage of revenue (pct_bps) or a fixed per-order amount; at the brand-period grain CM uses the
 * pct_bps inputs (per-SKU/per-order fixed costs are the M2 order_margin_fact refinement).
 *
 * ── PHASE G re-point (mixed-tier): the two MONEY inputs read the lakehouse via withSilverBrand
 *    (I-ST01) — realized from brain_gold.gold_revenue_ledger (realized_gmv_as_of math, cumulative
 *    ≤ as_of, excl provisional) and marketing from brain_silver.silver_marketing_spend (ad_spend_as_of
 *    math, cumulative ≤ as_of). The cost_input CONFIG (pct rates + confidence) and the brand currency
 *    stay on operational Postgres via withBrandTxn (RLS-scoped). So deps = { pool, srPool }. PG is no
 *    longer a read source for revenue/spend (write SoR only). NO ad-hoc SUM — the seam math, inlined.
 *
 * cost_confidence: the FLOOR over the brand's cost_input confidences. With NO cogs input the margin
 * cannot be trusted → 'Insufficient' (the honest 'D' that keeps the billing cap from applying).
 */
import type { CurrencyCode } from '@brain/money';
import type { EngineDeps } from './deps.js';
import { withBrandTxn } from './deps.js';
import type { SilverDeps } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';
import { contribMarginFromMart } from './serving-mart-flags.js';

/**
 * CM reads both tiers: operational PG (cost config + currency) + lakehouse (realized + spend).
 *
 * ADR-0019 WS-3 D5: `fromMart` (default the SERVING_CONTRIB_MARGIN_FROM_MART process flag) repoints the
 * read to the pre-baked mv_gold_contribution_margin instead of recomputing CM1/CM2 at read time. Default
 * OFF → today's live recompute; explicit `fromMart` on deps overrides the env (unit-testable seam). The
 * mart is byte-parity-gated against this recompute before the flag flips default-ON.
 */
export type ContributionMarginDeps = EngineDeps & SilverDeps & { fromMart?: boolean };

export type CostConfidence = 'Trusted' | 'Estimated' | 'Insufficient';

export interface ContributionMarginResult {
  /** True iff the brand has finalized revenue to compute a margin over (honest no_data otherwise). */
  hasData: boolean;
  currencyCode: CurrencyCode | null;
  /** Realized (net) revenue, minor units. */
  netRevenueMinor: bigint;
  /** Cost of goods sold, minor units (revenue × cogs pct). */
  cogsMinor: bigint;
  /** Other variable costs (shipping + packaging + payment_fee + marketplace_fee), minor units. */
  variableCostMinor: bigint;
  /** CM1 = netRevenue − cogs − variable. */
  cm1Minor: bigint;
  /** Marketing (ad) spend allocated to the period, minor units. */
  marketingMinor: bigint;
  /** CM2 = CM1 − marketing. */
  cm2Minor: bigint;
  /** Floor of the brand's cost_input confidences; 'Insufficient' when no COGS is entered. */
  costConfidence: CostConfidence;
}

const VARIABLE_COST_TYPES = new Set(['shipping', 'packaging', 'payment_fee', 'marketplace_fee']);
const CONFIDENCE_RANK: Record<CostConfidence, number> = { Insufficient: 0, Estimated: 1, Trusted: 2 };

interface CostInputRow {
  scope: string;
  cost_type: string;
  amount_minor: string | null;
  pct_bps: number | null;
  cost_confidence: CostConfidence;
}

/** revenue × pct_bps / 10000, integer (floor) — never float (I-S07). */
function pctOf(revenueMinor: bigint, pctBps: number): bigint {
  return (revenueMinor * BigInt(Math.trunc(pctBps))) / 10000n;
}

/**
 * computeContributionMargin — CM1/CM2 + cost_confidence for a brand as of a date.
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param asOf    - cumulative as-of date for revenue/spend.
 * @param deps    - { pool } for cost config (PG, RLS) + { srPool } for realized/spend (lakehouse).
 */
export async function computeContributionMargin(
  brandId: string,
  asOf: Date,
  deps: ContributionMarginDeps,
): Promise<ContributionMarginResult> {
  const asOfStr = asOf.toISOString().split('T')[0] as string;

  // ── ADR-0019 WS-3 D5: pre-baked mart read (flag SERVING_CONTRIB_MARGIN_FROM_MART, default OFF) ──
  // When ON, serve gold_contribution_margin (already built every Gold pass, one row per (brand,currency),
  // cumulative-to-the-Gold-pass, computing the identical CM math in the transform tier per the
  // single-query-ceiling doctrine). One thin brand-scoped read — no read-time recompute. Default OFF and
  // any override false → today's live recompute below (unchanged). Parity-gated to the money-byte.
  if (deps.fromMart ?? contribMarginFromMart()) {
    return readContributionMarginFromMart(brandId, deps);
  }

  // ── Config tier (operational PG, RLS-scoped): brand currency + cost_input rates ──
  const config = await withBrandTxn(deps.pool, brandId, async (client) => {
    const brandRow = await client.query<{ currency_code: string }>(
      `SELECT currency_code FROM brand WHERE id = $1`,
      [brandId],
    );
    if (!brandRow.rows[0]) return null;
    // Currently-effective cost inputs (global scope drives the brand-period blended rates).
    const costRes = await client.query<CostInputRow>(
      `SELECT scope, cost_type, amount_minor::text AS amount_minor, pct_bps, cost_confidence
         FROM cost_inputs_as_of($1::uuid, $2::date)
        WHERE scope = 'global'`,
      [brandId, asOfStr],
    );
    return {
      currencyCode: brandRow.rows[0].currency_code as CurrencyCode,
      costRows: costRes.rows,
    };
  });

  if (config === null) return emptyResult();
  const { currencyCode, costRows } = config;

  // ── Money tier (lakehouse, brand-scoped at the seam): realized + marketing spend ──
  const { netRevenueMinor, marketingMinor } = await withSilverBrand(deps.srPool, brandId, async (scope) => {
    // Realized cumulative ≤ as_of (the realized_gmv_as_of math): SUM(amount_minor) over
    // economic_effective_at ≤ as_of, excluding provisional. A net reversal stays honest (not clamped).
    const realizedRows = await scope.runScoped<{ v: string | number }>(
      `SELECT COALESCE(SUM(amount_minor), 0) AS v
         FROM brain_serving.mv_gold_revenue_ledger
        WHERE CAST(economic_effective_at AS DATE) <= DATE '${asOfStr}'
          AND event_type <> 'provisional_recognition'
          AND ${BRAND_PREDICATE}`,
      [],
    );
    const netRevenueMinor = BigInt(String(realizedRows[0]?.v ?? '0').split('.')[0] ?? '0');

    // Marketing = spend cumulative ≤ as_of (the ad_spend_as_of math), per currency. Single-currency
    // brand (M1): only the brand currency contributes; sum across platforms within that currency.
    const spendRows = await scope.runScoped<{ currency_code: string; spend_minor: string | number }>(
      `SELECT currency_code, SUM(spend_minor) AS spend_minor
         FROM brain_serving.mv_silver_marketing_spend
        WHERE stat_date <= DATE '${asOfStr}'
          -- GAP-C: the spend fact carries the SAME money at 'campaign', 'adset' AND 'ad' levels
          -- (children roll up to their campaign). Summing all levels ~3×-counts marketing and
          -- craters CM2. Pin to the canonical top-of-hierarchy 'campaign' level (mirrors gold_cac.py).
          AND level = 'campaign'
          AND ${BRAND_PREDICATE}
        GROUP BY currency_code`,
      [],
    );
    let marketingMinor = 0n;
    for (const s of spendRows) {
      if (s.currency_code === currencyCode) {
        marketingMinor += BigInt(String(s.spend_minor).split('.')[0] ?? '0');
      }
    }
    return { netRevenueMinor, marketingMinor };
  });

  // ── CM math (integer minor units; cost pcts applied to realized revenue) ──
  let cogsMinor = 0n;
  let variableCostMinor = 0n;
  let hasCogs = false;
  let confidenceFloor: number | null = null;
  for (const c of costRows) {
    // Brand-period CM uses pct inputs; a fixed per-order amount is per-order (M2 order_margin_fact).
    const cost = c.pct_bps !== null ? pctOf(netRevenueMinor, c.pct_bps) : 0n;
    if (c.cost_type === 'cogs') {
      cogsMinor += cost;
      hasCogs = true;
    } else if (VARIABLE_COST_TYPES.has(c.cost_type)) {
      variableCostMinor += cost;
    }
    const rank = CONFIDENCE_RANK[c.cost_confidence];
    confidenceFloor = confidenceFloor === null ? rank : Math.min(confidenceFloor, rank);
  }

  const cm1Minor = netRevenueMinor - cogsMinor - variableCostMinor;
  const cm2Minor = cm1Minor - marketingMinor;

  // cost_confidence: no COGS ⇒ Insufficient (can't trust margin); else the floor of input confidences.
  let costConfidence: CostConfidence;
  if (!hasCogs || confidenceFloor === null) {
    costConfidence = 'Insufficient';
  } else {
    costConfidence = (Object.keys(CONFIDENCE_RANK) as CostConfidence[]).find(
      (k) => CONFIDENCE_RANK[k] === confidenceFloor,
    ) ?? 'Insufficient';
  }

  return {
    hasData: netRevenueMinor !== 0n || costRows.length > 0,
    currencyCode,
    netRevenueMinor,
    cogsMinor,
    variableCostMinor,
    cm1Minor,
    marketingMinor,
    cm2Minor,
    costConfidence,
  };
}

/**
 * readContributionMarginFromMart — the ADR-0019 WS-3 D5 pre-baked read path.
 *
 * Reads the single (brand_id, currency_code) row from the pre-materialized mv_gold_contribution_margin
 * (brand-scoped via the ${BRAND_PREDICATE} seam). Every *_minor is bigint MINOR + the sibling
 * currency_code, carried verbatim from the mart — never re-derived, never blended. Honest no_data when
 * the brand has no mart row (hasData=false). A brand with multiple currency rows takes its own reporting
 * currency's row (the M1 single-currency invariant the mart itself credits marketing under); the mart
 * yields at most one row per (brand, currency), so the first row is the brand's realized-revenue row.
 */
async function readContributionMarginFromMart(
  brandId: string,
  deps: ContributionMarginDeps,
): Promise<ContributionMarginResult> {
  const row = await withSilverBrand(deps.srPool, brandId, async (scope) => {
    const rows = await scope.runScoped<{
      currency_code: string;
      net_revenue_minor: string | number;
      cogs_minor: string | number;
      variable_minor: string | number;
      cm1_minor: string | number;
      marketing_minor: string | number;
      cm2_minor: string | number;
      cost_confidence: string;
    }>(
      // The mart is one row per (brand, currency); order by realized revenue DESC so the brand's
      // reporting-currency row (the one carrying realized revenue + credited marketing) is first.
      `SELECT currency_code, net_revenue_minor, cogs_minor, variable_minor, cm1_minor,
              marketing_minor, cm2_minor, cost_confidence
         FROM brain_serving.mv_gold_contribution_margin
        WHERE ${BRAND_PREDICATE}
        ORDER BY net_revenue_minor DESC
        LIMIT 1`,
      [],
    );
    return rows[0] ?? null;
  });

  if (row === null) return emptyResult();

  const toBig = (v: string | number): bigint => BigInt(String(v).split('.')[0] ?? '0');
  const confidence: CostConfidence =
    row.cost_confidence === 'Trusted' || row.cost_confidence === 'Estimated' ? row.cost_confidence : 'Insufficient';
  const netRevenueMinor = toBig(row.net_revenue_minor);
  return {
    // hasData mirrors the recompute: realized revenue present OR a cost config exists (marketing/cogs>0).
    hasData: netRevenueMinor !== 0n || toBig(row.cogs_minor) !== 0n || toBig(row.marketing_minor) !== 0n,
    currencyCode: (row.currency_code as CurrencyCode) ?? null,
    netRevenueMinor,
    cogsMinor: toBig(row.cogs_minor),
    variableCostMinor: toBig(row.variable_minor),
    cm1Minor: toBig(row.cm1_minor),
    marketingMinor: toBig(row.marketing_minor),
    cm2Minor: toBig(row.cm2_minor),
    costConfidence: confidence,
  };
}

function emptyResult(): ContributionMarginResult {
  return {
    hasData: false,
    currencyCode: null,
    netRevenueMinor: 0n,
    cogsMinor: 0n,
    variableCostMinor: 0n,
    cm1Minor: 0n,
    marketingMinor: 0n,
    cm2Minor: 0n,
    costConfidence: 'Insufficient',
  };
}
