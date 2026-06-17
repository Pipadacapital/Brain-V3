/**
 * LedgerWriter — stream-worker side ledger feed for backfilled orders (ADR-BF-9).
 *
 * The OrderEventConsumer in apps/core is not importable from stream-worker
 * (stream-worker does not depend on @brain/core). This module provides the minimal
 * ledger INSERT needed to wire backfill Bronze events → provisional_recognition,
 * matching the exact same schema as RecognizeOrder → PgLedgerRepository → realized_revenue_ledger.
 *
 * This is NOT a fork of the recognition logic — it writes the same schema,
 * uses the same dedup key (ON CONFLICT on the composite key), and produces rows
 * that the EXISTING revenue-finalization.ts job finalizes unchanged (ADR-BF-10).
 *
 * Money: amount_minor stays BIGINT-as-string throughout (I-S07).
 * Idempotent: ON CONFLICT (brand_id, order_id, event_type, date) DO NOTHING (I-ST04).
 * All writes under brain_app + set_config GUC per brand (NN-1 / RLS).
 *
 * Ledger event_id derivation: SHA-256(brand_id\0order_id\0'provisional_recognition'\0source_pk\0v1)
 *   — mirrors revenue-finalization.ts computeLedgerEventId (stable dedup key).
 *
 * payment_method → horizon:
 *   'cod' → cod_recognition_horizon_days (larger horizon, conservative)
 *   'prepaid' → prepaid_recognition_horizon_days (shorter)
 *   The finalization job applies the actual horizon from brand config (no need to store it).
 */

import { Pool, PoolClient } from 'pg';
import { createHash } from 'node:crypto';

const VERSION = 'v1';

export interface BackfillOrderForLedger {
  brandId: string;
  orderId: string;
  brainId: string | null;
  amountMinor: string;   // BIGINT-as-string (D-13 / I-S07)
  currencyCode: string;
  occurredAt: string;    // ISO-8601 — D-6: processed_at from Shopify order
  paymentMethod: 'cod' | 'prepaid';
  sourcePk: string;      // Bronze event_id (used for dedup + supersedes reference)
  rawEventId: string;    // same as sourcePk for backfill
}

function computeLedgerEventId(params: {
  brandId: string;
  orderId: string;
  eventType: string;
  sourcePk: string;
}): string {
  return createHash('sha256')
    .update(`${params.brandId}\0${params.orderId}\0${params.eventType}\0${params.sourcePk}\0${VERSION}`)
    .digest('hex');
}

