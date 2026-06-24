/**
 * getInsightsBriefing — analytics use-case (ADR-002 sole-read-path) behind the AI Copilot.
 *
 * Composes the deterministic Insight + Opportunity Engine (computeInsights over the Gold marts) into
 * a briefing the Copilot surface renders: a ranked insight feed + a natural-language daily briefing.
 *
 * BRAIN RULE: the numbers come from the marts, NEVER from a model. The briefing narrative here is
 * deterministic and templated from the already-computed figures (so it can never drift from the
 * truth). An optional LLM tone-polish can later wrap this text — it is given the exact numbers and
 * forbidden to change them — but the deterministic briefing is always the source of record.
 *
 * Honest no_data: when the brand has no realized rows, returns { state: 'no_data' } (no fabricated
 * insights, no empty charts). Money stays BIGINT minor-unit strings; the UI formats per currency.
 */

import type { SilverPool, Insight, InsightKind, InsightSeverity } from '@brain/metric-engine';
import { computeInsights, withSilverBrand, BRAND_PREDICATE } from '@brain/metric-engine';

/**
 * The Gold marts the Insight engine reads (insights.ts). Each now carries a `data_source`
 * ('synthetic'|'live') column (added to the gold marts). We resolve the briefing's provenance
 * by checking whether ANY contributing row across these marts is synthetic — if so the whole
 * briefing is badged 'synthetic' (MK-1..MK-4: synthetic demo data must never read as live).
 */
const INSIGHT_GOLD_MARTS = [
  'brain_gold.gold_revenue_ledger',
  'brain_gold.gold_executive_metrics',
  'brain_gold.gold_customer_scores',
  'brain_gold.gold_cac',
] as const;

export interface InsightDto {
  id: string;
  detector: string;
  kind: InsightKind;
  severity: InsightSeverity;
  title: string;
  why: string;
  recommended_action: string;
  currency_code: string | null;
  impact_minor: string | null;
  direction: 'up' | 'down' | 'flat' | null;
  delta_pct: string | null;
  confidence: 'high' | 'medium' | 'low';
  evidence: Record<string, string | number | null>;
  /**
   * Set by the BFF after the insight is materialized as a recommendation (the audited decision loop).
   * null when the recommendation bridge is unavailable. status ∈ open|dismissed|expired.
   */
  recommendation_id?: string | null;
  status?: string | null;
}

export interface BriefingDto {
  /** One-line headline (counts + lead signal). */
  headline: string;
  /** Multi-line, grounded narrative — the "what changed / why / what to do" summary. */
  summary: string[];
  primary_currency: string | null;
  counts: { risks: number; opportunities: number; trends: number };
  /** Sum of money impact across money-bearing insights (BIGINT minor string), per primary currency. */
  total_impact_minor: string | null;
  window: { current: { from: string; to: string }; prior: { from: string; to: string } };
  /** How the narrative was produced — deterministic today; 'llm_polished' once the polish lands. */
  source: 'deterministic';
  /**
   * Provenance of the contributing Gold marts — 'synthetic' when ANY contributing row is synthetic
   * (demo seed), else 'live'. Drives the Synthetic (dev) badge on /insights so synthetic demo data
   * is NEVER presented as live (MK-1..MK-4). NEVER hardcoded — read from the marts' data_source col.
   */
  data_source: 'synthetic' | 'live';
  /**
   * FRESHNESS GUARD: when the gold marts were last REBUILT (max updated_at = dbt build time, NOT the
   * latest order). ISO-8601 or null. `stale` = older than INSIGHT_FRESHNESS_SLO_HOURS → the UI warns
   * the briefing may be out of date. Prod-safety: if the dbt refresh cron stalls, the briefing stops
   * silently serving stale insights and says so. Best-effort (never throws).
   */
  as_of: string | null;
  stale: boolean;
}

/**
 * Freshness SLO (hours): the gold marts are rebuilt by the hourly dbt crons (recognition-refresh /
 * attribution-gold-refresh). 6h gives generous slack for a missed/slow run before we flag stale.
 */
const FRESHNESS_SLO_HOURS = Number(process.env['INSIGHT_FRESHNESS_SLO_HOURS'] ?? 6);

export type InsightsBriefingResult =
  | { state: 'no_data' }
  | { state: 'has_data'; briefing: BriefingDto; insights: InsightDto[] };

function toDto(i: Insight): InsightDto {
  return {
    id: i.id,
    detector: i.detector,
    kind: i.kind,
    severity: i.severity,
    title: i.title,
    why: i.why,
    recommended_action: i.recommendedAction,
    currency_code: i.currencyCode,
    impact_minor: i.impactMinor,
    direction: i.direction,
    delta_pct: i.deltaPct,
    confidence: i.confidence,
    evidence: i.evidence,
  };
}

