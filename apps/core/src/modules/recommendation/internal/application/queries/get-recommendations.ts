/**
 * getRecommendations — the open recommendations for a brand (the Morning Brief read).
 *
 * Returns an honest discriminated union: `no_data` when the brand has no open recommendations,
 * `has_data` otherwise. Reads recommendation via the RLS-enforced pool. Ranked by priority
 * (money-weighted, doc 09 Part 6) then recency. brand_id is the session brand (BFF), never request.
 */

import type { DbPool, QueryContext } from '@brain/db';

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
}

export type Recommendations =
  | { state: 'no_data' }
  | { state: 'has_data'; recommendations: Recommendation[] };

export interface RecommendationReadDeps {
  pool: DbPool;
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

    return {
      state: 'has_data',
      recommendations: res.rows.map((r) => ({
        recommendation_id: r.recommendation_id,
        detector: r.detector,
        kind: r.kind,
        confidence: r.confidence,
        priority: r.priority,
        status: r.status,
        title: r.payload?.title ?? '',
        summary: r.payload?.summary ?? '',
        recommended_action: r.payload?.recommended_action ?? '',
        evidence: r.payload?.evidence ?? {},
        outcome: r.outcome ?? null,
        created_at: toIso(r.created_at),
      })),
    };
  } finally {
    client.release();
  }
}
