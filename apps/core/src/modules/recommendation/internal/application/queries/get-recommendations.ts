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

/**
 * Sanitize persisted evidence to the @brain/contracts shape (string|number|boolean values only).
 *
 * Detectors historically persisted `null` values for conditional evidence keys (e.g.
 * `top_driver_event: … : null` for non-primary currencies). The BFF contract
 * (RecommendationEvidenceSchema) is a `record(string, string|number|boolean)` with NO null, so a
 * persisted null makes zod reject the whole response ("Invalid input" at evidence.top_driver_event).
 * We strip null/undefined keys here so already-persisted prod rows read cleanly; the producer also
 * omits nulls going forward (defence in depth on both write and read paths).
 */
function sanitizeEvidence(raw: unknown): RecommendationEvidence {
  if (raw === null || typeof raw !== 'object') return {};
  const out: RecommendationEvidence = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}

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

/**
 * A persisted open recommendation, RAW (before the confidence gate). JSON-safe (created_at is an ISO
 * string, not a Date) so it can be cached in Redis by the request-time serving path and round-trip
 * cleanly. The confidence here is the detector's ORIGINAL finding; the gate is applied at serve time
 * (applyGateToRawRecs) against CURRENT trust, so a trust change reflects immediately without touching
 * the cache.
 */
export interface RawRecommendation {
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
  outcome: RecommendationOutcome | null;
  created_at: string;
}

/**
 * Read the brand's OPEN recommendations RAW (no gate), ordered by money-weighted priority then
 * recency, via the RLS-enforced pool. The single source query both the stored (getRecommendations)
 * and the request-time (getRecommendationsLive) serving paths share.
 */
export async function readOpenRecommendationsRaw(
  brandId: string,
  correlationId: string,
  pool: DbPool,
): Promise<RawRecommendation[]> {
  const ctx: QueryContext = { brandId, correlationId };
  const client = await pool.connect();
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
    return res.rows.map((r) => ({
      recommendation_id: r.recommendation_id,
      detector: r.detector,
      kind: r.kind,
      confidence: r.confidence,
      priority: r.priority,
      status: r.status,
      title: r.payload?.title ?? '',
      summary: r.payload?.summary ?? '',
      recommended_action: r.payload?.recommended_action ?? '',
      evidence: sanitizeEvidence(r.payload?.evidence),
      outcome: r.outcome ?? null,
      created_at: toIso(r.created_at),
    }));
  } finally {
    client.release();
  }
}

/**
 * Apply the confidence gate to RAW recs at serve time and return the sorted serving shape.
 * "Confidence before decisions": cap each rec's surfaced confidence at the brand's effective trust
 * and HOLD high-risk recs below Trusted. Actionable first (held sink below), priority order preserved
 * within each group.
 */
export function applyGateToRawRecs(
  raw: RawRecommendation[],
  gate: ConfidenceGateInputs,
): Recommendation[] {
  const recommendations = raw.map((r) => {
    const g = applyConfidenceGate(r.kind, r.confidence, gate);
    return {
      recommendation_id: r.recommendation_id,
      detector: r.detector,
      kind: r.kind,
      confidence: g.confidence,
      priority: r.priority,
      status: r.status,
      title: r.title,
      summary: r.summary,
      recommended_action: r.recommended_action,
      evidence: r.evidence,
      outcome: r.outcome ?? null,
      created_at: r.created_at,
      held: g.held,
      held_reason: g.heldReason,
    };
  });
  recommendations.sort((a, b) => Number(a.held) - Number(b.held));
  return recommendations;
}

export async function getRecommendations(
  brandId: string,
  correlationId: string,
  deps: RecommendationReadDeps,
): Promise<Recommendations> {
  const raw = await readOpenRecommendationsRaw(brandId, correlationId, deps.pool);
  if (raw.length === 0) {
    return { state: 'no_data' };
  }
  return { state: 'has_data', recommendations: applyGateToRawRecs(raw, deps.gate) };
}
