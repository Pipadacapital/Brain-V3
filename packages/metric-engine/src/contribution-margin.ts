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
 * pct_bps inputs (per-SKU/per-order fixed costs are the M2 order_margin_fact refinement). Reads go
 * through the named as-of seams (realized_gmv_as_of, cost_inputs_as_of, ad_spend_as_of) under
 * withBrandTxn (RLS-scoped; brand from session). NO ad-hoc SUM here.
 *
 * cost_confidence: the FLOOR over the brand's cost_input confidences. With NO cogs input the margin
 * cannot be trusted → 'Insufficient' (the honest 'D' that keeps the billing cap from applying).
 */
import type { CurrencyCode } from '@brain/money';
import type { EngineDeps } from './deps.js';
import { withBrandTxn } from './deps.js';

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
 * @param deps    - EngineDeps with the raw pg.Pool.
 */
export async function computeContributionMargin(
  brandId: string,
  asOf: Date,
  deps: EngineDeps,
): Promise<ContributionMarginResult> {
  const asOfStr = asOf.toISOString().split('T')[0] as string;

  return withBrandTxn(deps.pool, brandId, async (client) => {
    const brandRow = await client.query<{ currency_code: string }>(
      `SELECT currency_code FROM brand WHERE id = $1`,
      [brandId],
    );
    if (!brandRow.rows[0]) {
      return emptyResult();
    }
    const currencyCode = brandRow.rows[0].currency_code as CurrencyCode;

    // Net revenue (the named seam; nets refunds/reversals via signed rows).
    const revRes = await client.query<{ v: string }>(
      `SELECT realized_gmv_as_of($1::uuid, $2::date) AS v`,
      [brandId, asOfStr],
    );
    const netRevenueMinor = BigInt(revRes.rows[0]?.v ?? '0');

    // Currently-effective cost inputs (global scope drives the brand-period blended rates).
    const costRes = await client.query<CostInputRow>(
      `SELECT scope, cost_type, amount_minor::text AS amount_minor, pct_bps, cost_confidence
         FROM cost_inputs_as_of($1::uuid, $2::date)
        WHERE scope = 'global'`,
      [brandId, asOfStr],
    );

    let cogsMinor = 0n;
    let variableCostMinor = 0n;
    let hasCogs = false;
    let confidenceFloor: number | null = null;
    for (const c of costRes.rows) {
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

    // Marketing = ad spend cumulative to asOf (matches the cumulative revenue grain), brand currency.
    const spendRes = await client.query<{ spend_minor: string; currency_code: string }>(
      `SELECT spend_minor::text AS spend_minor, currency_code
         FROM ad_spend_as_of($1::uuid, $2::date, $3::date)`,
      [brandId, '2000-01-01', asOfStr],
    );
    let marketingMinor = 0n;
    for (const s of spendRes.rows) {
      // Single-currency brand (M1): spend is in the brand currency; sum across platforms.
      if (s.currency_code === currencyCode) marketingMinor += BigInt(s.spend_minor);
    }

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
      hasData: netRevenueMinor !== 0n || costRes.rows.length > 0,
      currencyCode,
      netRevenueMinor,
      cogsMinor,
      variableCostMinor,
      cm1Minor,
      marketingMinor,
      cm2Minor,
      costConfidence,
    };
  });
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
