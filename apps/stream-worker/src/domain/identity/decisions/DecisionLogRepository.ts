/**
 * DecisionLogRepository — the append-then-reference ledger port for issued IdentityDecisions.
 *
 * Hexagonal: this is a DOMAIN port (no infra imports). The infrastructure adapter
 * (IdentityAuditDecisionLog) persists each entry ADDITIVELY into the EXISTING identity_audit
 * PG compliance ledger (migration 0017 → partitioned in 0075, `audit` schema). The ledger is
 * APPEND-ONLY (brain_app holds SELECT+INSERT only — never UPDATE/DELETE), so a correction is a
 * NEW entry, never a mutation.
 *
 * "append-then-reference": each entry records the issued reversible Command (the full
 * IdentityDecision, which carries its own `compensation`/inverse), its rule_version, and an
 * `evidence_ref` that POINTS to the EvidenceStore record (keyed by the same decision_id). The
 * decision + its inverse live here; the fuller evidence (identifier_combo, signals, thresholds,
 * matcher version) lives in the EvidenceStore under the referenced decision_id.
 *
 * TENANT(brand_id)-scoped on every path. HASH-ONLY — no raw PII ever crosses this seam
 * (IdentityDecision payloads are hash-only by contract). NO MONEY — confidence is an integer.
 */
import type { IdentityDecision } from '@brain/contracts';

/**
 * One ledger entry: the issued reversible Command + a reference to its evidence.
 * `decision_id` is the stable, deterministic key (DecisionEngine.decisionId) that links this
 * log entry to its EvidenceStore record (`evidence_ref === decision_id`).
 */
export interface DecisionLogEntry {
  /** Stable deterministic decision id (DecisionEngine.decisionId) — the evidence join key. */
  decision_id: string;
  /** Tenant key (brand_id-first isolation). */
  brand_id: string;
  /** The issued reversible Command — carries its own `compensation` (the inverse). */
  decision: IdentityDecision;
  /** Reference to the persisted evidence record (keyed by decision_id). */
  evidence_ref: string;
  /** ISO-8601 instant the entry was appended (audit). */
  recorded_at: string;
}

/** Receipt of an append (idempotent: a replay of the same decision_id is a no-op). */
export interface DecisionLogReceipt {
  /** True when a new ledger row was written; false on an idempotent replay. */
  appended: boolean;
  decision_id: string;
}

/**
 * The append-then-reference Decision Log port. brand_id-scoped, hash-only, append-only.
 */
export interface DecisionLogRepository {
  /** Append an issued reversible Command (idempotent on decision_id). */
  append(entry: DecisionLogEntry): Promise<DecisionLogReceipt>;
  /** Read back a logged decision by its deterministic id (audit / undo). */
  read(args: { brand_id: string; decision_id: string }): Promise<DecisionLogEntry | null>;
}
