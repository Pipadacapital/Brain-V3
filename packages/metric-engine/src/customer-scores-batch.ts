/**
 * @brain/metric-engine — customer-scores BATCH read seam + deterministic lifecycle-segment derivation.
 *
 * Backs the Customers BROWSE list (IA tab #2): the identity graph (Neo4j) owns the customer ROWS, but
 * each row's BUSINESS signals — lifetime value, order count, and the named RFM/lifecycle SEGMENT — live
 * in the deterministic Gold mart `gold_customer_scores` (read here via brain_serving.mv_gold_customer_scores
 * over Trino/Iceberg, through withSilverBrand so the ${BRAND_PREDICATE} brand seam is injected, I-ST01).
 *
 * Two read shapes, ONE source mart + ONE derivation:
 *   • getCustomerScoresForBrainIds — enrich the CURRENT page: given the page's brain_ids, return a map
 *     brain_id → { segment, ltvMinor, currencyCode, orderCount } (a cheap `brain_id IN (...)` read).
 *   • getCustomerSegmentMembers   — the segment FILTER: the full set of brain_ids whose derived lifecycle
 *     segment matches `segment`, so the identity reader can paginate/search WITHIN that allowlist (the
 *     filter is applied at the mart, pagination stays in the graph — no cross-store paging hazard).
 *
 * MONEY (I-S07): ltvMinor is bigint MINOR units paired with its sibling currencyCode (the customer's own
 * currency, carried verbatim from the mart) — never a float, never blended across currencies.
 *
 * SEGMENT is DETERMINISTIC, NOT ML: `deriveLifecycleSegment` reproduces — in TypeScript — the EXACT
 * first-match precedence ladder of db/iceberg/spark/gold/_segment_rules.py (the Spark mart's single source
 * of truth), over the same three base signals the mart carries (days_since_last_order / lifetime_orders /
 * lifetime_value_minor). Thresholds are mirrored as named constants so they cannot silently drift. Null
 * recency follows SQL three-valued logic (a null `days_since_last_order` makes every recency comparison
 * false — it never matches churned/at_risk/VIP/loyal, it falls through to the value/frequency ladder).
 *
 * @see packages/metric-engine/src/customer-score.ts        — the single-customer score read (sibling)
 * @see packages/metric-engine/src/customer-segments.ts     — the per-segment AGGREGATE rollup (sibling)
 * @see db/iceberg/spark/gold/_segment_rules.py             — the Spark single source of truth for the ladder
 */
import type { SilverPool } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';

/** The named lifecycle/behavioral segments (segment_type='lifecycle' in gold_customer_segments). */
export type LifecycleSegment =
  | 'VIP'
  | 'high_value'
  | 'loyal'
  | 'first_time_buyer'
  | 'at_risk'
  | 'churned'
  | 'cart_abandoner'
  | 'window_shopper';

/** The exhaustive, ordered set of valid lifecycle-segment filter values (mirrors _segment_rules LIFECYCLE_LABELS). */
export const LIFECYCLE_SEGMENTS: readonly LifecycleSegment[] = [
  'VIP',
  'high_value',
  'loyal',
  'first_time_buyer',
  'at_risk',
  'churned',
  'cart_abandoner',
  'window_shopper',
] as const;

// ── Threshold constants — MIRRORED from _segment_rules.py (single-sourced; must not drift) ──────────
const RECENCY_VIP_MAX_DAYS = 60;
const RECENCY_ACTIVE_MAX_DAYS = 90;
const RECENCY_AT_RISK_MAX_DAYS = 180;
const FREQUENCY_LOYAL_MIN_ORDERS = 5n;
const MONETARY_VIP_MIN_MINOR = 10_000_000n;
const MONETARY_HIGH_MIN_MINOR = 5_000_000n;

/** True for a valid lifecycle-segment filter value. */
export function isLifecycleSegment(v: string): v is LifecycleSegment {
  return (LIFECYCLE_SEGMENTS as readonly string[]).includes(v);
}

/**
 * deriveLifecycleSegment — the deterministic first-match precedence ladder (TS mirror of
 * _segment_rules.lifecycle_segment_case_sql). Pure: same inputs → same label, always.
 *
 * recencyDays = days_since_last_order (null when last_seen is unknown — recency comparisons then
 * evaluate false, exactly as the Spark SQL's NULL three-valued logic does). lifetimeOrders and
 * lifetimeValueMinor are bigint (orders count; MINOR-unit realized value).
 */
export function deriveLifecycleSegment(
  recencyDays: number | null,
  lifetimeOrders: bigint,
  lifetimeValueMinor: bigint,
): LifecycleSegment {
  const recent = recencyDays !== null;
  if (recent && recencyDays > RECENCY_AT_RISK_MAX_DAYS) return 'churned';
  if (recent && recencyDays > RECENCY_ACTIVE_MAX_DAYS) return 'at_risk';
  if (
    lifetimeValueMinor >= MONETARY_VIP_MIN_MINOR &&
    lifetimeOrders >= FREQUENCY_LOYAL_MIN_ORDERS &&
    recent &&
    recencyDays <= RECENCY_VIP_MAX_DAYS
  ) {
    return 'VIP';
  }
  if (lifetimeOrders >= FREQUENCY_LOYAL_MIN_ORDERS && recent && recencyDays <= RECENCY_ACTIVE_MAX_DAYS) {
    return 'loyal';
  }
  if (lifetimeValueMinor >= MONETARY_HIGH_MIN_MINOR) return 'high_value';
  if (lifetimeOrders === 1n && lifetimeValueMinor > 0n) return 'first_time_buyer';
  if (lifetimeValueMinor === 0n) return 'cart_abandoner';
  return 'window_shopper';
}

