/**
 * registry.ts — the detector registry (doc 09: "no rec without a registered detector").
 *
 * Each Detector encapsulates: how to FETCH its certified signal, the PURE detect(), and the
 * HEADLINE metric used to measure outcomes (then-at-raise vs now). generateRecommendations loops
 * this registry; measureRecommendationOutcomes re-fetches each rec's detector signal and compares.
 * Adding a detector = adding one entry here.
 */
import type { DbClient, QueryContext } from '@brain/db';
import { rtoRiskDetector, type RtoSignal } from './rto-risk.detector.js';
import { realizationGapDetector, type RealizationSignal } from './realization-gap.detector.js';
import { marginErosionDetector, type Cm2Signal } from './margin-erosion.detector.js';
import { scaleOpportunityDetector } from './scale-opportunity.detector.js';

export interface DetectorRecommendation {
  detector: string;
  subject: string;
  kind: 'risk' | 'opportunity';
  confidence: 'Trusted' | 'Estimated' | 'Insufficient';
  priority: number;
  payload: {
    title: string;
    summary: string;
    recommended_action: string;
    evidence: Record<string, string | number | boolean>;
  };
}

/** A headline metric for outcome comparison (lower-is-better for both current risk detectors). */
export interface HeadlineMetric {
  key: string;
  value: number;
  lowerIsBetter: boolean;
}

export interface Detector {
  id: string;
  subject: string;
  fetchSignal(client: DbClient, ctx: QueryContext, brandId: string): Promise<unknown>;
  detect(signal: unknown): DetectorRecommendation | null;
  metric(signal: unknown): HeadlineMetric;
}

const rtoRisk: Detector = {
  id: 'rto_risk',
  subject: 'brand',
  async fetchSignal(client, ctx, brandId) {
    const res = await client.query<{ order_count: string; rto_count: string; rto_gmv_minor: string }>(
      ctx,
      `SELECT order_count, rto_count, rto_gmv_minor FROM rto_risk_signal_for_brand($1::uuid)`,
      [brandId],
    );
    const r = res.rows[0];
    return {
      orderCount: Number(r?.order_count ?? '0'),
      rtoCount: Number(r?.rto_count ?? '0'),
      rtoGmvMinor: BigInt(r?.rto_gmv_minor ?? '0'),
    } satisfies RtoSignal;
  },
  detect: (s) => rtoRiskDetector(s as RtoSignal) as DetectorRecommendation | null,
  metric: (s) => {
    const sig = s as RtoSignal;
    const rate = sig.orderCount > 0 ? sig.rtoCount / sig.orderCount : 0;
    return { key: 'rto_rate_pct', value: Number((rate * 100).toFixed(2)), lowerIsBetter: true };
  },
};

const realizationGap: Detector = {
  id: 'realization_gap',
  subject: 'brand',
  async fetchSignal(client, ctx, brandId) {
    const res = await client.query<{ provisional_minor: string; realized_minor: string; order_count: string }>(
      ctx,
      `SELECT provisional_minor, realized_minor, order_count FROM realization_signal_for_brand($1::uuid)`,
      [brandId],
    );
    const r = res.rows[0];
    return {
      provisionalMinor: BigInt(r?.provisional_minor ?? '0'),
      realizedMinor: BigInt(r?.realized_minor ?? '0'),
      orderCount: Number(r?.order_count ?? '0'),
    } satisfies RealizationSignal;
  },
  detect: (s) => realizationGapDetector(s as RealizationSignal) as DetectorRecommendation | null,
  metric: (s) => {
    const sig = s as RealizationSignal;
    const unsettled = sig.provisionalMinor - sig.realizedMinor;
    const share = sig.provisionalMinor > 0n ? Number(unsettled) / Number(sig.provisionalMinor) : 0;
    return { key: 'unsettled_share_pct', value: Number((share * 100).toFixed(2)), lowerIsBetter: true };
  },
};

