/**
 * @brain/metric-engine — getCustomerJourneySummary (V4 journey-intelligence Gold seam).
 *
 * The SOLE read seam for the journey-intelligence Gold mart (brain_serving.mv_gold_journey, over the
 * Iceberg gold_journey rollup) — read through withSilverBrand (brand predicate injected at the seam, I-ST01;
 * the engine is the only Gold reader, the UI never queries StarRocks). Returns a brand's journey-base
 * summary + a sample of its most-engaged journeys.
 *
 * BOUNDARY: this is the INTELLIGENCE-SIDE aggregate (counts/rates over the journey spine), DISTINCT from
 * the identity-side journey reconstruction (apps/core get-customer-360 graph stitch).
 *
 * NO MONEY: journeys are not monetary (the mart has no money column). Rates/scores are INTEGER 0-100,
 * NEVER blended with money. NO PII: brain_anon_id is the opaque pseudonymous journey key (never an
 * email/phone hash). Honest-empty: hasData=false when the brand has no journeys.
 *
 * @see packages/metric-engine/src/customer-360.ts (sibling Gold read) + silver-deps.ts (seam)
 * @see packages/metric-engine/src/journey-mix.ts (the per-touch Silver journey reads)
 */
import type { SilverPool } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';

export interface CustomerJourneyRow {
  /** The opaque pseudonymous journey/visitor key (never PII). */
  brainAnonId: string;
  touchpointCount: bigint;
  /** Distinct deterministic arrival channels (small count; integer). */
  distinctChannels: number;
  distinctSessions: bigint;
  firstChannel: string | null;
  lastChannel: string | null;
  /** Raw StarRocks DATETIME string (UTC); serialized verbatim. */
  firstTouchAt: string | null;
  lastTouchAt: string | null;
  converted: boolean;
  /** Whole days first-touch → conversion; null when not converted. */
  daysToConvert: number | null;
}

export interface CustomerJourneySummary {
  hasData: boolean;
  journeyCount: bigint;
  convertedJourneyCount: bigint;
  /** Conversion rate as an INTEGER percent 0-100 (integer math; never blended with money). */
  conversionRatePct: number;
  totalTouchpoints: bigint;
  /** Average touchpoints per journey, integer-floored; 0 when no journeys. */
  avgTouchpointsPerJourney: number;
  /** Average whole days-to-convert across converted journeys, integer-floored; null when none converted. */
  avgDaysToConvert: number | null;
  /** Most-engaged journeys (touchpoint_count desc), capped. */
  topJourneys: CustomerJourneyRow[];
}

const TOP_N = 10;

/** Normalize a StarRocks boolean (returned as 0/1 over the mysql wire, or a native boolean) → boolean. */
function asBool(v: unknown): boolean {
  return v === true || v === 1 || v === '1';
}

/** Normalize a possibly-null DB string field. */
function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s.length === 0 ? null : s;
}

export async function getCustomerJourneySummary(
  brandId: string,
  deps: { srPool: SilverPool },
): Promise<CustomerJourneySummary> {
  return withSilverBrand(deps.srPool, brandId, async (scope) => {
    const summaryRows = await scope.runScoped<{
      journey_count: string | number;
      converted_count: string | number;
      total_touchpoints: string | number;
      avg_days_to_convert: string | number | null;
    }>(
      `SELECT COUNT(*)                                            AS journey_count,
              COALESCE(SUM(CASE WHEN converted THEN 1 ELSE 0 END), 0) AS converted_count,
              COALESCE(SUM(touchpoint_count), 0)                 AS total_touchpoints,
              AVG(CASE WHEN converted THEN days_to_convert END)  AS avg_days_to_convert
         FROM brain_serving.mv_gold_journey
        WHERE ${BRAND_PREDICATE}`,
      [],
    );

    const s = summaryRows[0];
    const journeyCount = BigInt(String(s?.journey_count ?? '0'));
    if (journeyCount === 0n) {
      return {
        hasData: false,
        journeyCount: 0n,
        convertedJourneyCount: 0n,
        conversionRatePct: 0,
        totalTouchpoints: 0n,
        avgTouchpointsPerJourney: 0,
        avgDaysToConvert: null,
        topJourneys: [],
      };
    }

    const convertedJourneyCount = BigInt(String(s?.converted_count ?? '0'));
    const totalTouchpoints = BigInt(String(s?.total_touchpoints ?? '0'));

    // Integer-only rate (0-100) and integer-floored averages — no float ever stored/returned.
    const conversionRatePct = Number((convertedJourneyCount * 100n) / journeyCount);
    const avgTouchpointsPerJourney = Number(totalTouchpoints / journeyCount);
    const avgDaysToConvert =
      s?.avg_days_to_convert === null || s?.avg_days_to_convert === undefined
        ? null
        : Math.floor(Number(s.avg_days_to_convert));

    const topRows = await scope.runScoped<{
      brain_anon_id: string;
      touchpoint_count: string | number;
      distinct_channels: string | number;
      distinct_sessions: string | number;
      first_channel: string | null;
      last_channel: string | null;
      first_touch_at: string | null;
      last_touch_at: string | null;
      converted: number | boolean;
      days_to_convert: string | number | null;
    }>(
      `SELECT brain_anon_id, touchpoint_count, distinct_channels, distinct_sessions,
              first_channel, last_channel, first_touch_at, last_touch_at,
              converted, days_to_convert
         FROM brain_serving.mv_gold_journey
        WHERE ${BRAND_PREDICATE}
        ORDER BY touchpoint_count DESC
        LIMIT ${TOP_N}`,
      [],
    );

    return {
      hasData: true,
      journeyCount,
      convertedJourneyCount,
      conversionRatePct,
      totalTouchpoints,
      avgTouchpointsPerJourney,
      avgDaysToConvert,
      topJourneys: topRows.map((r) => ({
        brainAnonId: String(r.brain_anon_id),
        touchpointCount: BigInt(String(r.touchpoint_count)),
        distinctChannels: Number(r.distinct_channels),
        distinctSessions: BigInt(String(r.distinct_sessions)),
        firstChannel: str(r.first_channel),
        lastChannel: str(r.last_channel),
        firstTouchAt: str(r.first_touch_at),
        lastTouchAt: str(r.last_touch_at),
        converted: asBool(r.converted),
        daysToConvert:
          r.days_to_convert === null || r.days_to_convert === undefined
            ? null
            : Number(r.days_to_convert),
      })),
    };
  });
}
