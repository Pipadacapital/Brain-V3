/**
 * @brain/metric-engine — getAiFeatures (V4 Gold ai_features serving seam).
 *
 * The SOLE read seam for the Gold AI/ML feature mart (brain_gold.gold_ai_features) — served via
 * brain_serving.mv_gold_ai_features and read here through withSilverBrand (brand predicate injected at
 * the seam, I-ST01). Returns a brand's compact, deterministic per-customer feature vector for downstream
 * models — NO model inference happens here; the mart is a RUNTIME Silver fold, never the banned
 * feature-precompute table.
 *
 * MONEY = BIGINT minor units + sibling currencyCode (I-S07); lifetimeValueMinor / avgOrderValueMinor are
 * per-currency (never blended, never float). Scores/counts (orderCount, distinctChannels, recencyDays)
 * are NEVER blended with money. Honest-empty: hasData=false when the brand has no feature rows.
 *
 * @see packages/metric-engine/src/customer-360.ts (sibling Gold (brand_id, brain_id) read) + silver-deps.ts
 */
import type { SilverPool } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';

export interface AiFeatureRow {
  brainId: string;
  /** Lifetime resolved order count. */
  orderCount: bigint;
  /** Σ recognized order value, MINOR units, in currencyCode. */
  lifetimeValueMinor: bigint;
  /** lifetimeValueMinor integer-divided by orderCount (per-currency, never float). MINOR units. */
  avgOrderValueMinor: bigint;
  /** ISO-4217 currency — the sibling for BOTH money columns. */
  currencyCode: string | null;
  /** Whole days since the customer's last order/state effective date. Null = no order date. */
  recencyDays: number | null;
  /** Distinct deterministic marketing channels this customer's stitched journey reached. */
  distinctChannels: bigint;
  /** Has the customer converted (≥1 order OR a stitched-journey conversion). */
  convertedFlag: boolean;
}

export interface AiFeaturesResult {
  hasData: boolean;
  /** Total (brand_id, brain_id) feature rows for the brand. */
  featureCount: bigint;
  /** How many of those customers carry convertedFlag=true. */
  convertedCount: bigint;
  /** Dominant currency across the brand's feature rows (display/grouping hint; per-row currency is authoritative). */
  currencyCode: string | null;
  /** The feature vector rows, ordered by lifetimeValueMinor desc, capped at `limit`. */
  features: AiFeatureRow[];
}

/** Default cap on the number of feature rows returned in one read. */
const DEFAULT_LIMIT = 500;

export interface AiFeaturesOptions {
  /** Cap on returned feature rows (1..5000). Defaults to 500. */
  readonly limit?: number;
}

function sanitizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  const n = Math.trunc(limit);
  if (n < 1) return 1;
  if (n > 5000) return 5000;
  return n;
}

export async function getAiFeatures(
  brandId: string,
  deps: { srPool: SilverPool },
  opts: AiFeaturesOptions = {},
): Promise<AiFeaturesResult> {
  const limit = sanitizeLimit(opts.limit);

  return withSilverBrand(deps.srPool, brandId, async (scope) => {
    const summaryRows = await scope.runScoped<{
      feature_count: string | number;
      converted_count: string | number;
      currency_code: string | null;
    }>(
      `SELECT COUNT(*)                              AS feature_count,
              COALESCE(SUM(IF(converted_flag, 1, 0)), 0) AS converted_count,
              MAX(currency_code)                    AS currency_code
         FROM brain_serving.mv_gold_ai_features
        WHERE ${BRAND_PREDICATE}`,
      [],
    );

    const s = summaryRows[0];
    const featureCount = BigInt(String(s?.feature_count ?? '0'));
    if (featureCount === 0n) {
      return {
        hasData: false,
        featureCount: 0n,
        convertedCount: 0n,
        currencyCode: null,
        features: [],
      };
    }

    const rows = await scope.runScoped<{
      brain_id: string;
      order_count: string | number;
      lifetime_value_minor: string | number;
      avg_order_value_minor: string | number;
      currency_code: string | null;
      recency_days: string | number | null;
      distinct_channels: string | number;
      converted_flag: number | boolean | null;
    }>(
      `SELECT brain_id, order_count, lifetime_value_minor, avg_order_value_minor,
              currency_code, recency_days, distinct_channels, converted_flag
         FROM brain_serving.mv_gold_ai_features
        WHERE ${BRAND_PREDICATE}
        ORDER BY lifetime_value_minor DESC
        LIMIT ${limit}`,
      [],
    );

    return {
      hasData: true,
      featureCount,
      convertedCount: BigInt(String(s?.converted_count ?? '0').split('.')[0] ?? '0'),
      currencyCode: s?.currency_code ?? null,
      features: rows.map((r) => ({
        brainId: r.brain_id,
        orderCount: BigInt(String(r.order_count ?? '0')),
        lifetimeValueMinor: BigInt(String(r.lifetime_value_minor ?? '0').split('.')[0] ?? '0'),
        avgOrderValueMinor: BigInt(String(r.avg_order_value_minor ?? '0').split('.')[0] ?? '0'),
        currencyCode: r.currency_code ?? null,
        recencyDays: r.recency_days === null || r.recency_days === undefined ? null : Number(r.recency_days),
        distinctChannels: BigInt(String(r.distinct_channels ?? '0')),
        convertedFlag: r.converted_flag === true || Number(r.converted_flag) === 1,
      })),
    };
  });
}
