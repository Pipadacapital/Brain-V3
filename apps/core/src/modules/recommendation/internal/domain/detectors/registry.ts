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

/** The registered detectors, in evaluation order. */
export const DETECTORS: readonly Detector[] = [rtoRisk, realizationGap];

export function detectorById(id: string): Detector | undefined {
  return DETECTORS.find((d) => d.id === id);
}
