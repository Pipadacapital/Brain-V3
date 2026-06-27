/**
 * ExplainIdentityDecisionUseCase — read-side: explain WHY one identity decision was made.
 *
 * Fetches the issued reversible Command from the append-then-reference Decision Log
 * (DecisionLogRepository) and its recorded evidence from the EvidenceStore (both keyed by the same
 * deterministic decision_id), then runs the pure `explainIdentityDecision` assembly to produce a
 * human- AND LLM-readable explanation citing identifier_combo + matcher_id + rule_version +
 * ConfidenceVerdict. Pure read — it never issues or mutates a decision.
 *
 * brand_id-first (the caller supplies it); hash-only (I-S02). Returns null when the decision is
 * unknown for the brand (fail-closed: no fabricated explanation).
 */
import type { DecisionLogRepository } from '../domain/identity/decisions/DecisionLogRepository.js';
import type { EvidenceStore } from '../domain/identity/decisions/EvidenceStore.js';
import { explainIdentityDecision, type IdentityExplanation } from '../domain/identity/IdentityExplainability.js';

export class ExplainIdentityDecisionUseCase {
  constructor(
    private readonly decisionLog: DecisionLogRepository,
    private readonly evidenceStore: EvidenceStore,
  ) {}

  async execute(brandId: string, decisionId: string): Promise<IdentityExplanation | null> {
    const entry = await this.decisionLog.read({ brand_id: brandId, decision_id: decisionId });
    if (!entry) return null;
    const evidence = await this.evidenceStore.get({ brand_id: brandId, decision_id: decisionId });
    return explainIdentityDecision(entry.decision, evidence);
  }
}
