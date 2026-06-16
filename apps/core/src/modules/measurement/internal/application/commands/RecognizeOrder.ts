/**
 * RecognizeOrder — CQRS write command.
 * Bronze order event → provisional_recognition row in realized_revenue_ledger.
 * Idempotent via dedup UNIQUE + ON CONFLICT DO NOTHING (D-4).
 * All money via @brain/money Money (no floats, I-S07).
 */

import { type Pool } from 'pg';
import { type RecognitionEvent } from '../../domain/recognition/value-objects/RecognitionEvent.js';
import { applyRecognitionPolicy } from '../../domain/recognition/policies/RecognitionPolicy.js';
import { PgLedgerRepository } from '../../infrastructure/repositories/PgLedgerRepository.js';

export class RecognizeOrderCommand {
  private readonly repo: PgLedgerRepository;

  constructor(pool: Pool) {
    this.repo = new PgLedgerRepository(pool);
  }

  /**
   * Write a provisional_recognition entry for an order event.
   * Returns true if inserted, false if idempotent (duplicate suppressed).
   */
  async execute(event: RecognitionEvent): Promise<boolean> {
    if (event.eventType !== 'provisional_recognition') {
      throw new Error(
        `[RecognizeOrder] expected provisional_recognition event, got: ${event.eventType}`,
      );
    }
    const entry = applyRecognitionPolicy(event);
    return this.repo.insert(entry);
  }
}
