/**
 * ai-provenance.dto.ts — the persistence shape of one ai_provenance row (Phase 8, D2).
 *
 * Mirrors db/migrations/0036_ai_provenance.sql EXACTLY. NO answer-number / money / float
 * field — the number is reproduced from (snapshot_id + binding), never stored (I-ST01).
 * question_redacted is the deterministically redacted question; the RAW question is NEVER
 * represented in this DTO (it is held in memory by askBrain and discarded after redaction).
 */

import type { MetricId, MetricVersion } from '@brain/metric-engine';
import type { ResolvedParams } from '@brain/ai-gateway-client';

/** The frozen confidence letter grade from getMetricTrust (Phase 7) — NOT a float. */
export type ConfidenceGrade = 'A+' | 'A' | 'B' | 'C' | 'D';

/** The trust tier banner the UI shows — NEVER colour-only (icon+label, a11y). */
export type TrustTier = 'Trusted' | 'Estimated' | 'Untrusted';

/**
 * The validated, allow-listed params resolved for the binding (JSONB in the DB).
 * SINGLE SOURCE OF TRUTH = the resolver's strict, allow-listed shape from
 * @brain/ai-gateway-client (date range + the known channel enum) — re-exported here
 * so the persistence layer and the resolver can NEVER drift on the params contract.
 * Only allow-listed keys; never free-text / SQL.
 */
export type { ResolvedParams };

/**
 * AiProvenanceInsert — the exact set of columns askBrain writes (INSERT only).
 * provenance_id + created_at are DB-defaulted (gen_random_uuid / NOW()).
 */
export interface AiProvenanceInsert {
  readonly brandId: string;
  readonly metricId: MetricId;
  readonly metricVersion: MetricVersion;
  readonly params: ResolvedParams;
  readonly snapshotId: string;
  /** ALREADY redacted by redactQuestion — the raw question is never passed here. */
  readonly questionRedacted: string;
  readonly confidenceGrade: ConfidenceGrade;
  readonly trustTier: TrustTier;
}

/**
 * AiProvenanceRow — a persisted provenance row as read back for the "recent asks" UI.
 * Money/number intentionally absent (reproduced from snapshot_id + binding via the engine).
 */
export interface AiProvenanceRow {
  readonly provenanceId: string;
  readonly brandId: string;
  readonly metricId: MetricId;
  readonly metricVersion: MetricVersion;
  readonly params: ResolvedParams;
  readonly snapshotId: string;
  readonly questionRedacted: string;
  readonly confidenceGrade: ConfidenceGrade;
  readonly trustTier: TrustTier;
  readonly createdAt: string; // ISO 8601
}
