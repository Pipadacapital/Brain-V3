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
      created_at: Date;
    }>(
      ctx,
      `SELECT recommendation_id, detector, kind, confidence, priority, status, payload, created_at
         FROM recommendation
        WHERE brand_id = $1 AND status = 'open'
        ORDER BY priority DESC, created_at DESC`,
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
        created_at: toIso(r.created_at),
      })),
    };
  } finally {
    client.release();
  }
}
