/**
 * PgAiProvenanceRepository — append-only writer for ai_provenance (Phase 8, D2).
 *
 * INSERT-ONLY by construction (mirrors the GRANT in 0036: brain_app holds SELECT+INSERT,
 * NO UPDATE/DELETE). There is intentionally NO update() / delete() method — provenance is
 * immutable audit. Every write runs inside withBrandTxn so the RLS GUC (app.current_brand_id)
 * is set transaction-locally and the INSERT is brand-scoped (I-S01).
 *
 * The number is NEVER written here (no value/money column exists — Assertion-4 in 0036). Only
 * question_redacted (already redacted by the caller) is persisted — the raw question never
 * reaches this layer.
 *
 * @see 02-architecture.md §D2 · 0036_ai_provenance.sql
 */

import type { Pool } from 'pg';
import { withBrandTxn } from '@brain/metric-engine';
import type { AiProvenanceInsert, AiProvenanceRow, ResolvedParams } from './ai-provenance.dto.js';
import type { ConfidenceGrade, TrustTier } from './ai-provenance.dto.js';
import type { MetricId, MetricVersion } from '@brain/metric-engine';

interface ProvenanceDbRow {
  provenance_id: string;
  brand_id: string;
  metric_id: string;
  metric_version: string;
  params: ResolvedParams;
  snapshot_id: string;
  question_redacted: string;
  confidence_grade: string;
  trust_tier: string;
  created_at: Date;
}

export class PgAiProvenanceRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * insert — append one provenance row for the brand (RLS-scoped via withBrandTxn).
   *
   * @param row - The provenance insert (questionRedacted MUST already be redacted).
   * @returns The persisted provenance_id.
   */
  async insert(row: AiProvenanceInsert): Promise<string> {
    return withBrandTxn(this.pool, row.brandId, async (client) => {
      const r = await client.query<{ provenance_id: string }>(
        `INSERT INTO ai_provenance
           (brand_id, metric_id, metric_version, params, snapshot_id,
            question_redacted, confidence_grade, trust_tier)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
         RETURNING provenance_id`,
        [
          row.brandId,
          row.metricId,
          row.metricVersion,
          JSON.stringify(row.params),
          row.snapshotId,
          row.questionRedacted,
          row.confidenceGrade,
          row.trustTier,
        ],
      );
      return r.rows[0]!.provenance_id;
    });
  }

  /**
   * listRecent — the "recent asks" read for the UI (brand-scoped, newest first).
   * Read-only; uses the idx_ai_provenance_recent index.
   *
   * @param brandId - The brand UUID (from session).
   * @param limit   - Max rows (capped at 50).
   */
  async listRecent(brandId: string, limit = 20): Promise<AiProvenanceRow[]> {
    const capped = Math.min(Math.max(limit, 1), 50);
    return withBrandTxn(this.pool, brandId, async (client) => {
      const r = await client.query<ProvenanceDbRow>(
        `SELECT provenance_id, brand_id, metric_id, metric_version, params,
                snapshot_id, question_redacted, confidence_grade, trust_tier, created_at
         FROM ai_provenance
         WHERE brand_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [brandId, capped],
      );
      return r.rows.map((db) => ({
        provenanceId: db.provenance_id,
        brandId: db.brand_id,
        metricId: db.metric_id as MetricId,
        metricVersion: db.metric_version as MetricVersion,
        params: db.params,
        snapshotId: db.snapshot_id,
        questionRedacted: db.question_redacted,
        confidenceGrade: db.confidence_grade as ConfidenceGrade,
        trustTier: db.trust_tier as TrustTier,
        createdAt: db.created_at.toISOString(),
      }));
    });
  }
}
