/**
 * @brain/metric-engine — getRecommendationFeatures (Gold recommendation-features seam).
 *
 * The SOLE read seam for the Gold recommendation-features mart
 * (brain_serving.mv_gold_recommendation_features) — read through withSilverBrand (brand predicate
 * injected at the seam, I-ST01; the engine is the only Gold reader, the UI never queries StarRocks).
 * Returns a brand's per-customer recommendation INPUT feature vectors (RFM + behavioural signals +
 * AFFINITY vectors) plus a brand-level summary.
 *
 * MONEY = BIGINT minor units (I-S07): monetaryMinor AND typicalPriceMinor are each paired with the row's
 * currencyCode and NEVER blended across currencies / NEVER a float. recency_days / frequency /
 * distinct_products / tenure_days / category_affinity_pct / discount_sensitivity_pct /
 * purchase_cadence_days are integer counts/ratios (never blended with money, never a confidence score).
 * NO PII: brainId is the only identity key. Honest-empty: hasData=false when the brand has no customers;
 * affinity fields degrade to null for a customer with no purchases/touches.
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
  /** Most-purchased SKU (brand-affinity proxy). Null when the customer has no purchased lines. */
  favouriteBrand: string | null;
  /** Most-browsed collection handle. Null when no category-bearing touches. */
  favouriteCategory: string | null;
  /** Concentration (0-100) of category touches on favouriteCategory. Null when no category touches. */
  categoryAffinityPct: number | null;
  /** Modal purchased unit price in minor units — paired with currencyCode. Null when no purchases. */
  typicalPriceMinor: bigint | null;
  /** Price band of the typical purchase: 'budget' | 'mid' | 'premium' | 'luxury'. Null when no purchases. */
  priceAffinityBand: string | null;
  /** Share (0-100) of the customer's orders that carried a discount. Null when no purchases. */
  discountSensitivityPct: number | null;
  /** Most-frequent device_class. Null when no bridged pageviews. */
  devicePreference: string | null;
  /** Average days between orders. Null for customers with fewer than 2 orders. */
  purchaseCadenceDays: number | null;
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

/**
 * Parse a possibly-null minor-unit money value to bigint | null — truncating any decimal formatting the
 * driver may emit (e.g. '500000.00' → 500000n). NEVER a float. Null stays null (no purchases → no price).
 */
function toMinorOrNull(v: string | number | null): bigint | null {
  if (v === null || v === undefined) return null;
  return BigInt(String(v).split('.')[0] ?? '0');
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
      favourite_brand: string | null;
      favourite_category: string | null;
      category_affinity_pct: string | number | null;
      typical_price_minor: string | number | null;
      price_affinity_band: string | null;
      discount_sensitivity_pct: string | number | null;
      device_preference: string | null;
      purchase_cadence_days: string | number | null;
    }>(
      `SELECT brain_id, recency_days, frequency, monetary_minor, currency_code,
              top_channel, distinct_products, tenure_days,
              favourite_brand, favourite_category, category_affinity_pct,
              typical_price_minor, price_affinity_band, discount_sensitivity_pct,
              device_preference, purchase_cadence_days
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
        favouriteBrand: r.favourite_brand ?? null,
        favouriteCategory: r.favourite_category ?? null,
        categoryAffinityPct: toIntOrNull(r.category_affinity_pct),
        typicalPriceMinor: toMinorOrNull(r.typical_price_minor),
        priceAffinityBand: r.price_affinity_band ?? null,
        discountSensitivityPct: toIntOrNull(r.discount_sensitivity_pct),
        devicePreference: r.device_preference ?? null,
        purchaseCadenceDays: toIntOrNull(r.purchase_cadence_days),
      })),
    };
  });
}
