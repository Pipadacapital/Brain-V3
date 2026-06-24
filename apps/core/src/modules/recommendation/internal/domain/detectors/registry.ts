/**
 * registry.ts — the detector registry (doc 09: "no rec without a registered detector").
 *
 * Each Detector encapsulates: how to FETCH its certified signal, the PURE detect(), and the
 * HEADLINE metric used to measure outcomes (then-at-raise vs now). generateRecommendations loops
 * this registry; measureRecommendationOutcomes re-fetches each rec's detector signal and compares.
 * Adding a detector = adding one entry here.
 *
 * MEDALLION REALIGNMENT (Epic 1 / decision B): the REVENUE half of every signal now comes from the
 * lakehouse gold ledger (brain_gold.gold_revenue_ledger) via the metric-engine seams — NOT the
 * PostgreSQL realized_revenue_ledger + its rto_risk_signal_for_brand / realization_signal_for_brand /
 * cm2_signal_for_brand SQL functions (dropped with the table).
 *
 * MEDALLION REALIGNMENT (AV-1 / MV-1): the CM2 detector's MARKETING half now reads ad spend from the
 * lakehouse Silver entity brain_silver.silver_marketing_spend (Bronze-sourced) via the metric-engine
 * seam computeCm2MarketingSignal — NOT the PG ad_spend_as_of() function. PG ad_spend_ledger stays the
 * operational WRITE SoR only. The CM2 COST half (cost_input — operational margin config, not analytical
 * event data) remains a PostgreSQL operational read here.
 */
import type { DbClient, QueryContext } from '@brain/db';
import {
  computeRtoRiskSignal,
  computeRealizationSignal,
  computeCm2RevenueSignal,
  computeCm2MarketingSignal,
  type SilverPool,
} from '@brain/metric-engine';
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

/** What a detector needs to fetch its signal: the PG client (operational reads) + the gold seam. */
export interface SignalDeps {
  client: DbClient;
  ctx: QueryContext;
  srPool: SilverPool;
}

export interface Detector {
  id: string;
  subject: string;
  fetchSignal(deps: SignalDeps, brandId: string): Promise<unknown>;
  detect(signal: unknown): DetectorRecommendation | null;
  metric(signal: unknown): HeadlineMetric;
}

/**
 * CM2 COST half (cost_input — operational margin config) + the brand's currency, from PG.
 * MARKETING (ad spend) moved to the Silver seam (AV-1/MV-1) — read in fetchCm2Signal. The brand
 * currency is operational config (tenancy.brand); it scopes the Silver spend sum to the brand's
 * currency, exactly as the dropped PG cm2_signal_for_brand JOIN brand ON currency_code did.
 */
async function fetchCm2CostParts(
  deps: SignalDeps,
  brandId: string,
): Promise<{ currencyCode: string; cogsPctBps: number; variablePctBps: number; hasCogs: boolean; confidenceRank: number }> {
  const brand = await deps.client.query<{ currency_code: string }>(
    deps.ctx,
    `SELECT currency_code FROM brand WHERE id = $1::uuid`,
    [brandId],
  );
  const cost = await deps.client.query<{
    cogs_pct_bps: string; variable_pct_bps: string; has_cogs: boolean | null; confidence_rank: number | null;
  }>(
    deps.ctx,
    `SELECT
       COALESCE(SUM(pct_bps) FILTER (WHERE cost_type = 'cogs' AND pct_bps IS NOT NULL), 0)::bigint AS cogs_pct_bps,
       COALESCE(SUM(pct_bps) FILTER (WHERE cost_type IN ('shipping','packaging','payment_fee','marketplace_fee') AND pct_bps IS NOT NULL), 0)::bigint AS variable_pct_bps,
       BOOL_OR(cost_type = 'cogs') AS has_cogs,
       MIN(CASE cost_confidence WHEN 'Trusted' THEN 2 WHEN 'Estimated' THEN 1 ELSE 0 END) AS confidence_rank
       FROM cost_inputs_as_of($1::uuid, CURRENT_DATE)
      WHERE scope = 'global'`,
    [brandId],
  );
  const c = cost.rows[0];
  return {
    currencyCode: brand.rows[0]?.currency_code ?? '',
    cogsPctBps: Number(c?.cogs_pct_bps ?? '0'),
    variablePctBps: Number(c?.variable_pct_bps ?? '0'),
    hasCogs: c?.has_cogs === true,
    confidenceRank: Number(c?.confidence_rank ?? 0),
  };
}

