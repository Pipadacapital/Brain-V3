/**
 * identity_audit decision/evidence mapping helpers — the PURE (no-DB) functions that shape the
 * ADDITIVE `detail` JSONB written into the EXISTING identity_audit compliance ledger (migration
 * 0017, partitioned in 0075, `audit` schema — STAYS in PG per ADR-0004, HASH-ONLY, I-S02).
 *
 * NOTE (ADR-0015): the PG `IdentityAuditDecisionLog` adapter class that used to live here was a
 * v3 Wave-2 artifact wired into the stream-worker decision path. That path was superseded when
 * identity resolution moved to the Silver-stage batch job (apps/stream-worker/src/jobs/silver-identity),
 * and the adapter was never instantiated anywhere — knip flagged it as dead. It has been removed;
 * these deterministic mappers remain (exercised by the unit test) as the canonical detail-JSONB
 * shape any future writer of identity_audit must use.
 */
import type { IdentityDecision, IdentityCommand } from '@brain/contracts';
import type { DecisionLogEntry } from '../../domain/identity/decisions/DecisionLogRepository.js';
import type { DecisionEvidence } from '../../domain/identity/decisions/EvidenceStore.js';
import { NIL_BRAIN_ID } from '../../domain/identity/decisions/DecisionEngine.js';

/** The CHECK-allowed identity_audit.action bucket set (migration 0017 / 0075). */
export type AuditAction = 'mint' | 'link' | 'merge' | 'unmerge' | 'rebind' | 'erase';

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
