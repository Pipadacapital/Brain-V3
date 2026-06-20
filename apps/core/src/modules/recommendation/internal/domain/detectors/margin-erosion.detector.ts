/**
 * margin-erosion.detector.ts — the CM2-grounded detector (doc 09; feat-decision-cm2-detector).
 *
 * Connects the True-CM2 moat to the Decide pillar: once a brand enters its cost structure, a NEGATIVE
 * or THIN contribution margin (CM2) is the most important thing a founder can act on — they're losing
 * money on every order or growing unprofitably. A pure function: the certified CM2 signal in → an
 * optional ranked risk out. The margin FORMULA (CM1/CM2 + the non-additive margin ratio) is computed
 * HERE in TS (ADR-004), mirroring computeContributionMargin; the SQL signal returns only raw aggregates.
 *
 * Confidence is NEVER overstated (doc 09 Part 7): no COGS entered ⇒ the margin can't be trusted ⇒
 * SUPPRESS (return null) rather than cry wolf. Healthy margin ⇒ null (and the caller expires any
 * stale rec). Money is BIGINT minor units (I-S07); the margin RATIO is the only float, used for the
 * threshold + ordering, never for money.
 */

/** Certified CM2 signal (from cm2_signal_for_brand) — raw aggregates; the detector derives the margin. */
export interface Cm2Signal {
  netRevenueMinor: bigint;
  marketingMinor: bigint;
  orderCount: number;
  cogsPctBps: number;       // Σ global COGS rate (basis points)
  variablePctBps: number;   // Σ global shipping/packaging/fee rates
  hasCogs: boolean;
  confidenceRank: number;   // 2 Trusted / 1 Estimated / 0 none
}

export type Confidence = 'Trusted' | 'Estimated' | 'Insufficient';

export interface DetectorRecommendation {
  detector: 'margin_erosion';
  subject: string;
  kind: 'risk';
  confidence: Confidence;
  priority: number;
  payload: {
    title: string;
    summary: string;
    recommended_action: string;
    evidence: {
      net_revenue_minor: string;
      cogs_minor: string;
      variable_cost_minor: string;
      cm1_minor: string;
      marketing_minor: string;
      cm2_minor: string;
      cm2_margin_pct: string;
      order_count: number;
    };
  };
}

/** Below this many realized orders the signal is too thin to claim a margin → suppress. */
const MIN_ORDERS_FOR_SIGNAL = 20;
/** A CM2 margin below this (10% of revenue) is "thin" → a medium risk. */
const THIN_MARGIN_THRESHOLD = 0.1;

function pctOf(revenueMinor: bigint, pctBps: number): bigint {
  return (revenueMinor * BigInt(Math.trunc(pctBps))) / 10000n;
}

/**
 * Run the margin-erosion detector. Returns a risk when CM2 is negative or thin on a trustworthy,
 * sufficient sample; else null (healthy margin, too little data, or no cost structure to trust).
 */
export function marginErosionDetector(signal: Cm2Signal): DetectorRecommendation | null {
  const { netRevenueMinor, marketingMinor, orderCount, cogsPctBps, variablePctBps, hasCogs, confidenceRank } = signal;

  // Not enough orders OR no revenue OR no COGS entered → can't claim a margin honestly → suppress.
  if (orderCount < MIN_ORDERS_FOR_SIGNAL || netRevenueMinor <= 0n || !hasCogs || confidenceRank <= 0) {
    return null;
  }

  const cogsMinor = pctOf(netRevenueMinor, cogsPctBps);
  const variableCostMinor = pctOf(netRevenueMinor, variablePctBps);
  const cm1Minor = netRevenueMinor - cogsMinor - variableCostMinor;
  const cm2Minor = cm1Minor - marketingMinor;
  const margin = Number(cm2Minor) / Number(netRevenueMinor); // ratio (non-additive) — TS only, never money

  // Healthy margin → no risk.
  if (cm2Minor >= 0n && margin >= THIN_MARGIN_THRESHOLD) {
    return null;
  }

  const confidence: Confidence = confidenceRank >= 2 ? 'Trusted' : 'Estimated';
  const losingMoney = cm2Minor < 0n;
  // Losing money is the top risk (priority 1000); a thin positive margin scales by how thin it is.
  const priority = losingMoney
    ? 1000
    : Math.min(900, Math.max(1, Math.round(((THIN_MARGIN_THRESHOLD - margin) / THIN_MARGIN_THRESHOLD) * 900)));
  const marginPct = (margin * 100).toFixed(2);

  return {
    detector: 'margin_erosion',
    subject: 'brand',
    kind: 'risk',
    confidence,
    priority,
    payload: {
      title: losingMoney ? 'Negative contribution margin (CM2) — losing money after costs' : 'Thin contribution margin (CM2)',
      summary: losingMoney
        ? `After COGS, variable costs and marketing, CM2 is negative (${marginPct}% of revenue). ` +
          `Every order is currently unprofitable at this cost structure.`
        : `CM2 is only ${marginPct}% of revenue — a thin margin that leaves little room for returns, ` +
          `discounts or rising ad costs.`,
      recommended_action: losingMoney
        ? 'Cut the biggest cost leak: renegotiate COGS/shipping, pause unprofitable ad spend (CM1 ' +
          'is below marketing), or raise price/AOV. Verify your entered cost rates are accurate.'
        : 'Protect the margin: trim variable costs, shift spend to higher-CM2 channels, or lift AOV ' +
          'with bundles before scaling ad spend.',
      evidence: {
        net_revenue_minor: netRevenueMinor.toString(),
        cogs_minor: cogsMinor.toString(),
        variable_cost_minor: variableCostMinor.toString(),
        cm1_minor: cm1Minor.toString(),
        marketing_minor: marketingMinor.toString(),
        cm2_minor: cm2Minor.toString(),
        cm2_margin_pct: marginPct,
        order_count: orderCount,
      },
    },
  };
}
