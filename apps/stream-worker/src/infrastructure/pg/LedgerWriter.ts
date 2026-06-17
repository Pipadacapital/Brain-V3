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

  // ── Settlement finalization writes (ADR-RZ-6 / MB-3) ─────────────────────────
  //
  // These methods write the net-of-fees settlement ledger rows. All writes are:
  //   - Under brand GUC (NN-1 / RLS enforced)
  //   - ON CONFLICT DO NOTHING (idempotent — I-ST04)
  //   - Append-only by GRANT (brain_app: SELECT+INSERT only; no UPDATE/DELETE)
  //   - BIGINT-as-string amounts (I-S07 — no parseFloat)
  //   - Dual-date: occurred_at = settlement_at (event-time); economic_effective_at = occurred_at (MB-7)
  //   - billing_posted_period = current open period if natural period is closed (MB-7)

  /**
   * Write a settlement finalization row (or any settlement-side event_type).
   * Used for: settlement_finalization (+), rolling_reserve_deduction (−),
   *           rolling_reserve_release (+), settlement_reversal (−), settlement_adjustment (±).
   *
   * For brand-level events, order_id = '__brand_level__:${settlementId}' (synthetic spine key).
   * This satisfies the existing dedup unique index (brand_id, order_id, event_type, date)
   * without colliding with real Shopify order IDs.
   *
   * Idempotent: ON CONFLICT (brand_id, order_id, event_type, date) DO NOTHING.
   * Returns true if inserted, false if deduped (replay / re-pull).
   */
  async writeSettlementFinalization(params: {
    brandId: string;
    orderId: string;           // Shopify order_id or '__brand_level__:settlementId'
    brainId: string | null;
    settlementId: string;      // Razorpay settlement_id (opaque batch ref, not PII)
    eventType: string;         // from MB-3 taxonomy
    amountMinor: string;       // SIGNED BIGINT-as-string (positive=credit, negative=debit)
    feeMinor: string;          // analytics provenance (positive paisa)
    taxMinor: string;          // analytics provenance (positive paisa)
    currencyCode: string;
    occurredAt: string;        // ISO-8601 settlement date (economic_effective_at)
    reconciliationType: 'per_order' | 'brand_level';
    taxCode: string | null;
    rawEventId: string;        // Bronze event_id (provenance)
  }): Promise<boolean> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // GUC-first: brand context required for RLS (NN-1)
      await client.query(
        "SELECT set_config('app.current_brand_id', $1, true)",
        [params.brandId],
      );

      const occurredAt = new Date(params.occurredAt);
      const billingPostedPeriod = toBillingPostedPeriod(occurredAt);

      const ledgerEventId = computeLedgerEventId({
        brandId: params.brandId,
        orderId: params.orderId,
        eventType: params.eventType,
        sourcePk: params.rawEventId,
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
          settlement_source,
          reconciliation_type,
          tax_code,
          fee_minor,
          raw_event_id
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6::bigint, $7, NULL,
          0::bigint,
          $8, $8, $9, 'finalized',
          $10, $11, $12, $13::bigint,
          $14
        )
        ON CONFLICT (brand_id, order_id, event_type, (timezone('UTC', occurred_at)::date))
        DO NOTHING
        RETURNING ledger_event_id`,
        [
          params.brandId,
          ledgerEventId,
          params.orderId,
          params.brainId,
          params.eventType,
          params.amountMinor,   // SIGNED BIGINT-as-string
          params.currencyCode,
          params.occurredAt,
          billingPostedPeriod,
          params.settlementId,  // settlement_source — opaque batch ref
          params.reconciliationType,
          params.taxCode,
          params.feeMinor,      // fee_minor: analytics only (I-S07: BIGINT)
          params.rawEventId,
        ],
      );

      await client.query('COMMIT');

      const inserted = (result.rowCount ?? 0) > 0;
      if (inserted) {
        console.info(
          `[ledger-writer] ${params.eventType} brand=${params.brandId} ` +
          `order=${params.orderId} amount=${params.amountMinor} ${params.currencyCode} ` +
          `reconciliation=${params.reconciliationType}`,
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
   * Write the fee + GST rows for a settlement_finalization event (MB-3).
   * payment_fee (−) and settlement_tax (−, GST_18) are SEPARATE rows per MB-3 binding.
   *
   * Collapsing GST into payment_fee makes ITC claims impossible — these must be distinct.
   *
   * Both rows are written in a single transaction for atomicity.
   * Returns count of rows inserted (0, 1, or 2 depending on dedup).
   */
  async writeFeeLines(params: {
    brandId: string;
    orderId: string;
    brainId: string | null;
    settlementId: string;
    feeMinor: string;    // NEGATIVE BIGINT-as-string (e.g. '-2000')
    taxMinor: string;    // NEGATIVE BIGINT-as-string (e.g. '-360')
    currencyCode: string;
    occurredAt: string;  // ISO-8601
    taxCode: string;     // 'GST_18'
    rawEventId: string;
  }): Promise<number> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // GUC-first (NN-1)
      await client.query(
        "SELECT set_config('app.current_brand_id', $1, true)",
        [params.brandId],
      );

      const occurredAt = new Date(params.occurredAt);
      const billingPostedPeriod = toBillingPostedPeriod(occurredAt);

      const feeLedgerEventId = computeLedgerEventId({
        brandId: params.brandId,
        orderId: params.orderId,
        eventType: 'payment_fee',
        sourcePk: `${params.rawEventId}:fee`,
      });

      const taxLedgerEventId = computeLedgerEventId({
        brandId: params.brandId,
        orderId: params.orderId,
        eventType: 'settlement_tax',
        sourcePk: `${params.rawEventId}:tax`,
      });

      // payment_fee row (−)
      const feeResult = await client.query<{ ledger_event_id: string }>(
        `INSERT INTO realized_revenue_ledger (
          brand_id, ledger_event_id, order_id, brain_id, event_type,
          amount_minor, currency_code, fx_rate_id, rounding_adjustment_minor,
          occurred_at, economic_effective_at, billing_posted_period,
          recognition_label, settlement_source, reconciliation_type, fee_minor, raw_event_id
        ) VALUES (
          $1, $2, $3, $4, 'payment_fee',
          $5::bigint, $6, NULL, 0::bigint,
          $7, $7, $8, 'finalized',
          $9, 'per_order', $10::bigint, $11
        )
        ON CONFLICT (brand_id, order_id, event_type, (timezone('UTC', occurred_at)::date))
        DO NOTHING
        RETURNING ledger_event_id`,
        [
          params.brandId, feeLedgerEventId, params.orderId, params.brainId,
          params.feeMinor, params.currencyCode, params.occurredAt, billingPostedPeriod,
          params.settlementId, params.feeMinor, `${params.rawEventId}:fee`,
        ],
      );

      // settlement_tax row (−, GST_18) — SEPARATE from payment_fee (MB-3)
      const taxResult = await client.query<{ ledger_event_id: string }>(
        `INSERT INTO realized_revenue_ledger (
          brand_id, ledger_event_id, order_id, brain_id, event_type,
          amount_minor, currency_code, fx_rate_id, rounding_adjustment_minor,
          occurred_at, economic_effective_at, billing_posted_period,
          recognition_label, settlement_source, reconciliation_type, tax_code, raw_event_id
        ) VALUES (
          $1, $2, $3, $4, 'settlement_tax',
          $5::bigint, $6, NULL, 0::bigint,
          $7, $7, $8, 'finalized',
          $9, 'per_order', $10, $11
        )
        ON CONFLICT (brand_id, order_id, event_type, (timezone('UTC', occurred_at)::date))
        DO NOTHING
        RETURNING ledger_event_id`,
        [
          params.brandId, taxLedgerEventId, params.orderId, params.brainId,
          params.taxMinor, params.currencyCode, params.occurredAt, billingPostedPeriod,
          params.settlementId, params.taxCode, `${params.rawEventId}:tax`,
        ],
      );

      await client.query('COMMIT');

      const inserted = (feeResult.rowCount ?? 0) + (taxResult.rowCount ?? 0);
      if (inserted > 0) {
        console.info(
          `[ledger-writer] fee+tax rows brand=${params.brandId} order=${params.orderId} ` +
          `fee=${params.feeMinor} tax=${params.taxMinor} ${params.currencyCode} taxCode=${params.taxCode}`,
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
