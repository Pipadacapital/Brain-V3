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

  async end(): Promise<void> {
    await this.pool.end();
  }
}
