/**
 * materializeInsightsAsRecommendations — persist the Insight + Opportunity Engine's output as
 * first-class recommendations so the EXISTING audited decision loop applies to them:
 *   - the append-only ai_config.recommendation_action ledger (served/accepted/dismissed/snoozed),
 *   - the recommendation_outcome measurement (did it WORK?), and
 *   - the /recommendations Morning Brief — all for free.
 *
 * This is the convergence the strategy blueprint calls for: the rich Gold-mart insight detectors
 * become a SOURCE of recommendations feeding the one decision/action/outcome loop (the RGUD substrate
 * — Reconciled GMV Under Decision). Without this, an insight is just a chart; with it, acting on an
 * insight is an auditable decision whose revenue impact can be measured.
 *
 * Idempotent read-through: called when the Copilot briefing is loaded. Upserts on the dedup key
 * (brand_id, detector, subject=currency) so re-loading never duplicates; the decision_log is written
 * ONLY on the first raise (no log spam on the 60s poll); and a user's dismissal is PRESERVED (status
 * is NOT reset on refresh — unlike the manual generate-recommendations run).
 *
 * Writes run under the RLS-enforced pool with the brand GUC set from the QueryContext (I-S01).
 */

import type { DbPool, QueryContext } from '@brain/db';

/** The minimal insight shape this command needs (a structural subset of the analytics InsightDto). */
export interface InsightForRecommendation {
  id: string;
  detector: string;
  kind: 'risk' | 'opportunity' | 'trend';
  severity: 'high' | 'medium' | 'low' | 'info';
  title: string;
  why: string;
  recommended_action: string;
  currency_code: string | null;
  impact_minor: string | null;
  delta_pct: string | null;
  direction: 'up' | 'down' | 'flat' | null;
  confidence: 'high' | 'medium' | 'low';
  evidence: Record<string, string | number | boolean>;
}

/**
 * Defence in depth on the WRITE path: strip null/undefined evidence values before persisting, so a
 * detector that (historically) emitted a null can never poison a stored row that the BFF read then
 * rejects against the record(string, string|number|boolean) contract. The producer already omits
 * nulls; this is the belt to that suspenders.
 */
function sanitizeEvidence(
  raw: Record<string, unknown>,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}

export interface MaterializedInsight {
  insightId: string;
  recommendationId: string;
  status: string;
}

export interface MaterializeInsightsDeps {
  pool: DbPool;
}

// Insight data-sufficiency → the recommendation table's confidence vocabulary (0044 CHECK).
const CONFIDENCE_MAP: Record<string, 'Trusted' | 'Estimated' | 'Insufficient'> = {
  high: 'Trusted',
  medium: 'Estimated',
  low: 'Insufficient',
};
const SEVERITY_WEIGHT: Record<string, number> = { high: 3, medium: 2, low: 1, info: 0 };

function absBigint(v: bigint): bigint {
  return v < 0n ? -v : v;
}

export async function materializeInsightsAsRecommendations(
  brandId: string,
  insights: InsightForRecommendation[],
  correlationId: string,
  deps: MaterializeInsightsDeps,
): Promise<MaterializedInsight[]> {
  const ctx: QueryContext = { brandId, correlationId };
  const client = await deps.pool.connect();
  try {
    const out: MaterializedInsight[] = [];
    for (const insight of insights) {
      // recommendation.kind CHECK allows only risk|opportunity; a positive 'trend' is an opportunity.
      const kind = insight.kind === 'trend' ? 'opportunity' : insight.kind;
      const confidence = CONFIDENCE_MAP[insight.confidence] ?? 'Insufficient';
      // Per-currency dedup subject (insight ids are per-currency, e.g. 'rto_leakage:INR').
      const subject = insight.currency_code ?? 'brand';
      const evidence = sanitizeEvidence(insight.evidence);
      // Money-weighted priority: severity band dominates, ₹-impact (in hundreds, capped) breaks ties.
      const impactScaled = insight.impact_minor ? Number(absBigint(BigInt(insight.impact_minor)) / 100000n) : 0;
      const priority = (SEVERITY_WEIGHT[insight.severity] ?? 0) * 1_000_000 + Math.min(impactScaled, 999_999);
      const payload = {
        title: insight.title,
        summary: insight.why,
        recommended_action: insight.recommended_action,
        evidence,
        impact_minor: insight.impact_minor,
        delta_pct: insight.delta_pct,
        direction: insight.direction,
        severity: insight.severity,
        currency_code: insight.currency_code,
        source: 'insight_engine',
      };

      // Upsert. NOTE: status is intentionally NOT reset to 'open' on conflict — a read-through refresh
      // must preserve a user's prior dismissal (the 60s poll would otherwise un-dismiss it).
      const up = await client.query<{ recommendation_id: string; status: string; inserted: boolean }>(
        ctx,
        `INSERT INTO recommendation
           (brand_id, detector, subject, kind, confidence, priority, status, payload)
         VALUES ($1, $2, $3, $4, $5, $6, 'open', $7::jsonb)
         ON CONFLICT (brand_id, detector, subject) DO UPDATE
           SET kind = EXCLUDED.kind, confidence = EXCLUDED.confidence, priority = EXCLUDED.priority,
               payload = EXCLUDED.payload, updated_at = NOW()
         RETURNING recommendation_id, status, (xmax = 0) AS inserted`,
        [brandId, insight.detector, subject, kind, confidence, priority, JSON.stringify(payload)],
      );
      const row = up.rows[0];
      if (!row) continue;

      // Decision-log only on the FIRST raise (avoid append-only log spam on every read-through poll).
      if (row.inserted) {
        await client.query(
          ctx,
          `INSERT INTO decision_log (brand_id, kind, recommendation_id, actor, action, reason, payload)
           VALUES ($1, 'recommendation', $2, $3, 'raised', $4, $5::jsonb)`,
          [brandId, row.recommendation_id, `insight:${insight.detector}`, insight.title, JSON.stringify(evidence)],
        );
      }

      out.push({ insightId: insight.id, recommendationId: row.recommendation_id, status: row.status });
    }
    return out;
  } finally {
    client.release();
  }
}
