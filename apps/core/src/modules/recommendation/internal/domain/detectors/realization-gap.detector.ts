/**
 * realization-gap.detector.ts — a deterministic RISK detector (doc 09).
 *
 * Recognized-but-not-settled revenue is cash at risk: orders are recognized provisionally, but the
 * money only realizes on settlement. A large unsettled share means a settlement/reconciliation gap
 * (a missing settlement connector, payout delays, or finalization not running) — the CFO/finance
 * owner should act. Pure function: certified signal in → optional ranked action out.
 *
 * Confidence is never overstated: too few orders → suppress; large sample → Trusted.
 */

export type Confidence = 'Trusted' | 'Estimated' | 'Insufficient';

export interface RealizationSignal {
  provisionalMinor: bigint;
  realizedMinor: bigint;
  orderCount: number;
}

export interface DetectorRecommendation {
  detector: 'realization_gap';
  subject: string;
  kind: 'risk';
  confidence: Confidence;
  priority: number;
  payload: {
    title: string;
    summary: string;
    recommended_action: string;
    evidence: {
      provisional_minor: string;
      realized_minor: string;
      unsettled_minor: string;
      unsettled_share_pct: string;
      order_count: number;
    };
  };
}

/** Flag when more than this share of recognized GMV is unsettled (60%). */
const UNSETTLED_THRESHOLD = 0.6;
const MIN_ORDERS_FOR_SIGNAL = 20;
const TRUSTED_ORDER_FLOOR = 100;

function pct(n: number): string {
  return (n * 100).toFixed(2);
}

export function realizationGapDetector(signal: RealizationSignal): DetectorRecommendation | null {
  const { provisionalMinor, realizedMinor, orderCount } = signal;
  if (orderCount < MIN_ORDERS_FOR_SIGNAL || provisionalMinor <= 0n) {
    return null;
  }

  const unsettled = provisionalMinor - realizedMinor; // recognized but not yet realized
  if (unsettled <= 0n) return null; // fully (or over-) settled — no gap

  const share = Number(unsettled) / Number(provisionalMinor);
  if (share < UNSETTLED_THRESHOLD) return null;

  const confidence: Confidence = orderCount >= TRUSTED_ORDER_FLOOR ? 'Trusted' : 'Estimated';
  const priority = Math.min(1000, Math.round(share * 1000));

  return {
    detector: 'realization_gap',
    subject: 'brand',
    kind: 'risk',
    confidence,
    priority,
    payload: {
      title: 'Revenue recognized but not settled',
      summary:
        `${pct(share)}% of recognized GMV across ${orderCount} orders has not realized yet — ` +
        `recognized revenue is sitting unsettled (cash not in the bank).`,
      recommended_action:
        'Connect/repair the settlement source (e.g. Razorpay) and ensure revenue-finalization is ' +
        'running, then reconcile payouts so recognized orders realize on schedule.',
      evidence: {
        provisional_minor: provisionalMinor.toString(),
        realized_minor: realizedMinor.toString(),
        unsettled_minor: unsettled.toString(),
        unsettled_share_pct: pct(share),
        order_count: orderCount,
      },
    },
  };
}
