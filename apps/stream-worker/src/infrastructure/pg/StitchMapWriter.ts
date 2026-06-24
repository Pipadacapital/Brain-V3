/**
 * StitchMapWriter — writes the order→anon journey stitch from the LIVE/REPULL order lane (DB-AUDIT
 * journey-stitch). Previously only the Shopify webhook wrote connector_journey_stitch_map, so the
 * 1800+ repull'd orders never stitched → silver_touchpoint.stitched_* stayed NULL → attribution had
 * no journeys to credit. The order.live.v1 event now carries stitched_anon_id (read back from
 * note_attributes by the shopify-mapper); this writer upserts the stitch row, and — leveraging C2 —
 * also stamps brain_id (resolved from the order's storefront_customer_id), so the anon journey links
 * all the way to the resolved customer (silver joins stitched_anon_id → stitched_brain_id).
 *
 * Best-effort by contract: a failure NEVER blocks the ledger write / offset commit (the webhook path
 * and a re-pull both re-upsert idempotently on (brand_id, order_id)).
 */
import type { Pool } from 'pg';

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

export class StitchMapWriter {
  constructor(private readonly pool: Pool) {}

  /**
   * Upsert the order→anon stitch. brain_id is COALESCE'd so a later resolution never clobbers an
   * existing one with NULL. Runs under the brand GUC in a txn (connector_journey_stitch_map FORCE RLS).
   */
  async upsert(
    brandId: string,
    orderId: string,
    stitchedAnonId: string,
    brainId: string | null,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_brand_id', $1, true),
                                 set_config('app.current_user_id', $2, true),
                                 set_config('app.current_workspace_id', $2, true)`, [brandId, NIL_UUID]);
      await client.query(
        `INSERT INTO connectors.connector_journey_stitch_map (brand_id, order_id, stitched_anon_id, brain_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (brand_id, order_id) DO UPDATE
           SET stitched_anon_id = EXCLUDED.stitched_anon_id,
               brain_id         = COALESCE(EXCLUDED.brain_id, connector_journey_stitch_map.brain_id)`,
        [brandId, orderId, stitchedAnonId, brainId],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err; // caller wraps best-effort
    } finally {
      client.release();
    }
  }

  /**
   * Batched upsert — ONE transaction per brand for many stitch rows: connect, BEGIN, set the brand
   * GUC once, then a single multi-row INSERT ... VALUES (...),(...) ON CONFLICT (...) DO UPDATE.
   * Same ON CONFLICT (brand_id, order_id) + COALESCE(brain_id) semantics as upsert(), so a later
   * resolution never clobbers an existing brain_id with NULL. Idempotent / replay-safe.
   */
  async upsertMany(
    brandId: string,
    rows: ReadonlyArray<{ orderId: string; stitchedAnonId: string; brainId: string | null }>,
  ): Promise<void> {
    if (rows.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_brand_id', $1, true),
                                 set_config('app.current_user_id', $2, true),
                                 set_config('app.current_workspace_id', $2, true)`, [brandId, NIL_UUID]);
      // brand_id is the same for every row (the brand GUC); each row contributes (order_id, anon, brain_id).
      const params: unknown[] = [brandId];
      const valuesSql = rows
        .map((r, i) => {
          const base = i * 3 + 2; // $1 is brand_id; each row uses 3 placeholders
          params.push(r.orderId, r.stitchedAnonId, r.brainId);
          return `($1, $${base}, $${base + 1}, $${base + 2})`;
        })
        .join(', ');
      await client.query(
        `INSERT INTO connectors.connector_journey_stitch_map (brand_id, order_id, stitched_anon_id, brain_id)
         VALUES ${valuesSql}
         ON CONFLICT (brand_id, order_id) DO UPDATE
           SET stitched_anon_id = EXCLUDED.stitched_anon_id,
               brain_id         = COALESCE(EXCLUDED.brain_id, connector_journey_stitch_map.brain_id)`,
        params,
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err; // caller wraps best-effort
    } finally {
      client.release();
    }
  }
}
