/**
 * PgLedgerRepository — writes LedgerEntry rows to realized_revenue_ledger.
 *
 * Pattern mirrors BronzeRepository (0016 append-only-by-grant):
 *   1. set_config('app.current_brand_id', brandId, true) in same txn (GUC-first)
 *   2. INSERT ... ON CONFLICT (brand_id, order_id, event_type, (timezone('UTC',occurred_at)::date))
 *      DO NOTHING  → idempotent at dedup key (D-4)
 *   3. Increment replay-suppression counter if row was suppressed
 *
 * Connection is brain_app — RLS enforced; no UPDATE/DELETE grants.
 * All money as bigint from LedgerEntry.money.amount_minor (never float, I-S07).
 *
 * Replay-suppression metric: ledger_replay_suppressed_total{brand_id, event_type}
 * Tier-0 deterministic — no model call.
 */

import { Pool, type PoolClient } from 'pg';
import { type LedgerEntry } from '../../domain/recognition/entities/LedgerEntry.js';

// Simple in-process counter for replay suppression (Tier-0 metric).
// In production this would emit to the observability spine; for M1 it logs.
const replaySuppressedTotal: Record<string, number> = {};

function incrementReplaySuppressed(brandId: string, eventType: string): void {
  const key = `${brandId}:${eventType}`;
  replaySuppressedTotal[key] = (replaySuppressedTotal[key] ?? 0) + 1;
  console.info(
    `[ledger] replay suppressed brand=${brandId} event_type=${eventType} ` +
    `total=${replaySuppressedTotal[key]} (ledger_replay_suppressed_total)`,
  );
}

/** Expose for tests to read the suppression counter. */
export function getReplaySuppressedTotal(): Readonly<Record<string, number>> {
  return replaySuppressedTotal;
}

/** Reset suppression counter (test only). */
export function resetReplaySuppressedTotal(): void {
  for (const key of Object.keys(replaySuppressedTotal)) {
    delete replaySuppressedTotal[key];
  }
}

export class PgLedgerRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Write a LedgerEntry to realized_revenue_ledger.
   * Idempotent: ON CONFLICT (dedup key) DO NOTHING.
   * Returns true if inserted, false if suppressed (replay).
   * Executes in a single transaction with GUC set first.
   */
  async insert(entry: LedgerEntry): Promise<boolean> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // GUC-first: set brand context in same transaction (RLS requires this)
      await client.query("SELECT set_config('app.current_brand_id', $1, true)", [entry.brandId]);

      const result = await client.query<{ ledger_event_id: string }>(
        `INSERT INTO realized_revenue_ledger (
          brand_id,
          ledger_event_id,
          order_id,
          brain_id,
          event_type,
          amount_minor,
          currency_code,
          fx_rate_id,
          rounding_adjustment_minor,
          occurred_at,
          economic_effective_at,
          billing_posted_period,
          recognition_label,
          raw_event_id
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6::bigint, $7, NULL,
          $8::bigint,
          $9, $10, $11, $12, $13
        )
        ON CONFLICT (brand_id, order_id, event_type, (timezone('UTC', occurred_at)::date))
        DO NOTHING
        RETURNING ledger_event_id`,
        [
          entry.brandId,
          entry.ledgerEventId,
          entry.orderId,
          entry.brainId,
          entry.eventType,
          entry.money.amount_minor.toString(),    // pg driver: bigint as string
          entry.money.currency_code,
          entry.roundingAdjustmentMinor.toString(),
          entry.occurredAt.toISOString(),
          entry.economicEffectiveAt.toISOString(),
          entry.billingPostedPeriod,
          entry.recognitionLabel,
          entry.rawEventId,
        ],
      );

      await client.query('COMMIT');

      const inserted = (result.rowCount ?? 0) > 0;
      if (!inserted) {
        incrementReplaySuppressed(entry.brandId, entry.eventType);
      }
      return inserted;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
