/**
 * rto-risk.detector.ts — the first deterministic detector (doc 09).
 *
 * A DETECTOR is a pure function: certified signal in → an optional ranked ACTION out (a risk or
 * opportunity with confidence + evidence). No SQL, no model, no side effects — so it is trivially
 * unit-tested and replayable. RTO (return-to-origin) destroys realized CM2 and ties up cash, so an
 * elevated RTO rate is a RISK the COO should act on (doc 09: "RTO/refund/logistics risks with
 * severity + a concrete mitigation").
 *
 * Confidence is NEVER overstated (doc 09 Part 7): too little data → 'Insufficient' and the detector
 * SUPPRESSES (returns null) rather than cry wolf; a moderate sample → 'Estimated'; a large sample →
 * 'Trusted'. Below the rate threshold → no risk → null (and the caller expires any stale rec).
 */

/** Certified RTO signal (from rto_risk_signal_for_brand) — counts + RTO-impacted GMV (minor units). */
export interface RtoSignal {
  orderCount: number;
  rtoCount: number;
  rtoGmvMinor: bigint;
}

export type Confidence = 'Trusted' | 'Estimated' | 'Insufficient';

export interface DetectorRecommendation {
  detector: 'rto_risk';
  subject: string;
  kind: 'risk';
  confidence: Confidence;
  /** money-weighted ordering score (doc 09 Part 6); higher = more urgent. */
  priority: number;
  payload: {
    title: string;
    summary: string;
    recommended_action: string;
    evidence: {
      rto_count: number;
      order_count: number;
      rto_rate_pct: string;
      gmv_at_risk_minor: string;
    };
  };
}

/** Fire a risk above this RTO rate (3.0%). */
const RTO_RATE_THRESHOLD = 0.03;
/** Below this many orders the signal is too thin to act on → suppress (confidence Insufficient). */
const MIN_ORDERS_FOR_SIGNAL = 20;
/** At/above this many orders the rate is trustworthy. */
const TRUSTED_ORDER_FLOOR = 100;

function pct(n: number): string {
  return (n * 100).toFixed(2);
}

/**
 * Run the RTO-risk detector. Returns a recommendation when RTO is elevated on a sufficient sample,
 * else null (no risk, or not enough data to claim one).
 */
export function rtoRiskDetector(signal: RtoSignal): DetectorRecommendation | null {
  const { orderCount, rtoCount, rtoGmvMinor } = signal;

  // Not enough orders to claim a rate honestly → suppress (never overstate, doc 09 Part 7).
  if (orderCount < MIN_ORDERS_FOR_SIGNAL) {
    return null;
  }

  const rate = rtoCount / orderCount;
  if (rate < RTO_RATE_THRESHOLD) {
    return null; // RTO within tolerance — no risk to raise.
  }

  const confidence: Confidence = orderCount >= TRUSTED_ORDER_FLOOR ? 'Trusted' : 'Estimated';
  // Money-weighted priority: scale the RTO rate to a 0–1000 ordinal (evidence carries the ₹ figure).
  const priority = Math.min(1000, Math.round(rate * 1000));

  return {
    detector: 'rto_risk',
    subject: 'brand',
    kind: 'risk',
    confidence,
    priority,
    payload: {
      title: 'Elevated return-to-origin (RTO) rate',
      summary:
        `${pct(rate)}% of orders were returned-to-origin (${rtoCount} of ${orderCount}). ` +
        `RTO destroys realized CM2 and ties up cash and inventory.`,
      recommended_action:
        'Reduce RTO on high-risk orders: add address verification / COD confirmation at checkout, ' +
        'cap COD for new customers, and review the top RTO pincodes and couriers.',
      evidence: {
        rto_count: rtoCount,
        order_count: orderCount,
        rto_rate_pct: pct(rate),
        gmv_at_risk_minor: rtoGmvMinor.toString(),
      },
    },
  };
}
