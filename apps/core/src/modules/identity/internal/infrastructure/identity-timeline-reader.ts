/**
 * IdentityTimelineReader — the read surface over the identity DECISION LOG (identity_audit) for the
 * BFF/UI. Given a brand + brain_id it returns the chronological history of identity decisions
 * (mint / link / merge / unmerge / rebind / erase, plus any Decision-Log rows) with their
 * rule_version + evidence references — the "how did this customer's identity come to be?" trail that
 * complements Customer 360 (which shows the CURRENT state; the timeline shows HOW it got there).
 *
 * MEDALLION REALIGNMENT (ADR-0004): the live identity GRAPH is Neo4j, but the immutable identity_audit
 * compliance ledger STAYS in PostgreSQL. The timeline is a projection of that PG ledger — so it reads
 * PG only (no Neo4j). Per-brand isolation is the RLS GUC (identity_audit is FORCE ROW LEVEL SECURITY);
 * the explicit brand_id predicate is belt-and-suspenders. Hash-only (I-S02): rows carry identifier
 * TYPES + decision references, never raw PII. Timestamps returned as Date.
 */
import type { Pool } from 'pg';

/** One identity-audit decision row, projected for the timeline. */
export interface IdentityTimelineEventRow {
  brain_id: string;
  action: string;
  merge_id: string | null;
  related_brain_id: string | null;
  rule_version: string;
  identifier_types: string[];
  reason: string | null;
  decision_id: string | null;
  occurred_at: Date | null;
}

/** The PUBLIC read port over the identity decision log (DIP boundary — the query depends on this). */
export interface IdentityTimelineReader {
  getIdentityTimeline(brandId: string, brainId: string): Promise<IdentityTimelineEventRow[]>;
}

interface AuditRow {
  brain_id: string;
  action: string;
  merge_id: string | null;
  detail: Record<string, unknown> | null;
  occurred_at: Date | null;
}

export class PgIdentityTimelineReader implements IdentityTimelineReader {
  constructor(private readonly pgPool: Pool) {}

  async getIdentityTimeline(brandId: string, brainId: string): Promise<IdentityTimelineEventRow[]> {
    const client = await this.pgPool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_brand_id', $1, true)", [brandId]);
      const res = await client.query<AuditRow>(
        `SELECT brain_id, action, merge_id, detail, occurred_at
           FROM identity_audit
          WHERE brand_id = $1
            AND ( brain_id = $2
                  OR detail->>'merged_brain_id' = $2
                  OR detail->>'related_brain_id' = $2 )
          ORDER BY occurred_at ASC`,
        [brandId, brainId],
      );
      await client.query('COMMIT');
      return res.rows.map(mapRow);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}

function mapRow(row: AuditRow): IdentityTimelineEventRow {
  const detail = row.detail ?? {};
  const identifierTypes = Array.isArray(detail['identifier_types'])
    ? (detail['identifier_types'] as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  return {
    brain_id: row.brain_id,
    action: row.action,
    merge_id: row.merge_id,
    related_brain_id: str(detail['merged_brain_id']) ?? str(detail['related_brain_id']),
    rule_version: str(detail['rule_version']) ?? 'v1-deterministic',
    identifier_types: identifierTypes,
    reason: str(detail['reason']),
    decision_id: str(detail['decision_id']),
    occurred_at: row.occurred_at,
  };
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}
