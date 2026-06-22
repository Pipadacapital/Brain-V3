/**
 * synthetic-awb-from-orders.ts — DEV-ONLY brand-tied synthetic AWB generator.
 *
 * The committed static fixture (gokwik-awb-lifecycle.json) carries generic order_ids that match no real
 * brand's orders, so its AWB events never tie to recognized CoD orders → no cod_* ledger, no RTO%-by-
 * pincode, no shipment analytics: the dashboards stay empty + the "Connect GoKwik" CTA never clears.
 *
 * This generator (dev only, gated by GOKWIK_SYNTH_FROM_ORDERS != '0') manufactures AWB lifecycle records
 * for the brand's OWN recent recognized orders so the whole GoKwik analytics chain lights up with
 * internally-consistent data:
 *   gokwik.awb_status.v1 (terminal Delivered/RTO + pincode) → Bronze → silver_shipment + RTO%-by-pincode,
 *   and (via ShipmentLedgerConsumer) cod_delivery_confirmed / cod_rto_clawback on the ledger.
 *
 * DETERMINISTIC (idempotent): status / pincode / status_changed_at are derived from a sha256 of the
 * order_id (never wall-clock), so re-runs produce the SAME (awb, status, status_changed_at) → the same
 * Bronze event_id → no duplicates. data_source stays 'synthetic' downstream (the Synthetic badge holds).
 * Swap for the real partner feed by simply not setting GOKWIK_SYNTH_FROM_ORDERS.
 */
import { Pool } from 'pg';
import { createHash } from 'node:crypto';
import type { GokwikAwbRecord } from '@brain/gokwik-mapper';
import { log } from '../../log.js';

// A spread of real Indian destination pincodes so RTO%-by-pincode has cohorts to rank.
const PINCODES = [
  '110001', '400001', '560001', '600001', '700001', '500001',
  '411001', '302001', '380001', '226001', '141001', '682001',
];
const MAX_ORDERS = 300;

function hash32(s: string): number {
  return parseInt(createHash('sha256').update(s).digest('hex').slice(0, 8), 16);
}

/**
 * Generate synthetic AWB lifecycle records for the brand's recent provisional-recognition orders.
 * Read as brain_app under the brand GUC (RLS). Returns [] on any error (non-fatal — the repull
 * continues with the static fixture).
 */
export async function generateSyntheticAwbFromOrders(
  pool: Pool,
  brandId: string,
): Promise<GokwikAwbRecord[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_brand_id', $1, true)`, [brandId]);
    const res = await client.query<{ order_id: string; occurred_at: Date }>(
      `SELECT order_id, min(occurred_at) AS occurred_at
         FROM realized_revenue_ledger
        WHERE brand_id = $1 AND event_type = 'provisional_recognition'
        GROUP BY order_id
        ORDER BY 2 DESC
        LIMIT ${MAX_ORDERS}`,
      [brandId],
    );
    await client.query('COMMIT');

    const records: GokwikAwbRecord[] = res.rows.map((r) => {
      const h = hash32(r.order_id);
      // ~22% RTO, rest Delivered — both terminal (drive cod_rto_clawback / cod_delivery_confirmed).
      const status = h % 100 < 22 ? 'RTO' : 'Delivered';
      // Terminal transition 1–5 days after recognition — DETERMINISTIC (from occurred_at, not now), so
      // the Bronze event_id is stable across re-pulls. Records dated past `now` are naturally excluded
      // by the repull's [windowStart, now] filter (those orders simply have no terminal AWB yet).
      const changedMs = new Date(r.occurred_at).getTime() + (1 + (h % 5)) * 86_400_000;
      return {
        awb_number: `AWB${(h % 100_000_000).toString().padStart(8, '0')}`,
        order_id: r.order_id,
        status,
        status_changed_at: new Date(changedMs).toISOString(),
        pincode: PINCODES[h % PINCODES.length],
      };
    });

    log.info(`[gokwik-synth] generated ${records.length} brand-tied synthetic AWB records (DEV)`);
    return records;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    log.warn(`[gokwik-synth] order-tied synthetic generation failed (non-fatal): ${String(e)}`);
    return [];
  } finally {
    client.release();
  }
}
