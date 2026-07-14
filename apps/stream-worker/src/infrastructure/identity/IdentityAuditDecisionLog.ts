/**
 * IdentityAuditDecisionLog — the PG adapter for the Decision Log + Evidence Store, writing
 * ADDITIVELY into the EXISTING identity_audit compliance ledger.
 *
 * BINDS THE EXISTING TABLE, DOES NOT MIGRATE IT. identity_audit (migration 0017, partitioned in
 * 0075, `audit` schema) is the immutable identity compliance ledger that STAYS in PG per ADR-0004.
 * Its columns are unchanged: (brand_id, audit_id, brain_id, action, merge_id, detail jsonb,
 * occurred_at). This adapter is ADDITIVE — it records the new reversible-Command + version +
 * evidence-ref + inverse, and the full evidence (incl. the structured identifier_combo that was
 * previously lost as []), inside the free-form `detail` JSONB. No DDL, no new column.
 *
 * APPEND-ONLY: brain_app holds SELECT+INSERT only on identity_audit (no UPDATE/DELETE). So a single
 * append-only row carries BOTH the decision-log entry AND its evidence (one row per decision). The
 * EvidenceStore `put()` stages the evidence; the DecisionLog `append()` flushes it into that one
 * row's `detail.evidence`. This satisfies both ports with a single immutable append.
 *
 * The CHECK-constrained `action` column (mint|link|merge|unmerge|rebind|erase) is a COARSE bucket;
 * the precise reversible Command lives in `detail.command` (suppress/route_to_review map to the
 * neutral 'link' bucket to respect the existing CHECK while preserving the true command in detail).
 *
 * RLS: identity_audit is FORCE-RLS on brand_id → every txn sets app.current_brand_id first. Connects
 * as brain_app (never superuser). HASH-ONLY — no raw PII ever reaches this row (I-S02).
 */
import type { Pool } from 'pg';
import { buildContextGucSql } from '@brain/db';
import type { IdentityDecision, IdentityCommand } from '@brain/contracts';
import type {
  DecisionLogRepository,
  DecisionLogEntry,
  DecisionLogReceipt,
} from '../../domain/identity/decisions/DecisionLogRepository.js';
import type {
  EvidenceStore,
  DecisionEvidence,
} from '../../domain/identity/decisions/EvidenceStore.js';
import { NIL_BRAIN_ID } from '../../domain/identity/decisions/DecisionEngine.js';

/** The CHECK-allowed identity_audit.action bucket set (migration 0017 / 0075). */
export type AuditAction = 'mint' | 'link' | 'merge' | 'unmerge' | 'rebind' | 'erase';

export class IdentityAuditDecisionLog implements DecisionLogRepository, EvidenceStore {
  /** Staged evidence (keyed brand_id:decision_id) flushed into the row on append(). */
  private readonly pending = new Map<string, DecisionEvidence>();

  constructor(private readonly pool: Pool) {}

  /** Stage evidence for a decision; durably written into the audit row on append(). */
  async put(evidence: DecisionEvidence): Promise<void> {
    this.pending.set(`${evidence.brand_id}:${evidence.decision_id}`, evidence);
  }

