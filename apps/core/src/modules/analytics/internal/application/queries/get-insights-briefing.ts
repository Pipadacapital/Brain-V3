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
import { computeInsights } from '@brain/metric-engine';

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
}

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

export async function getInsightsBriefing(
  brandId: string,
  deps: { srPool: SilverPool },
): Promise<InsightsBriefingResult> {
  const result = await computeInsights(brandId, deps);
  if (!result.hasData) {
    return { state: 'no_data' };
  }

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
  };

  return { state: 'has_data', briefing, insights: insights.map(toDto) };
}