/** Assemble the full Cm2Signal: revenue+orders from gold, marketing from Silver, cost from PG. */
async function fetchCm2Signal(deps: SignalDeps, brandId: string): Promise<Cm2Signal> {
  const rev = await computeCm2RevenueSignal(brandId, { srPool: deps.srPool });
  const pg = await fetchCm2CostParts(deps, brandId);
  // MARKETING half from the lakehouse Silver entity (Bronze-sourced) — scoped to the brand's currency.
  const mkt = await computeCm2MarketingSignal(brandId, pg.currencyCode, { srPool: deps.srPool });
  return {
    netRevenueMinor: rev.netRevenueMinor,
    marketingMinor: mkt.marketingMinor,
    orderCount: rev.orderCount,
    cogsPctBps: pg.cogsPctBps,
    variablePctBps: pg.variablePctBps,
    hasCogs: pg.hasCogs,
    confidenceRank: pg.confidenceRank,
  } satisfies Cm2Signal;
}

function cm2Metric(s: unknown): HeadlineMetric {
  const sig = s as Cm2Signal;
  const cogs = (sig.netRevenueMinor * BigInt(Math.trunc(sig.cogsPctBps))) / 10000n;
  const variable = (sig.netRevenueMinor * BigInt(Math.trunc(sig.variablePctBps))) / 10000n;
  const cm2 = sig.netRevenueMinor - cogs - variable - sig.marketingMinor;
  const margin = sig.netRevenueMinor > 0n ? Number(cm2) / Number(sig.netRevenueMinor) : 0;
  // Higher CM2 margin is better — the learning loop tracks improvement upward.
  return { key: 'cm2_margin_pct', value: Number((margin * 100).toFixed(2)), lowerIsBetter: false };
}

const rtoRisk: Detector = {
  id: 'rto_risk',
  subject: 'brand',
  async fetchSignal(deps, brandId) {
    const s = await computeRtoRiskSignal(brandId, { srPool: deps.srPool });
    return { orderCount: s.orderCount, rtoCount: s.rtoCount, rtoGmvMinor: s.rtoGmvMinor } satisfies RtoSignal;
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
  async fetchSignal(deps, brandId) {
    const s = await computeRealizationSignal(brandId, { srPool: deps.srPool });
    return { provisionalMinor: s.provisionalMinor, realizedMinor: s.realizedMinor, orderCount: s.orderCount } satisfies RealizationSignal;
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
  fetchSignal: (deps, brandId) => fetchCm2Signal(deps, brandId),
  detect: (s) => marginErosionDetector(s as Cm2Signal) as DetectorRecommendation | null,
  metric: cm2Metric,
};

// H1/M5/M6 — the first deterministic OPPORTUNITY detector. Reuses the SAME CM2 signal (no new
// model/SQL). Fires the inverse of marginErosion: a HEALTHY, trustworthy CM2 → scale headroom.
const scaleOpportunity: Detector = {
  id: 'scale_opportunity',
  subject: 'brand',
  fetchSignal: (deps, brandId) => fetchCm2Signal(deps, brandId),
  detect: (s) => scaleOpportunityDetector(s as Cm2Signal) as DetectorRecommendation | null,
  metric: cm2Metric,
};

/** The registered detectors, in evaluation order. */
export const DETECTORS: readonly Detector[] = [rtoRisk, realizationGap, marginErosion, scaleOpportunity];

export function detectorById(id: string): Detector | undefined {
  return DETECTORS.find((d) => d.id === id);
}