/** One enriched score row, keyed by brain_id, for a customer-list page. */
export interface CustomerScoreEnrichment {
  segment: LifecycleSegment;
  /** Lifetime realized value in bigint MINOR units (carried as string for BigInt-safe JSON). */
  ltvMinor: string;
  /** Sibling currency for ltvMinor — never blended (the customer's own currency). Null = no money signal. */
  currencyCode: string | null;
  orderCount: number;
}

function toBigIntFloor(raw: string | number | null | undefined): bigint {
  return BigInt(String(raw ?? '0').split('.')[0] ?? '0');
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}

/**
 * getCustomerScoresForBrainIds — enrich a page of customers with segment + LTV + order_count.
 *
 * Returns a Map brain_id → enrichment for the brain_ids present in the scores mart. brain_ids with no
 * scores row are simply absent from the map (honest-empty per row — the caller renders "—", never a
 * fabricated segment). Empty input → empty map (no query). Brand from session (D-1).
 */
export async function getCustomerScoresForBrainIds(
  brandId: string,
  brainIds: string[],
  deps: { srPool: SilverPool },
): Promise<Map<string, CustomerScoreEnrichment>> {
  const ids = brainIds.filter((x) => typeof x === 'string' && x.length > 0);
  if (ids.length === 0) return new Map();

  return withSilverBrand(deps.srPool, brandId, async (scope) => {
    const rows = await scope.runScoped<{
      brain_id: string;
      currency_code: string | null;
      lifetime_orders: string | number | null;
      lifetime_value_minor: string | number | null;
      days_since_last_order: string | number | null;
    }>(
      // BRAND_PREDICATE must be the LAST placeholder — the seam APPENDS brandId to the param list, so the
      // caller's own placeholders (the IN list) come first, then brand_id = ? last.
      `SELECT brain_id, currency_code, lifetime_orders, lifetime_value_minor, days_since_last_order
         FROM brain_serving.mv_gold_customer_scores
        WHERE brain_id IN (${placeholders(ids.length)}) AND ${BRAND_PREDICATE}`,
      ids,
    );

    const out = new Map<string, CustomerScoreEnrichment>();
    for (const r of rows) {
      const orders = toBigIntFloor(r.lifetime_orders);
      const ltv = toBigIntFloor(r.lifetime_value_minor);
      const recency =
        r.days_since_last_order === null || r.days_since_last_order === undefined
          ? null
          : Number(r.days_since_last_order);
      out.set(r.brain_id, {
        segment: deriveLifecycleSegment(recency, orders, ltv),
        ltvMinor: ltv.toString(),
        currencyCode: r.currency_code ?? null,
        orderCount: Number(orders),
      });
    }
    return out;
  });
}

/**
 * getCustomerSegmentMembers — the brain_ids whose derived lifecycle segment === `segment`.
 *
 * The segment FILTER seam: the identity reader paginates/searches WITHIN this allowlist, so the named
 * RFM segment is resolved at the mart while the graph keeps owning pagination/search/total (no cross-store
 * paging hazard). Scans the brand's score rows (one per customer) and derives the segment in TS with the
 * SAME ladder the per-row enrichment uses — so the filter and the displayed chip are always consistent.
 *
 * Bounded by `cap` (default 50_000 customers) to avoid pathological memory; brands beyond the cap get the
 * first `cap` members (documented limit). Empty brand / unavailable tier → [] (honest-empty).
 */
export async function getCustomerSegmentMembers(
  brandId: string,
  segment: LifecycleSegment,
  deps: { srPool: SilverPool },
  cap = 50_000,
): Promise<string[]> {
  return withSilverBrand(deps.srPool, brandId, async (scope) => {
    const rows = await scope.runScoped<{
      brain_id: string;
      lifetime_orders: string | number | null;
      lifetime_value_minor: string | number | null;
      days_since_last_order: string | number | null;
    }>(
      `SELECT brain_id, lifetime_orders, lifetime_value_minor, days_since_last_order
         FROM brain_serving.mv_gold_customer_scores
        WHERE ${BRAND_PREDICATE}
        LIMIT ${cap}`,
      [],
    );

    const members: string[] = [];
    for (const r of rows) {
      const recency =
        r.days_since_last_order === null || r.days_since_last_order === undefined
          ? null
          : Number(r.days_since_last_order);
      const seg = deriveLifecycleSegment(recency, toBigIntFloor(r.lifetime_orders), toBigIntFloor(r.lifetime_value_minor));
      if (seg === segment) members.push(r.brain_id);
    }
    return members;
  });
}