function toBillingPostedPeriod(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

export class LedgerWriter {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 3,
      idleTimeoutMillis: 30_000,
      statement_timeout: 15_000,
    });
  }

  /**
   * Write a provisional_recognition row for a backfilled order.
   * Idempotent: ON CONFLICT DO NOTHING.
   * Returns true if inserted, false if suppressed (replay / dedup).
   */
  async writeProvisionalRecognition(order: BackfillOrderForLedger): Promise<boolean> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // GUC-first: brand context required for RLS (NN-1)
      await client.query(
        "SELECT set_config('app.current_brand_id', $1, true)",
        [order.brandId],
      );

      const occurredAt = new Date(order.occurredAt);
      const billingPostedPeriod = toBillingPostedPeriod(occurredAt);

      const ledgerEventId = computeLedgerEventId({
        brandId: order.brandId,
        orderId: order.orderId,
        eventType: 'provisional_recognition',
        sourcePk: order.sourcePk,
      });

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
          $1, $2, $3, $4, 'provisional_recognition',
          $5::bigint, $6, NULL,
          0::bigint,
          $7, $7, $8, 'provisional',
          $9
        )
        ON CONFLICT (brand_id, order_id, event_type, (timezone('UTC', occurred_at)::date))
        DO NOTHING
        RETURNING ledger_event_id`,
        [
          order.brandId,
          ledgerEventId,
          order.orderId,
          order.brainId,
          order.amountMinor,
          order.currencyCode,
          order.occurredAt,          // ISO-8601 → timestamptz cast (D-6)
          billingPostedPeriod,
          order.rawEventId,
        ],
      );

      await client.query('COMMIT');

      const inserted = (result.rowCount ?? 0) > 0;
      if (inserted) {
        console.info(
          `[ledger-writer] provisional_recognition brand=${order.brandId} ` +
          `order=${order.orderId} amount=${order.amountMinor} ${order.currencyCode}`,
        );
      }
      return inserted;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Write an rto_reversal or cancellation row for a live order that was cancelled (D-13 / ADR-LV-11).
   *
   * Called when a live Bronze order has cancelled_at != null (RTO or cancellation signal).
   * Writes a NEW negative ledger row — the original provisional/finalized rows are UNTOUCHED
   * (append-only by GRANT: brain_app has SELECT+INSERT only; no UPDATE/DELETE).
   *
   * The negative amount causes realized_gmv_as_of() to fall because:
   *   realized_gmv_as_of = SUM(amount_minor) WHERE event_type != 'provisional_recognition'
   *   → positive finalization (+X) + negative reversal (-X) = 0 net realized.
   *
   * Dedup: ON CONFLICT (brand_id, order_id, 'rto_reversal', occurred_at::date) DO NOTHING
   * so if the same cancellation state arrives twice (re-pull retry), the reversal is written once.
   *
   * @param order   The recognized order details (from Bronze event)
   * @param reversalEventType  'rto_reversal' | 'cancellation' (D-13)
   * @returns true if a new reversal row was inserted, false if deduped
   */
  async writeReversal(
    order: BackfillOrderForLedger,
    reversalEventType: 'rto_reversal' | 'cancellation' = 'rto_reversal',
  ): Promise<boolean> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // GUC-first: brand context required for RLS (NN-1)
      await client.query(
        "SELECT set_config('app.current_brand_id', $1, true)",
        [order.brandId],
      );

      // Reversal occurred_at = the economic time of the cancellation.
      // Use the order's occurred_at (which for live events = updated_at / cancelled_at).
      // This must differ from the original sale's occurred_at to create a distinct
      // ledger row (the UNIQUE constraint is per day, so a cancellation on a different
      // calendar day than the original sale will NOT conflict — which is the COD RTO pattern).
      const occurredAt = new Date(order.occurredAt);
      const billingPostedPeriod = toBillingPostedPeriod(occurredAt);

      // Reversal ledger_event_id uses the reversal event_type in its hash (distinct from
      // the provisional/finalization ledger_event_ids for the same order)
      const ledgerEventId = computeLedgerEventId({
        brandId: order.brandId,
        orderId: order.orderId,
        eventType: reversalEventType,
        sourcePk: order.sourcePk,
      });

      // amount_minor is NEGATIVE for reversals (signed BigInt arithmetic — I-S07)
      // Input is the recognized positive amount; we negate it here.
      const negativeAmountMinor = `-${order.amountMinor}`;

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
          0::bigint,
          $8, $8, $9, 'finalized',
          $10
        )
        ON CONFLICT (brand_id, order_id, event_type, (timezone('UTC', occurred_at)::date))
        DO NOTHING
        RETURNING ledger_event_id`,
        [
          order.brandId,
          ledgerEventId,
          order.orderId,
          order.brainId,
          reversalEventType,
          negativeAmountMinor,   // signed negative (I-S07: BigInt-as-string)
          order.currencyCode,
          order.occurredAt,      // economic time of the reversal
          billingPostedPeriod,
          order.rawEventId,
        ],
      );

      await client.query('COMMIT');

      const inserted = (result.rowCount ?? 0) > 0;
      if (inserted) {
        console.info(
          `[ledger-writer] ${reversalEventType} brand=${order.brandId} ` +
          `order=${order.orderId} amount=${negativeAmountMinor} ${order.currencyCode}`,
        );
      }
      return inserted;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}
