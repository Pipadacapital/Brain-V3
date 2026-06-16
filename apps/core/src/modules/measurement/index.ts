/**
 * Public interface for the `measurement` module (core monolith bounded context).
 * RULE: only this file may be imported by other modules — enforced by the ESLint
 * boundary rule. All implementation lives under ./internal/ and is private.
 *
 * feat-realized-revenue-ledger (Stage 3):
 *   - RecognizeOrderUseCase: order event → provisional_recognition ledger row
 *   - PostReversalUseCase: signed reversal → new ledger row (never edit the sale)
 *   - PostFinalizationUseCase: finalization job writes finalization rows
 *   - GetRealizedGmvAsOfQuery: sole as-of path; calls realized_gmv_as_of() (D-3)
 *   - OrderEventConsumer: Bronze adapter (used by stream-worker job)
 */

export { RecognizeOrderCommand as RecognizeOrderUseCase } from './internal/application/commands/RecognizeOrder.js';
export {
  PostReversalCommand as PostReversalUseCase,
  PostFinalizationCommand as PostFinalizationUseCase,
} from './internal/application/commands/PostReversal.js';
export { GetRealizedGmvAsOfQuery } from './internal/application/queries/GetRealizedGmvAsOf.js';
export { OrderEventConsumer } from './internal/interfaces/consumers/OrderEventConsumer.js';

// Re-export key types for callers
export type { RecognitionEvent, RecognitionEventType, PaymentMethod } from './internal/domain/recognition/value-objects/RecognitionEvent.js';
