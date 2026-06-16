/**
 * PostReversal — CQRS write command for signed negative reversal rows.
 * Handles: rto_reversal, refund, chargeback, cancellation,
 *          settlement_fee_reversal, marketplace_adjustment,
 *          payment_adjustment, concession.
 *
 * Dual-date rule (D-2): billing_posted_period set from reversal's occurred_at
 * (the current open period), NOT the original sale's period. The original rows
 * are NEVER touched (append-only by GRANT).
 *
 * Idempotent: ON CONFLICT DO NOTHING (D-4).
 */

import { type Pool } from 'pg';
import {
  type RecognitionEvent,
  type RecognitionEventType,
} from '../../domain/recognition/value-objects/RecognitionEvent.js';
import { applyRecognitionPolicy } from '../../domain/recognition/policies/RecognitionPolicy.js';
import { PgLedgerRepository } from '../../infrastructure/repositories/PgLedgerRepository.js';
import { applyRounding, type RoundingInput } from '../../domain/recognition/policies/RoundingPolicy.js';

const REVERSAL_TYPES = new Set<RecognitionEventType>([
  'rto_reversal',
  'refund',
  'chargeback',
  'cancellation',
  'settlement_fee_reversal',
  'marketplace_adjustment',
  'payment_adjustment',
  'concession',
]);

export class PostReversalCommand {
  private readonly repo: PgLedgerRepository;

  constructor(pool: Pool) {
    this.repo = new PgLedgerRepository(pool);
  }

  /**
   * Post a reversal event as a NEW signed-negative row to the CURRENT billing period.
   * Does NOT modify the original sale row (structural: no UPDATE grant).
   * Returns true if inserted, false if idempotent duplicate.
   *
   * @param event - Must be a reversal event type. amount_minor MUST be negative (callers
   *   responsibility — the DB CHECK constraint is on event_type, not sign, for flexibility
   *   with marketplace_adjustment which can be ±).
   * @param rounding - Optional sub-minor rounding input (D-7). Omit if no rounding needed.
   */
  async execute(
    event: RecognitionEvent,
    rounding?: RoundingInput,
  ): Promise<boolean> {
    if (!REVERSAL_TYPES.has(event.eventType)) {
      throw new Error(
        `[PostReversal] expected a reversal event type, got: ${event.eventType}`,
      );
    }

    let roundingAdjustmentMinor = 0n;
    if (rounding !== undefined) {
      const rounded = applyRounding(rounding);
      roundingAdjustmentMinor = rounded.roundingAdjustmentMinor;
    }

    const entry = applyRecognitionPolicy(event, roundingAdjustmentMinor);
    return this.repo.insert(entry);
  }
}

/**
 * PostFinalizationCommand — emits a finalization row for a provisional.
 * Called by the revenue-finalization Argo job (Slice 3).
 */
export class PostFinalizationCommand {
  private readonly repo: PgLedgerRepository;

  constructor(pool: Pool) {
    this.repo = new PgLedgerRepository(pool);
  }

  async execute(event: RecognitionEvent): Promise<boolean> {
    if (event.eventType !== 'finalization') {
      throw new Error(
        `[PostFinalization] expected finalization event, got: ${event.eventType}`,
      );
    }
    const entry = applyRecognitionPolicy(event);
    return this.repo.insert(entry);
  }
}
