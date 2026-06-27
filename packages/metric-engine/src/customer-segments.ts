/**
 * @brain/metric-engine — getCustomerSegments (Brain V4 customer-segments Gold read seam).
 *
 * The SOLE read seam for the deterministic customer-segments Gold mart
 * (brain_serving.mv_gold_customer_segments over Iceberg brain_gold.gold_customer_segments) — read
 * through withSilverBrand (brand predicate injected at the seam, I-ST01; the engine is the only Gold
 * reader, the UI never queries the serving store directly).
 *
 * The mart carries TWO orthogonal segment dimensions on one (brand_id, segment_type, segment) rollup,
 * disambiguated by segment_type:
 *   • 'value_tier' — high_value / mid_value / low_value / no_realized_value (the value ladder)
 *   • 'lifecycle'  — VIP / high_value / loyal / first_time_buyer / at_risk / churned / cart_abandoner /
 *                    window_shopper (the named behavioral ladder; a customer holds exactly ONE primary
 *                    lifecycle segment, assigned by a deterministic first-match precedence — see
 *                    db/iceberg/spark/gold/_segment_rules.py).
 * The label 'high_value' appears in BOTH ladders, so EVERY query here filters segment_type to avoid
 * double-counting (this is why a bare reader must never sum customer_count across all rows).
 *
 * MONEY: segmentValueMinor is a bigint MINOR-unit Σ (no currency_code at this grain — it sums across a
 * brand's currencies into one per-segment bucket; never a float, never blended across brands). It is
 * carried as a descriptive bigint only.
 *
 * Honest-empty: hasData=false when the brand has no segmented customers.
 * @see packages/metric-engine/src/customer-health.ts (sibling deterministic Gold read seam)
 */
import type { SilverPool } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';

/** The named lifecycle/behavioral segments (segment_type='lifecycle'). */
export type LifecycleSegment =
  | 'VIP'
  | 'high_value'
  | 'loyal'
  | 'first_time_buyer'
  | 'at_risk'
  | 'churned'
  | 'cart_abandoner'
  | 'window_shopper';

/** The value-tier segments (segment_type='value_tier') — the existing, unchanged ladder. */
export type ValueTier = 'high_value' | 'mid_value' | 'low_value' | 'no_realized_value';

export type SegmentType = 'value_tier' | 'lifecycle';

export interface SegmentRow {
  segmentType: SegmentType;
  segment: string;
  customerCount: bigint;
  /** bigint MINOR-unit Σ; no currency_code at this grain (descriptive only — never blended across brands). */
  segmentValueMinor: bigint;
}

export interface CustomerSegmentsSummary {
  hasData: boolean;
  /** Lifecycle ladder rows (segment_type='lifecycle'), ordered by customer_count desc. */
  lifecycle: SegmentRow[];
  /** Value-tier ladder rows (segment_type='value_tier'), ordered by customer_count desc. */
  valueTiers: SegmentRow[];
}

function toBigIntFloor(raw: string | number | null | undefined): bigint {
  return BigInt(String(raw ?? '0').split('.')[0] ?? '0');
}

export async function getCustomerSegments(
  brandId: string,
  deps: { srPool: SilverPool },
): Promise<CustomerSegmentsSummary> {
  return withSilverBrand(deps.srPool, brandId, async (scope) => {
    const rows = await scope.runScoped<{
      segment_type: string;
      segment: string;
      customer_count: string | number;
      segment_value_minor: string | number | null;
    }>(
      `SELECT segment_type, segment, customer_count, segment_value_minor
         FROM brain_serving.mv_gold_customer_segments
        WHERE ${BRAND_PREDICATE}
        ORDER BY segment_type, customer_count DESC`,
      [],
    );

    if (rows.length === 0) {
      return { hasData: false, lifecycle: [], valueTiers: [] };
    }

    const lifecycle: SegmentRow[] = [];
    const valueTiers: SegmentRow[] = [];
    for (const r of rows) {
      const mapped: SegmentRow = {
        segmentType: r.segment_type === 'lifecycle' ? 'lifecycle' : 'value_tier',
        segment: r.segment,
        customerCount: toBigIntFloor(r.customer_count),
        segmentValueMinor: toBigIntFloor(r.segment_value_minor),
      };
      if (mapped.segmentType === 'lifecycle') lifecycle.push(mapped);
      else valueTiers.push(mapped);
    }

    return { hasData: true, lifecycle, valueTiers };
  });
}
