/**
 * scale-opportunity.detector.ts — the first deterministic OPPORTUNITY detector (H1/M5/M6).
 *
 * The detector layer was risk-only (RTO, realization gap, margin erosion). H1 asks for deterministic
 * OPPORTUNITY recommendations — not just "what's bleeding" but "what to lean into". This detector
 * reuses the EXISTING certified CM2 signal (cm2_signal_for_brand — no new model, no new SQL function):
 * when contribution margin is HEALTHY and TRUSTWORTHY on a sufficient sample, a brand has profitable
 * unit economics and headroom to scale — a concrete, money-grounded opportunity for the founder.
 *
 * DETERMINISTIC + HONEST (doc 09 Part 7, Brain's no-fake-ML rule): a pure function over the certified
 * signal — no model, no forecast, no fabricated propensity. Confidence is never overstated: no COGS or
 * a thin sample ⇒ SUPPRESS (return null) rather than urge someone to spend more on unverified margin.
 * The CM2 FORMULA mirrors marginErosionDetector exactly (the same numbers, opposite trigger), so a
 * brand is never told both "margin is thin" and "scale up" at once. Money is BIGINT minor units (I-S07);
 * the margin RATIO is the only float, used for the threshold + ordering, never for money.
 */

import type { Cm2Signal } from './margin-erosion.detector.js';

export type Confidence = 'Trusted' | 'Estimated' | 'Insufficient';

export interface DetectorRecommendation {
  detector: 'scale_opportunity';
  subject: string;
  kind: 'opportunity';
  confidence: Confidence;
  priority: number;
  payload: {
    title: string;
    summary: string;
    recommended_action: string;
    evidence: {
      net_revenue_minor: string;
      cm2_minor: string;
      cm2_margin_pct: string;
      marketing_minor: string;
      order_count: number;
    };
  };
}

/** Below this many realized orders the signal is too thin to claim healthy margin → suppress. */
const MIN_ORDERS_FOR_SIGNAL = 20;
/** A CM2 margin AT/ABOVE this (20% of revenue) is "healthy" → a scaling opportunity. */
const HEALTHY_MARGIN_THRESHOLD = 0.2;

function pctOf(revenueMinor: bigint, pctBps: number): bigint {
  return (revenueMinor * BigInt(Math.trunc(pctBps))) / 10000n;
}

/**
 * Run the scale-opportunity detector. Returns an opportunity when CM2 is healthy on a trustworthy,
 * sufficient sample; else null (thin/negative margin, too little data, or no cost structure to trust).
 */
export function scaleOpportunityDetector(signal: Cm2Signal): DetectorRecommendation | null {
  const { netRevenueMinor, marketingMinor, orderCount, cogsPctBps, variablePctBps, hasCogs, confidenceRank } = signal;

  // Not enough orders OR no revenue OR no COGS entered → can't claim healthy margin honestly → suppress.
  if (orderCount < MIN_ORDERS_FOR_SIGNAL || netRevenueMinor <= 0n || !hasCogs || confidenceRank <= 0) {
    return null;
  }

  const cogsMinor = pctOf(netRevenueMinor, cogsPctBps);
  const variableCostMinor = pctOf(netRevenueMinor, variablePctBps);
  const cm1Minor = netRevenueMinor - cogsMinor - variableCostMinor;
  const cm2Minor = cm1Minor - marketingMinor;
  const margin = Number(cm2Minor) / Number(netRevenueMinor); // ratio (non-additive) — TS only, never money

  // Only fire when margin is genuinely healthy — below the threshold is margin-erosion's territory.
  if (cm2Minor <= 0n || margin < HEALTHY_MARGIN_THRESHOLD) {
    return null;
  }

  const confidence: Confidence = confidenceRank >= 2 ? 'Trusted' : 'Estimated';
  // Headroom-weighted priority: the more margin above the threshold, the bigger the opportunity (capped).
  const headroom = margin - HEALTHY_MARGIN_THRESHOLD;
  const priority = Math.min(800, Math.max(1, Math.round(headroom * 1000)));
  const marginPct = (margin * 100).toFixed(2);

  return {
    detector: 'scale_opportunity',
    subject: 'brand',
    kind: 'opportunity',
    confidence,
    priority,
    payload: {
      title: 'Healthy contribution margin (CM2) — room to scale',
      summary:
        `CM2 is ${marginPct}% of revenue after COGS, variable costs and marketing — profitable unit ` +
        `economics with headroom. Each incremental order is contributing real margin.`,
      recommended_action:
        'Lean into profitable growth: increase spend on your highest-CM2 channels, expand winning ' +
        'campaigns, and protect the margin as you scale (watch CAC and RTO as volume grows).',
      evidence: {
        net_revenue_minor: netRevenueMinor.toString(),
        cm2_minor: cm2Minor.toString(),
        cm2_margin_pct: marginPct,
        marketing_minor: marketingMinor.toString(),
        order_count: orderCount,
      },
    },
  };
}