const marginErosion: Detector = {
  id: 'margin_erosion',
  subject: 'brand',
  async fetchSignal(client, ctx, brandId) {
    const res = await client.query<{
      net_revenue_minor: string; marketing_minor: string; order_count: string;
      cogs_pct_bps: string; variable_pct_bps: string; has_cogs: boolean; confidence_rank: number;
    }>(
      ctx,
      `SELECT net_revenue_minor, marketing_minor, order_count, cogs_pct_bps, variable_pct_bps, has_cogs, confidence_rank
         FROM cm2_signal_for_brand($1::uuid)`,
      [brandId],
    );
    const r = res.rows[0];
    return {
      netRevenueMinor: BigInt(r?.net_revenue_minor ?? '0'),
      marketingMinor: BigInt(r?.marketing_minor ?? '0'),
      orderCount: Number(r?.order_count ?? '0'),
      cogsPctBps: Number(r?.cogs_pct_bps ?? '0'),
      variablePctBps: Number(r?.variable_pct_bps ?? '0'),
      hasCogs: r?.has_cogs === true,
      confidenceRank: Number(r?.confidence_rank ?? 0),
    } satisfies Cm2Signal;
  },
  detect: (s) => marginErosionDetector(s as Cm2Signal) as DetectorRecommendation | null,
  metric: (s) => {
    const sig = s as Cm2Signal;
    const cogs = (sig.netRevenueMinor * BigInt(Math.trunc(sig.cogsPctBps))) / 10000n;
    const variable = (sig.netRevenueMinor * BigInt(Math.trunc(sig.variablePctBps))) / 10000n;
    const cm2 = sig.netRevenueMinor - cogs - variable - sig.marketingMinor;
    const margin = sig.netRevenueMinor > 0n ? Number(cm2) / Number(sig.netRevenueMinor) : 0;
    // Higher CM2 margin is better — the learning loop tracks improvement upward.
    return { key: 'cm2_margin_pct', value: Number((margin * 100).toFixed(2)), lowerIsBetter: false };
  },
};

// H1/M5/M6 — the first deterministic OPPORTUNITY detector. Reuses the EXISTING cm2_signal_for_brand
// (no new model/SQL). Fires the inverse of marginErosion: a HEALTHY, trustworthy CM2 → scale headroom.
const scaleOpportunity: Detector = {
  id: 'scale_opportunity',
  subject: 'brand',
  async fetchSignal(client, ctx, brandId) {
    const res = await client.query<{
      net_revenue_minor: string; marketing_minor: string; order_count: string;
      cogs_pct_bps: string; variable_pct_bps: string; has_cogs: boolean; confidence_rank: number;
    }>(
      ctx,
      `SELECT net_revenue_minor, marketing_minor, order_count, cogs_pct_bps, variable_pct_bps, has_cogs, confidence_rank
         FROM cm2_signal_for_brand($1::uuid)`,
      [brandId],
    );
    const r = res.rows[0];
    return {
      netRevenueMinor: BigInt(r?.net_revenue_minor ?? '0'),
      marketingMinor: BigInt(r?.marketing_minor ?? '0'),
      orderCount: Number(r?.order_count ?? '0'),
      cogsPctBps: Number(r?.cogs_pct_bps ?? '0'),
      variablePctBps: Number(r?.variable_pct_bps ?? '0'),
      hasCogs: r?.has_cogs === true,
      confidenceRank: Number(r?.confidence_rank ?? 0),
    } satisfies Cm2Signal;
  },
  detect: (s) => scaleOpportunityDetector(s as Cm2Signal) as DetectorRecommendation | null,
  metric: (s) => {
    const sig = s as Cm2Signal;
    const cogs = (sig.netRevenueMinor * BigInt(Math.trunc(sig.cogsPctBps))) / 10000n;
    const variable = (sig.netRevenueMinor * BigInt(Math.trunc(sig.variablePctBps))) / 10000n;
    const cm2 = sig.netRevenueMinor - cogs - variable - sig.marketingMinor;
    const margin = sig.netRevenueMinor > 0n ? Number(cm2) / Number(sig.netRevenueMinor) : 0;
    // Higher CM2 margin = a bigger/safer scaling opportunity (improvement tracked upward).
    return { key: 'cm2_margin_pct', value: Number((margin * 100).toFixed(2)), lowerIsBetter: false };
  },
};

/** The registered detectors, in evaluation order. */
export const DETECTORS: readonly Detector[] = [rtoRisk, realizationGap, marginErosion, scaleOpportunity];

export function detectorById(id: string): Detector | undefined {
  return DETECTORS.find((d) => d.id === id);
}
