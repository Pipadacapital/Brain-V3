/**
 * PgIdentityTimelineRepository — IdentityTimelineSource adapter over the identity_audit ledger.
 *
 * Reads the append-only identity_audit compliance ledger (migration 0017 → partitioned 0075) — the
 * SAME ledger the Decision Log (DecisionLogRepository / IdentityAuditDecisionLog) appends to and the
 * legacy Neo4jIdentityRepository writes its mint/link/merge/erase rows to. Maps each row to the
 * common `IdentityTimelineRecord` DEFENSIVELY, so the projection works whether a row was written by
 * the legacy path (base columns + a `{rule_version, identifier_types, store}` detail) or the richer
 * Decision-Log path (which adds decision_id / evidence_ref / identifier_combo / matcher_id /
 * confidence_* / related_brain_id to detail).
 *
 * Tenant(brand_id)-first: every read runs in an RLS transaction under brain_app with the
 * app.current_brand_id GUC set (identity_audit is FORCE ROW LEVEL SECURITY; the explicit
 * brand_id predicate is belt-and-suspenders). Hash-only (I-S02) — detail carries identifier TYPES +
 * the structured hash-only identifier_combo, never raw PII.
 */
import { Pool } from 'pg';
import type { ConfidenceBand, IdentifierComboMember } from '@brain/contracts';
import type {
  IdentityTimelineRecord,
  IdentityTimelineSource,
  TimelineAction,
} from '../../domain/identity/IdentityTimeline.js';

interface AuditRow {
  brand_id: string;
  brain_id: string;
  action: string;
  merge_id: string | null;
  detail: Record<string, unknown> | null;
  occurred_at: Date;
}

export class PgIdentityTimelineRepository implements IdentityTimelineSource {
  constructor(private readonly pool: Pool) {}

  async readTimelineRecords(brandId: string, brainId: string): Promise<IdentityTimelineRecord[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_brand_id', $1, true)", [brandId]);
      // Both sides of a merge: the primary brain_id column AND a merged/related brain_id in detail.
      const res = await client.query<AuditRow>(
        `SELECT brand_id, brain_id, action, merge_id, detail, occurred_at
           FROM identity_audit
          WHERE brand_id = $1
            AND ( brain_id = $2
                  OR detail->>'merged_brain_id' = $2
                  OR detail->>'related_brain_id' = $2 )
          ORDER BY occurred_at ASC`,
        [brandId, brainId],
      );
      await client.query('COMMIT');
      return res.rows.map(mapAuditRow);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}

/** Map one identity_audit row → the common timeline record (defensive on the JSONB detail). */
export function mapAuditRow(row: AuditRow): IdentityTimelineRecord {
  const detail = row.detail ?? {};
  const identifierTypes = Array.isArray(detail['identifier_types'])
    ? (detail['identifier_types'] as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  const combo = Array.isArray(detail['identifier_combo'])
    ? (detail['identifier_combo'] as IdentifierComboMember[])
    : [];
  const decisionId = typeof detail['decision_id'] === 'string' ? (detail['decision_id'] as string) : null;

  return {
    brand_id: row.brand_id,
    brain_id: row.brain_id,
    related_brain_id:
      str(detail['merged_brain_id']) ?? str(detail['related_brain_id']) ?? null,
    action: row.action as TimelineAction,
    occurred_at: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : String(row.occurred_at),
    rule_version: str(detail['rule_version']) ?? 'v1-deterministic',
    merge_id: row.merge_id,
    identifier_types: identifierTypes,
    identifier_combo: combo,
    matcher_id: str(detail['matcher_id']) ?? null,
    confidence_score: num(detail['confidence_score']),
    confidence_band: (str(detail['confidence_band']) as ConfidenceBand | null) ?? null,
    reason: str(detail['reason']) ?? null,
    decision_id: decisionId,
    evidence_ref: str(detail['evidence_ref']) ?? decisionId,
  };
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
