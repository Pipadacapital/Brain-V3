/**
 * PgRazorpayOrderMapRepository — writes to connector_razorpay_order_map via
 * the upsert_razorpay_order_map() SECURITY DEFINER function (or direct UPSERT
 * under brand GUC).
 *
 * MB-1 / ADR-RZ-7.4:
 *   Populated at payment.captured webhook time — this is the HARD prerequisite
 *   for SettlementLedgerConsumer to produce any correctly-reconciled rows.
 *
 * Design:
 *   Uses raw pg.Pool with explicit BEGIN/COMMIT so we can SET LOCAL the brand
 *   GUC before the UPSERT (FORCE RLS requires it under brain_app role).
 *   Raw razorpay_payment_id stored here (RLS-protected, internal join use only
 *   — never in Bronze events, ledger rows, or logs).
 *
 * C1: razorpay_payment_id is stored in this table for join use. This table has
 *     FORCE RLS with brain_id isolation — it is NOT a Bronze event table.
 *
 * I-S09 / C5: raw payment_id passed in is stored in the table row but NEVER
 *     logged. The caller (webhook handler) logs only structured metrics without
 *     raw IDs.
 */

import type pg from 'pg';

export interface OrderMapRowInput {
  brand_id: string;
  razorpay_order_id: string | null;
  shopify_order_id: string;
  razorpay_payment_id: string;  // raw — stored in RLS-protected map table only (C1)
}

export class PgRazorpayOrderMapRepository {
  constructor(private readonly rawPgPool: pg.Pool) {}

  /**
   * Upsert a connector_razorpay_order_map row under brand GUC.
   * ON CONFLICT (brand_id, razorpay_payment_id) DO UPDATE updates the shopify_order_id
   * and razorpay_order_id (webhook re-delivery safety — the map table is a lookup table,
   * not append-only, so re-delivery of the same payment with updated notes is safe).
   *
   * I-S09/C5: razorpay_payment_id is never logged — only used as a PG parameter.
   */
  async upsert(row: OrderMapRowInput): Promise<void> {
    const client = await this.rawPgPool.connect();
    try {
      await client.query('BEGIN');
      // FORCE RLS requires GUC to be set txn-local (NN-1 / I-S01).
      // Use set_config() fn (parameterized) rather than SET LOCAL (which does not support $1).
      await client.query(`SELECT set_config('app.current_brand_id', $1, true)`, [row.brand_id]);

      await client.query(
        `INSERT INTO connector_razorpay_order_map
           (brand_id, razorpay_order_id, shopify_order_id, razorpay_payment_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (brand_id, razorpay_payment_id) DO UPDATE SET
           razorpay_order_id = EXCLUDED.razorpay_order_id,
           shopify_order_id  = EXCLUDED.shopify_order_id`,
        [row.brand_id, row.razorpay_order_id, row.shopify_order_id, row.razorpay_payment_id],
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
