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
 * SEC-BF-M2 (no-drift): this is a second, independent implementation of the same ledger dedup as
 * apps/core PgLedgerRepository. The realized_revenue_ledger ON CONFLICT clause here MUST stay
 * byte-identical to core's — including the `WHERE event_type <> 'refund'` partial-index predicate
 * (migration 0054). The drift-guard test ledger-conflict-parity.test.ts fails if the two diverge.
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
import { incrementCounter } from '@brain/observability';
import { log } from "../../log.js";

const VERSION = 'v1';

/** Event types that REVERSE an order's recognized revenue (reduce realized). */
const REVENUE_REVERSAL_EVENT_TYPES = [
  'rto_reversal',
  'refund',
  'chargeback',
  'cancellation',
  'concession',
  'settlement_reversal',
] as const;

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
        ON CONFLICT (brand_id, order_id, event_type, (timezone('UTC', occurred_at)::date)) WHERE event_type <> 'refund'
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
        log.info(`[ledger-writer] provisional_recognition brand=${order.brandId} ` +
                    `order=${order.orderId} amount=${order.amountMinor} ${order.currencyCode}`);
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
        ON CONFLICT (brand_id, order_id, event_type, (timezone('UTC', occurred_at)::date)) WHERE event_type <> 'refund'
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

      // F2: cumulative reversals must never silently exceed the recognized sale. Detect it WITHIN
      // the txn (read-your-writes sees this reversal) so an over-reversal — a duplicate refund, or a
      // refund + chargeback on one order — is SURFACED (counter + warn) instead of silently driving
      // realized revenue negative. Truth stays in the ledger (signed rows); we just make it loud.
      const inserted = (result.rowCount ?? 0) > 0;
      const overReversed = inserted ? await this.isOrderOverReversed(client, order.brandId, order.orderId) : false;

      await client.query('COMMIT');

      if (inserted) {
        log.info(`[ledger-writer] ${reversalEventType} brand=${order.brandId} ` +
                    `order=${order.orderId} amount=${negativeAmountMinor} ${order.currencyCode}`);
        if (overReversed) this.signalOverReversal(order.brandId, order.orderId, reversalEventType);
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
   * writeRefund — append a negative 'refund' row for ONE refund (feat-shopify-refund-ledger-reversal).
   *
   * The order's refunds ride on every order.live.v1 restatement (payload.properties.refunds[]); this
   * writes one ledger row PER REFUND so a refund actually reduces realized revenue. Idempotency is the
   * PRIMARY KEY (brand_id, ledger_event_id) — ledger_event_id hashes the refund_id (passed as
   * `refund.sourcePk`) — NOT the date-grain dedup (made partial-excluding-refund in migration 0054), so
   * two distinct same-day refunds coexist while a re-delivered refund collapses to one row.
   *
   * `refund.amountMinor` is the POSITIVE refund amount (minor units); it is negated here. `occurredAt`
   * is the refund's processed_at (its economic time). Returns true iff a new row was inserted.
   */
  async writeRefund(refund: BackfillOrderForLedger): Promise<boolean> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_brand_id', $1, true)", [refund.brandId]);

      const occurredAt = new Date(refund.occurredAt);
      const billingPostedPeriod = toBillingPostedPeriod(occurredAt);
      const ledgerEventId = computeLedgerEventId({
        brandId: refund.brandId,
        orderId: refund.orderId,
        eventType: 'refund',
        sourcePk: refund.sourcePk, // the refund_id → per-refund dedup
      });
      const negativeAmountMinor = `-${refund.amountMinor}`; // signed negative (I-S07)

      const result = await client.query<{ ledger_event_id: string }>(
        `INSERT INTO realized_revenue_ledger (
          brand_id, ledger_event_id, order_id, brain_id, event_type,
          amount_minor, currency_code, fx_rate_id, rounding_adjustment_minor,
          occurred_at, economic_effective_at, billing_posted_period, recognition_label, raw_event_id
        ) VALUES (
          $1, $2, $3, $4, 'refund',
          $5::bigint, $6, NULL, 0::bigint,
          $7, $7, $8, 'finalized', $9
        )
        ON CONFLICT (brand_id, ledger_event_id) DO NOTHING
        RETURNING ledger_event_id`,
        [
          refund.brandId,
          ledgerEventId,
          refund.orderId,
          refund.brainId,
          negativeAmountMinor,
          refund.currencyCode,
          refund.occurredAt,
          billingPostedPeriod,
          refund.rawEventId,
        ],
      );

      // F2: refunds count toward the over-reversal guard (cumulative reversals > recognized sale).
      const inserted = (result.rowCount ?? 0) > 0;
      const overReversed = inserted ? await this.isOrderOverReversed(client, refund.brandId, refund.orderId) : false;
      await client.query('COMMIT');

      if (inserted) {
        log.info(`[ledger-writer] refund brand=${refund.brandId} order=${refund.orderId} ` +
          `refund=${refund.sourcePk} amount=${negativeAmountMinor} ${refund.currencyCode}`);
        if (overReversed) this.signalOverReversal(refund.brandId, refund.orderId, 'refund');
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
   * isOrderOverReversed (F2) — true when cumulative reversals for an order EXCEED its recognized
   * sale (the provisional_recognition amount). A single full RTO (reversed == sale) is NOT over —
   * only a genuine over-subtraction (duplicate refund, refund+chargeback, partials summing past the
   * sale) trips it. Runs inside the caller's txn under the brand GUC (RLS-scoped).
   */
  private async isOrderOverReversed(
    client: PoolClient,
    brandId: string,
    orderId: string,
  ): Promise<boolean> {
    const res = await client.query<{ over: boolean }>(
      `SELECT
         COALESCE(SUM(-amount_minor) FILTER (WHERE event_type = ANY($3::text[])), 0)
           > COALESCE(SUM(amount_minor) FILTER (WHERE event_type = 'provisional_recognition'), 0)
         AND COALESCE(SUM(amount_minor) FILTER (WHERE event_type = 'provisional_recognition'), 0) > 0
         AS over
       FROM realized_revenue_ledger
       WHERE brand_id = $1 AND order_id = $2`,
      [brandId, orderId, REVENUE_REVERSAL_EVENT_TYPES as unknown as string[]],
    );
    return res.rows[0]?.over === true;
  }

  /**
   * signalOverReversal (F2) — make an over-reversal OBSERVABLE: a counter (alertable — see the C2
   * brain-slo rules) + a structured warning naming the order. Never throws (observability is
   * best-effort; it must not affect the already-committed ledger write).
   */
  private signalOverReversal(brandId: string, orderId: string, eventType: string): void {
    try {
      incrementCounter('revenue_over_reversal_total', { brand_id: brandId });
      log.warn(
        `[ledger-writer] OVER-REVERSAL brand=${brandId} order=${orderId} via=${eventType} — ` +
          'cumulative reversals exceed the recognized sale; realized revenue for this order is ' +
          'negative. Reconcile (likely a duplicate refund or refund+chargeback).',
      );
    } catch {
      /* non-fatal */
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
        ON CONFLICT (brand_id, order_id, event_type, (timezone('UTC', occurred_at)::date)) WHERE event_type <> 'refund'
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

      // F2: a settlement reversal (refund/chargeback settlement) can push cumulative reversals past
      // the recognized sale just like an RTO can — detect it within the txn and signal (don't silently
      // go negative). Only for per-order reversal rows; brand-level rows have no provisional sale.
      const inserted = (result.rowCount ?? 0) > 0;
      const isReversal = (REVENUE_REVERSAL_EVENT_TYPES as readonly string[]).includes(params.eventType);
      const overReversed =
        inserted && isReversal && params.reconciliationType === 'per_order'
          ? await this.isOrderOverReversed(client, params.brandId, params.orderId)
          : false;

      await client.query('COMMIT');

      if (inserted) {
        log.info(`[ledger-writer] ${params.eventType} brand=${params.brandId} ` +
                    `order=${params.orderId} amount=${params.amountMinor} ${params.currencyCode} ` +
                    `reconciliation=${params.reconciliationType}`);
        if (overReversed) this.signalOverReversal(params.brandId, params.orderId, params.eventType);
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
        ON CONFLICT (brand_id, order_id, event_type, (timezone('UTC', occurred_at)::date)) WHERE event_type <> 'refund'
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
        ON CONFLICT (brand_id, order_id, event_type, (timezone('UTC', occurred_at)::date)) WHERE event_type <> 'refund'
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
        log.info(`[ledger-writer] fee+tax rows brand=${params.brandId} order=${params.orderId} ` +
                    `fee=${params.feeMinor} tax=${params.taxMinor} ${params.currencyCode} taxCode=${params.taxCode}`);
      }
      return inserted;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  // ── CoD/RTO ledger writes (feat-gokwik-shopflo-connectors / 0030) ────────────
  //
  // GoKwik AWB terminal states drive two ledger event_types:
  //   cod_rto_clawback       — terminal RTO on a CoD order → reverse recognized revenue (−)
  //   cod_delivery_confirmed — terminal Delivered on a CoD order → confirm recognition (provenance, 0)
  //
  // The clawback REVERSES the recognized CoD revenue. We look up the net recognized amount for
  // the order from the ledger (SUM over non-provisional rows, falling back to provisional) and
  // write a signed-NEGATIVE clawback so realized_gmv_as_of() falls. Append-only by GRANT;
  // ON CONFLICT DO NOTHING (idempotent restatement — a re-pull re-emitting the same terminal
  // transition writes the clawback once).

  /**
   * Net recognized amount (minor units) for a CoD order, used to size the clawback.
   * Prefers non-provisional rows (finalization/settlement); falls back to provisional_recognition.
   * Returns '0' if no recognized rows exist for the order.
   * Read under brand GUC (NN-1 / RLS).
   */
  async lookupRecognizedAmountMinor(brandId: string, orderId: string): Promise<string> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_brand_id', $1, true)", [brandId]);
      // Non-provisional net first (mirrors realized_gmv_as_of exclusion of provisional rows).
      const realized = await client.query<{ net: string | null }>(
        `SELECT COALESCE(SUM(amount_minor), 0)::text AS net
         FROM realized_revenue_ledger
         WHERE brand_id = $1 AND order_id = $2 AND event_type <> 'provisional_recognition'`,
        [brandId, orderId],
      );
      let net = realized.rows[0]?.net ?? '0';
      if (BigInt(net) === 0n) {
        // Fall back to provisional recognition (order recognized but not yet finalized).
        const prov = await client.query<{ net: string | null }>(
          `SELECT COALESCE(SUM(amount_minor), 0)::text AS net
           FROM realized_revenue_ledger
           WHERE brand_id = $1 AND order_id = $2 AND event_type = 'provisional_recognition'`,
          [brandId, orderId],
        );
        net = prov.rows[0]?.net ?? '0';
      }
      await client.query('COMMIT');
      return net;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Write a CoD/RTO terminal ledger row. Idempotent (ON CONFLICT DO NOTHING).
   *   - cod_rto_clawback: amountMinor MUST be signed-negative (the reversal).
   *   - cod_delivery_confirmed: amountMinor is '0' (provenance marker; does not move realized GMV).
   * Returns true if inserted, false if deduped (replay / re-pull restatement).
   */
  async writeCodLedgerEvent(params: {
    brandId: string;
    orderId: string;
    eventType: 'cod_rto_clawback' | 'cod_delivery_confirmed';
    amountMinor: string;       // SIGNED BIGINT-as-string ('-12345' for clawback, '0' for confirm)
    currencyCode: string;
    occurredAt: string;        // ISO-8601 — status_changed_at (event-time)
    rawEventId: string;        // Bronze event_id provenance
  }): Promise<boolean> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_brand_id', $1, true)", [params.brandId]);

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
          brand_id, ledger_event_id, order_id, brain_id, event_type,
          amount_minor, currency_code, fx_rate_id, rounding_adjustment_minor,
          occurred_at, economic_effective_at, billing_posted_period,
          recognition_label, reconciliation_type, raw_event_id
        ) VALUES (
          $1, $2, $3, NULL, $4,
          $5::bigint, $6, NULL, 0::bigint,
          $7, $7, $8, 'finalized', 'per_order', $9
        )
        ON CONFLICT (brand_id, order_id, event_type, (timezone('UTC', occurred_at)::date)) WHERE event_type <> 'refund'
        DO NOTHING
        RETURNING ledger_event_id`,
        [
          params.brandId,
          ledgerEventId,
          params.orderId,
          params.eventType,
          params.amountMinor,
          params.currencyCode,
          params.occurredAt,
          billingPostedPeriod,
          params.rawEventId,
        ],
      );

      await client.query('COMMIT');
      const inserted = (result.rowCount ?? 0) > 0;
      if (inserted) {
        log.info(`[ledger-writer] ${params.eventType} brand=${params.brandId} ` +
                    `order=${params.orderId} amount=${params.amountMinor} ${params.currencyCode}`);
      }
      return inserted;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  // ── Ad-spend fact writes (feat-ad-connectors Slice 1 / ADR-AD-6) ─────────────
  //
  // Writes the append-only ad_spend_ledger fact. Distinct from realized_revenue_ledger
  // (spend is a distinct economic concept + grain — would corrupt realized_gmv_as_of()).
  //   - Under brand GUC (NN-1 / RLS enforced).
  //   - ON CONFLICT (brand_id, platform, level, level_id, stat_date) DO NOTHING (I-ST04 —
  //     idempotent trailing re-read; spend is fixed at click-date so the key is stable).
  //   - spend_minor is BIGINT-as-string (I-S07 — no parseFloat anywhere upstream).
  //   - Append-only by GRANT (brain_app: SELECT+INSERT only on ad_spend_ledger).

  /**
   * Write an ad_spend_ledger row. Idempotent on the dedup key.
   * Returns true if inserted, false if deduped (replay / re-pull).
   */
  async writeAdSpend(params: {
    brandId: string;
    spendEventId: string;       // ADR-AD-5 deterministic id (= raw_event_id / Bronze event_id)
    platform: 'meta' | 'google_ads';
    level: 'campaign' | 'adset' | 'ad' | 'creative';
    levelId: string;
    parentId: string | null;
    campaignId: string | null;
    campaignName: string | null;
    statDate: string;           // YYYY-MM-DD (click-date anchored, canonical)
    spendMinor: string;         // BIGINT-as-string (I-S07)
    currencyCode: string;
    impressions: string | null; // BIGINT-as-string
    clicks: string | null;      // BIGINT-as-string
    conversionsRaw: Record<string, unknown> | null;  // RAW (ADR-AD-8)
    accountTimezone: string | null;
    rawEventId: string;         // Bronze provenance (= spendEventId)
    occurredAt: string;         // ISO-8601
  }): Promise<boolean> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // GUC-first: brand context required for RLS (NN-1)
      await client.query(
        "SELECT set_config('app.current_brand_id', $1, true)",
        [params.brandId],
      );

      const result = await client.query<{ spend_event_id: string }>(
        `INSERT INTO ad_spend_ledger (
          brand_id, spend_event_id, platform, level, level_id, parent_id,
          campaign_id, campaign_name, stat_date, spend_minor, currency_code,
          impressions, clicks, conversions_raw, account_timezone, raw_event_id, occurred_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9::date, $10::bigint, $11,
          $12::bigint, $13::bigint, $14::jsonb, $15, $16, $17
        )
        ON CONFLICT (brand_id, platform, level, level_id, stat_date)
        DO NOTHING
        RETURNING spend_event_id`,
        [
          params.brandId,
          params.spendEventId,
          params.platform,
          params.level,
          params.levelId,
          params.parentId,
          params.campaignId,
          params.campaignName,
          params.statDate,
          params.spendMinor,
          params.currencyCode,
          params.impressions,
          params.clicks,
          params.conversionsRaw ? JSON.stringify(params.conversionsRaw) : null,
          params.accountTimezone,
          params.rawEventId,
          params.occurredAt,
        ],
      );

      await client.query('COMMIT');

      const inserted = (result.rowCount ?? 0) > 0;
      if (inserted) {
        log.info(`[ledger-writer] ad_spend brand=${params.brandId} platform=${params.platform} ` +
                    `level=${params.level} level_id=${params.levelId} stat_date=${params.statDate} ` +
                    `spend=${params.spendMinor} ${params.currencyCode}`);
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
