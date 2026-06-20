/**
 * getRecommendations — the open recommendations for a brand (the Morning Brief read).
 *
 * Returns an honest discriminated union: `no_data` when the brand has no open recommendations,
 * `has_data` otherwise. Reads recommendation via the RLS-enforced pool. Ranked by priority
 * (money-weighted, doc 09 Part 6) then recency. brand_id is the session brand (BFF), never request.
 */

import type { DbPool, QueryContext } from '@brain/db';
import { applyConfidenceGate, type ConfidenceGateInputs } from '../../domain/confidence-gate.js';

function toIso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

/** Detector evidence — loosely typed (varies by detector); matches the @brain/contracts shape. */
export type RecommendationEvidence = Record<string, string | number | boolean>;

/** Measured effectiveness (the learning loop): the detector's headline metric then vs now. */
export interface RecommendationOutcome {
  metric: string;
  then: number;
  now: number;
  delta: number;
  improved: boolean;
}

export interface Recommendation {
  recommendation_id: string;
  detector: string;
  kind: 'risk' | 'opportunity';
  confidence: 'Trusted' | 'Estimated' | 'Insufficient';
  priority: number;
  status: string;
  title: string;
  summary: string;
  recommended_action: string;
  evidence: RecommendationEvidence;
  /** Latest measured outcome, or null if not yet measured. */
  outcome: RecommendationOutcome | null;
  created_at: string;
  /** Confidence gate (P0): true → not actionable; surface as "waiting on data confidence". */
  held: boolean;
  /** Honest reason it's held (null when actionable). */
  held_reason: string | null;
}

export type Recommendations =
  | { state: 'no_data' }
  | { state: 'has_data'; recommendations: Recommendation[] };

export interface RecommendationReadDeps {
  pool: DbPool;
  /**
   * The brand's current trust gate (from getMetricTrust). Recommendations are gated at READ time
   * against CURRENT confidence so the surfaced confidence can never drift above the live foundation
   * (e.g. a rec raised when Trusted is held once the foundation degrades). The BFF supplies it.
   */
  gate: ConfidenceGateInputs;
}

export async function getRecommendations(
  brandId: string,
  correlationId: string,
  deps: RecommendationReadDeps,
): Promise<Recommendations> {
  const ctx: QueryContext = { brandId, correlationId };
  const client = await deps.pool.connect();
  try {
    const res = await client.query<{
      recommendation_id: string;
      detector: string;
      kind: 'risk' | 'opportunity';
      confidence: 'Trusted' | 'Estimated' | 'Insufficient';
      priority: number;
      status: string;
      payload: {
        title?: string;
        summary?: string;
        recommended_action?: string;
        evidence?: RecommendationEvidence;
      };
      outcome: RecommendationOutcome | null;
      created_at: Date;
    }>(
      ctx,
      `SELECT r.recommendation_id, r.detector, r.kind, r.confidence, r.priority, r.status,
              r.payload, r.created_at, o.measured AS outcome
         FROM recommendation r
         LEFT JOIN recommendation_outcome o
           ON o.recommendation_id = r.recommendation_id AND o.measurement_window = 'latest'
        WHERE r.brand_id = $1 AND r.status = 'open'
        ORDER BY r.priority DESC, r.created_at DESC`,
      [brandId],
    );

    if (res.rows.length === 0) {
      return { state: 'no_data' };
    }

    const recommendations = res.rows.map((r) => {
      // "Confidence before decisions": cap the surfaced confidence at the brand's effective trust
      // and HOLD high-risk recs below Trusted. The detector's raw finding stays in the row (honest
      // detection record); the gate is applied here, at the surface, with CURRENT trust.
      const g = applyConfidenceGate(r.kind, r.confidence, deps.gate);
      return {
        recommendation_id: r.recommendation_id,
        detector: r.detector,
        kind: r.kind,
        confidence: g.confidence,
        priority: r.priority,
        status: r.status,
        title: r.payload?.title ?? '',
        summary: r.payload?.summary ?? '',
        recommended_action: r.payload?.recommended_action ?? '',
        evidence: r.payload?.evidence ?? {},
        outcome: r.outcome ?? null,
        created_at: toIso(r.created_at),
        held: g.held,
        held_reason: g.heldReason,
      };
    });
    // Actionable first (held items sink below), preserving the money-weighted priority order within
    // each group — the Morning Brief leads with what the brand can act on now.
    recommendations.sort((a, b) => Number(a.held) - Number(b.held));

    return { state: 'has_data', recommendations };
  } finally {
    client.release();
  }
}
