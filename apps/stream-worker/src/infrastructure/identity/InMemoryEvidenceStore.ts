/**
 * InMemoryEvidenceStore — an in-process EvidenceStore (tests + dev).
 *
 * Keyed by (brand_id, decision_id). Stores a DEEP-ENOUGH copy so the structured `identifier_combo`
 * (and signals/thresholds) ROUND-TRIPS intact and cannot be corrupted by later mutation of the
 * caller's object — the exact failure (combo lost as []) this store exists to prevent.
 */
import type {
  EvidenceStore,
  DecisionEvidence,
} from '../../domain/identity/decisions/EvidenceStore.js';

export class InMemoryEvidenceStore implements EvidenceStore {
  private readonly store = new Map<string, DecisionEvidence>();

  async put(evidence: DecisionEvidence): Promise<void> {
    this.store.set(`${evidence.brand_id}:${evidence.decision_id}`, clone(evidence));
  }

  async get(args: { brand_id: string; decision_id: string }): Promise<DecisionEvidence | null> {
    const hit = this.store.get(`${args.brand_id}:${args.decision_id}`);
    return hit ? clone(hit) : null;
  }
}

/** Structural copy that isolates the arrays/objects so the round-trip is mutation-safe. */
function clone(e: DecisionEvidence): DecisionEvidence {
  return {
    ...e,
    signals: [...e.signals],
    identifier_combo: e.identifier_combo.map((m) => ({ ...m })),
    thresholds: { ...e.thresholds },
  };
}
