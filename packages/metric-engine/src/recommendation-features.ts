/**
 * @brain/metric-engine — getRecommendationFeatures (Gold recommendation-features seam).
 *
 * The SOLE read seam for the Gold recommendation-features mart
 * (brain_serving.mv_gold_recommendation_features) — read through withSilverBrand (brand predicate
 * injected at the seam, I-ST01; the engine is the only Gold reader, the UI never queries StarRocks).
 * Returns a brand's per-customer recommendation INPUT feature vectors (RFM + behavioural signals) plus a
 * brand-level summary.
 *
 * MONEY = BIGINT minor units (I-S07): monetaryMinor is paired with currencyCode and NEVER blended across
 * currencies / NEVER a float. recency_days / frequency / distinct_products / tenure_days are integer
 * counts (never blended with money). NO PII: brainId is the only identity key. Honest-empty:
 * hasData=false when the brand has no customers.
 *
 * @see packages/metric-engine/src/customer-360.ts (sibling Gold read) + silver-deps.ts (seam)
 */
import type { SilverPool } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';

export interface RecommendationFeatureRow {
  brainId: string;
  /** Days since the customer's last order. Null when no last-seen timestamp. */
  recencyDays: number | null;
  /** Lifetime order count (the F of RFM). */
  frequency: bigint;
  /** Lifetime value in minor units (the M of RFM) — paired with currencyCode. */
  monetaryMinor: bigint;
  currencyCode: string | null;
  /** The customer's most-frequent journey channel. Null when no stitched touchpoints. */
  topChannel: string | null;
  /** Distinct product handles the customer browsed. */
  distinctProducts: bigint;
  /** Days since the customer was first seen. Null when no first-seen timestamp. */
  tenureDays: number | null;
}

export interface RecommendationFeaturesResult {
  hasData: boolean;
  customerCount: bigint;
  /** Top customers' feature rows, ordered by monetaryMinor desc, capped. */
  rows: RecommendationFeatureRow[];
}

const TOP_N = 50;

/** Parse a possibly-null integer day count from the driver (number | string | null) to number | null. */
function toIntOrNull(v: string | number | null): number | null {
  if (v === null || v === undefined) return null;
  const n = Number.parseInt(String(v), 10);
  return Number.isNaN(n) ? null : n;
}

export async function getRecommendationFeatures(
  brandId: string,
  deps: { srPool: SilverPool },
): Promise<RecommendationFeaturesResult> {
  return withSilverBrand(deps.srPool, brandId, async (scope) => {
    const countRows = await scope.runScoped<{ customer_count: string | number }>(
      `SELECT COUNT(*) AS customer_count
         FROM brain_serving.mv_gold_recommendation_features
        WHERE ${BRAND_PREDICATE}`,
      [],
    );

    const customerCount = BigInt(String(countRows[0]?.customer_count ?? '0'));
    if (customerCount === 0n) {
      return { hasData: false, customerCount: 0n, rows: [] };
    }

    const featureRows = await scope.runScoped<{
      brain_id: string;
      recency_days: string | number | null;
      frequency: string | number;
      monetary_minor: string | number;
      currency_code: string | null;
      top_channel: string | null;
      distinct_products: string | number;
      tenure_days: string | number | null;
    }>(
      `SELECT brain_id, recency_days, frequency, monetary_minor, currency_code,
              top_channel, distinct_products, tenure_days
         FROM brain_serving.mv_gold_recommendation_features
        WHERE ${BRAND_PREDICATE}
        ORDER BY monetary_minor DESC, brain_id ASC
        LIMIT ${TOP_N}`,
      [],
    );

    return {
      hasData: true,
      customerCount,
      rows: featureRows.map((r) => ({
        brainId: r.brain_id,
        recencyDays: toIntOrNull(r.recency_days),
        frequency: BigInt(String(r.frequency ?? '0')),
        monetaryMinor: BigInt(String(r.monetary_minor ?? '0').split('.')[0] ?? '0'),
        currencyCode: r.currency_code ?? null,
        topChannel: r.top_channel ?? null,
        distinctProducts: BigInt(String(r.distinct_products ?? '0')),
        tenureDays: toIntOrNull(r.tenure_days),
      })),
    };
  });
}