/** Sum money impact (abs) across insights of the primary currency. Exact integer math. */
function totalImpactMinor(insights: Insight[], ccy: string | null): string | null {
  if (!ccy) return null;
  let sum = 0n;
  let any = false;
  for (const i of insights) {
    if (i.currencyCode === ccy && i.impactMinor) {
      const v = BigInt(i.impactMinor);
      sum += v < 0n ? -v : v;
      any = true;
    }
  }
  return any ? sum.toString() : null;
}

/**
 * Resolve the briefing's data_source by reading the contributing Gold marts' `data_source` column.
 * Returns 'synthetic' if ANY contributing row (across any of the marts the engine reads) is
 * synthetic, else 'live' (synthetic-if-any aggregation — MK-1..MK-4). Brand-scoped via the seam.
 * Best-effort: a mart that does not yet expose the column degrades to 'live' for that mart, never
 * throwing (the briefing is still honest about the marts that DO report synthetic).
 */
async function resolveBriefingDataSource(
  brandId: string,
  deps: { srPool: SilverPool },
): Promise<'synthetic' | 'live'> {
  return withSilverBrand(deps.srPool, brandId, async (scope) => {
    for (const mart of INSIGHT_GOLD_MARTS) {
      try {
        const rows = await scope.runScoped<{ has_synthetic: number }>(
          `SELECT 1 AS has_synthetic FROM ${mart}
            WHERE ${BRAND_PREDICATE} AND data_source = 'synthetic' LIMIT 1`,
          [],
        );
        if (rows.length > 0) return 'synthetic';
      } catch {
        // Mart not yet exposing data_source (or absent) — skip it; do not fail the briefing.
      }
    }
    return 'live';
  });
}

/**
 * Resolve mart freshness: the MAX(updated_at) (dbt build time) of the primary fact mart, brand-scoped,
 * and whether it exceeds the freshness SLO. Best-effort: any error (column/mart absent) → { null,false }
 * so the briefing never fails over a freshness probe. This is the prod-staleness guard — if the dbt
 * refresh cron stalls, `stale` flips true and the UI warns instead of serving stale insights as fresh.
 */
async function resolveBriefingFreshness(
  brandId: string,
  deps: { srPool: SilverPool },
): Promise<{ asOf: string | null; stale: boolean }> {
  try {
    return await withSilverBrand(deps.srPool, brandId, async (scope) => {
      const rows = await scope.runScoped<{ as_of: string | null }>(
        `SELECT CAST(MAX(updated_at) AS STRING) AS as_of FROM brain_gold.gold_revenue_ledger
          WHERE ${BRAND_PREDICATE}`,
        [],
      );
      const raw = rows[0]?.as_of ?? null;
      if (!raw) return { asOf: null, stale: false };
      const ms = Date.parse(raw.replace(' ', 'T') + 'Z');
      if (Number.isNaN(ms)) return { asOf: null, stale: false };
      const ageHours = (Date.now() - ms) / 3_600_000;
      return { asOf: new Date(ms).toISOString(), stale: ageHours > FRESHNESS_SLO_HOURS };
    });
  } catch {
    return { asOf: null, stale: false };
  }
}

export async function getInsightsBriefing(
  brandId: string,
  deps: { srPool: SilverPool },
): Promise<InsightsBriefingResult> {
  const result = await computeInsights(brandId, deps);
  if (!result.hasData) {
    return { state: 'no_data' };
  }

  const dataSource = await resolveBriefingDataSource(brandId, deps);
  const freshness = await resolveBriefingFreshness(brandId, deps);

  const { insights, primaryCurrency, window } = result;
  const risks = insights.filter((i) => i.kind === 'risk');
  const opps = insights.filter((i) => i.kind === 'opportunity');
  const trends = insights.filter((i) => i.kind === 'trend');

  // Deterministic narrative from the ranked feed (already sorted by severity, then $ impact).
  const lead = insights[0];
  const headline =
    `${opps.length} ${opps.length === 1 ? 'opportunity' : 'opportunities'} · ` +
    `${risks.length} ${risks.length === 1 ? 'risk' : 'risks'} flagged across your commerce.`;

  const summary: string[] = [];
  if (lead) {
    summary.push(`Top signal — ${lead.title}. ${lead.why}`);
  }
  const topRisk = risks[0];
  if (topRisk && topRisk.id !== lead?.id) {
    summary.push(`Biggest risk — ${topRisk.title}. ${topRisk.recommendedAction}`);
  }
  const topOpp = opps[0];
  if (topOpp) {
    summary.push(`Biggest opportunity — ${topOpp.title}. ${topOpp.recommendedAction}`);
  }
  if (trends.length > 0 && trends[0]) {
    summary.push(`Trend to watch — ${trends[0].title}.`);
  }

  const briefing: BriefingDto = {
    headline,
    summary,
    primary_currency: primaryCurrency,
    counts: { risks: risks.length, opportunities: opps.length, trends: trends.length },
    total_impact_minor: totalImpactMinor(insights, primaryCurrency),
    window,
    source: 'deterministic',
    data_source: dataSource,
    as_of: freshness.asOf,
    stale: freshness.stale,
  };

  return { state: 'has_data', briefing, insights: insights.map(toDto) };
}