  /** Append one immutable identity_audit row embedding the decision + (staged) evidence. */
  async append(entry: DecisionLogEntry): Promise<DecisionLogReceipt> {
    const key = `${entry.brand_id}:${entry.decision_id}`;
    const evidence = this.pending.get(key) ?? null;
    const detail = buildAuditDetail(entry, evidence);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(buildContextGucSql({ brandId: entry.brand_id, correlationId: '' }));
      await client.query(
        `INSERT INTO identity_audit (brand_id, brain_id, action, merge_id, detail)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [
          entry.brand_id,
          anchorBrainId(entry.decision),
          mapCommandToAction(entry.decision.command),
          mergeIdOf(entry.decision),
          JSON.stringify(detail),
        ],
      );
      await client.query('COMMIT');
      this.pending.delete(key);
      return { appended: true, decision_id: entry.decision_id };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** Read back a logged decision by its deterministic id (audit / undo). */
  async read(args: { brand_id: string; decision_id: string }): Promise<DecisionLogEntry | null> {
    const detail = await this.selectDetail(args.brand_id, args.decision_id);
    return detail ? parseAuditEntry(args.brand_id, detail) : null;
  }

  /** Fetch the evidence behind a decision (staged buffer first, else the persisted audit row). */
  async get(args: { brand_id: string; decision_id: string }): Promise<DecisionEvidence | null> {
    const staged = this.pending.get(`${args.brand_id}:${args.decision_id}`);
    if (staged) return staged;
    const detail = await this.selectDetail(args.brand_id, args.decision_id);
    return detail ? parseAuditEvidence(args.brand_id, detail) : null;
  }

  private async selectDetail(
    brandId: string,
    decisionId: string,
  ): Promise<Record<string, unknown> | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(buildContextGucSql({ brandId: brandId, correlationId: '' }));
      const res = await client.query<{ detail: Record<string, unknown> }>(
        `SELECT detail FROM identity_audit
         WHERE brand_id = $1 AND detail->>'decision_id' = $2
         ORDER BY occurred_at DESC LIMIT 1`,
        [brandId, decisionId],
      );
      await client.query('COMMIT');
      return res.rows[0]?.detail ?? null;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}

// ── Pure mapping helpers (exported for unit tests — no DB) ─────────────────────

/**
 * Build the additive identity_audit.detail JSONB. Records the precise reversible command, the rule
 * version, the evidence ref (the decision_id), the INVERSE (compensation), the identifier types
 * (legacy field, retained), and the FULL evidence with the round-tripped identifier_combo.
 * HASH-ONLY — every value here is a hash/id/type/integer, never raw PII.
 */
export function buildAuditDetail(
  entry: DecisionLogEntry,
  evidence: DecisionEvidence | null,
): Record<string, unknown> {
  return {
    decision_id: entry.decision_id,
    command: entry.decision.command,
    rule_version: entry.decision.rule_version,
    evidence_ref: entry.evidence_ref,
    // The full reversible Command (hash-only) — so the row alone can replay/undo the decision.
    decision: entry.decision,
    // The INVERSE — promoted to the top level for queryability (also inside `decision`).
    compensation: entry.decision.compensation,
    identifier_types: identifierTypesOf(entry.decision),
    recorded_at: entry.recorded_at,
    store: 'neo4j', // the identity graph SoR; this PG row is the immutable audit + decision trail
    // The evidence (identifier_combo, signals, thresholds, matcher version) — round-trips intact.
    evidence: evidence
      ? {
          matcher_id: evidence.matcher_id,
          matcher_version: evidence.matcher_version,
          score: evidence.score,
          band: evidence.band,
          signals: evidence.signals,
          identifier_combo: evidence.identifier_combo,
          thresholds: evidence.thresholds,
          recorded_at: evidence.recorded_at,
        }
      : null,
  };
}

/** Reconstruct a DecisionLogEntry from a persisted detail JSONB. */
export function parseAuditEntry(
  brandId: string,
  detail: Record<string, unknown>,
): DecisionLogEntry {
  return {
    decision_id: String(detail['decision_id']),
    brand_id: brandId,
    decision: detail['decision'] as IdentityDecision, // present only if a future writer embeds it
    evidence_ref: String(detail['evidence_ref'] ?? detail['decision_id']),
    recorded_at: String(detail['recorded_at'] ?? ''),
  };
}

/** Reconstruct a DecisionEvidence from a persisted detail JSONB (identifier_combo round-trips). */
export function parseAuditEvidence(
  brandId: string,
  detail: Record<string, unknown>,
): DecisionEvidence | null {
  const ev = detail['evidence'] as Record<string, unknown> | null | undefined;
  if (!ev) return null;
  return {
    decision_id: String(detail['decision_id']),
    brand_id: brandId,
    command: detail['command'] as IdentityCommand,
    rule_version: String(detail['rule_version'] ?? ''),
    matcher_id: String(ev['matcher_id'] ?? ''),
    matcher_version: String(ev['matcher_version'] ?? ''),
    score: Number(ev['score'] ?? 0),
    band: ev['band'] as DecisionEvidence['band'],
    signals: (ev['signals'] as string[]) ?? [],
    identifier_combo: (ev['identifier_combo'] as DecisionEvidence['identifier_combo']) ?? [],
    thresholds: (ev['thresholds'] as Record<string, number>) ?? {},
    recorded_at: String(ev['recorded_at'] ?? ''),
  };
}

/**
 * Map a reversible Command to the CHECK-allowed identity_audit.action bucket. suppress and
 * route_to_review have no dedicated enum value (no graph mutation committed) → the neutral 'link'
 * bucket; the precise command is preserved in detail.command.
 */
export function mapCommandToAction(command: IdentityCommand): AuditAction {
  switch (command) {
    case 'mint':
      return 'mint';
    case 'link':
      return 'link';
    case 'merge':
      return 'merge';
    case 'unmerge':
      return 'unmerge';
    case 'suppress':
    case 'route_to_review':
      return 'link';
  }
}

/** The NOT-NULL brain_id anchor for a decision (Suppress is identifier-scoped → NIL sentinel). */
export function anchorBrainId(decision: IdentityDecision): string {
  switch (decision.command) {
    case 'mint':
    case 'link':
      return decision.brain_id;
    case 'merge':
    case 'unmerge':
      return decision.canonical_brain_id;
    case 'route_to_review':
      return decision.brain_id_a;
    case 'suppress':
      return NIL_BRAIN_ID; // identifier-scoped: no single brain subject (subject in detail)
  }
}

/** The merge_id column value for a decision (only merge/unmerge carry one). */
export function mergeIdOf(decision: IdentityDecision): string | null {
  return decision.command === 'merge' || decision.command === 'unmerge'
    ? decision.merge_id
    : null;
}

/** Legacy identifier_types list (retained for back-compat with existing audit readers). */
function identifierTypesOf(decision: IdentityDecision): string[] {
  if (decision.command === 'mint' || decision.command === 'link') {
    return decision.identifiers.map((i) => i.identifier_type);
  }
  if (decision.command === 'suppress') return [decision.identifier_type];
  return [];
}
