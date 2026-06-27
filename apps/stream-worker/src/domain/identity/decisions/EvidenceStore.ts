/**
 * EvidenceStore — the per-decision evidence port (keyed by decision id).
 *
 * Hexagonal DOMAIN port (no infra imports). Persists the EVIDENCE behind each IdentityDecision —
 * the inputs that justified it — so a decision is machine-auditable and reversible with full
 * context: the exact identifier combination (`identifier_combo`), the matcher signals/reasons,
 * the gating thresholds, and the matcher id + version.
 *
 * WHY THIS EXISTS: the legacy identity_audit `detail` recorded only `identifier_types` and LOST
 * the precise `identifier_combo` (it was dropped to `[]`). The ConfidenceVerdict carries a
 * structured, hash-only `identifier_combo` (which exact identifier-types/hashes produced the
 * verdict); this store ROUND-TRIPS it so the evidence is never lost again.
 *
 * INVARIANTS: brand_id-scoped; HASH-ONLY (identifier_combo members are 64-hex digests, never raw
 * PII); confidence `score` is an INTEGER 0-100 (never money, never blended); thresholds are plain
 * integers/counts. Keyed by `decision_id` — the same key the DecisionLog references.
 */
import type { IdentifierComboMember, ConfidenceBand, IdentityCommand } from '@brain/contracts';

/**
 * The evidence behind one decision. Mirrors the ConfidenceVerdict's auditable fields plus the
 * gating thresholds the engine evaluated against.
 */
export interface DecisionEvidence {
  /** Stable deterministic decision id (DecisionEngine.decisionId) — the store key. */
  decision_id: string;
  /** Tenant key (brand_id-first isolation). */
  brand_id: string;
  /** Which reversible Command this evidence justified. */
  command: IdentityCommand;
  /** Rule version the verdict was produced under. */
  rule_version: string;
  /** The matcher that produced the verdict (IDENTITY_MATCHER_REGISTRY id). */
  matcher_id: string;
  /** The matcher VERSION (so re-scoring under a new matcher is auditable). */
  matcher_version: string;
  /** UNITLESS confidence integer in [0,100]. NEVER money, never blended with MinorUnits. */
  score: number;
  /** Coarse band derived from `score`. */
  band: ConfidenceBand;
  /** Matcher reason codes (signals) — append-only audit of WHY. Never raw PII. */
  signals: string[];
  /**
   * The exact identifier combination that produced the verdict — hash-only (I-S02).
   * MUST round-trip (it was previously lost as []).
   */
  identifier_combo: IdentifierComboMember[];
  /**
   * The gating thresholds evaluated (e.g. { phone_guard_threshold: 10, suppression_window_days: 30 }).
   * Plain integer counts/days — NOT money.
   */
  thresholds: Record<string, number>;
  /** ISO-8601 instant the evidence was recorded. */
  recorded_at: string;
}

/**
 * The Evidence Store port — persist + fetch evidence by (brand_id, decision_id).
 * brand_id-scoped, hash-only. Append-only by convention (evidence is immutable once recorded).
 */
export interface EvidenceStore {
  /** Persist the evidence for a decision (idempotent on decision_id). */
  put(evidence: DecisionEvidence): Promise<void>;
  /** Fetch the evidence behind a decision (null if none recorded). */
  get(args: { brand_id: string; decision_id: string }): Promise<DecisionEvidence | null>;
}
