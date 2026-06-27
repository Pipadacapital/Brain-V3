/**
 * identity/decisions — the Identity Decision Engine + reversible Decision Log + Evidence Store.
 *
 * Domain layer (hexagonal): the pure DecisionEngine (wraps the existing IdentityResolver, issues
 * reversible IdentityDecision Commands) + the two ports (DecisionLogRepository, EvidenceStore).
 * Infrastructure adapters live in apps/stream-worker/src/infrastructure/identity/.
 */
export {
  DecisionEngine,
  INVERSE_KIND,
  NIL_BRAIN_ID,
} from './DecisionEngine.js';
export type {
  DecisionContext,
  UnmergeContext,
  EvidenceOptions,
} from './DecisionEngine.js';

export type {
  DecisionLogRepository,
  DecisionLogEntry,
  DecisionLogReceipt,
} from './DecisionLogRepository.js';

export type { EvidenceStore, DecisionEvidence } from './EvidenceStore.js';
