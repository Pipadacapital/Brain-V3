/**
 * dq/reconciliation-check.ts — Bronze ↔ StarRocks (Silver) aggregate delta.
 *
 * Silver tier (Phase-4 / silver_order_state) is the canonical projection of Bronze
 * order events. This check measures the aggregate row-count delta between the two
 * tiers per brand and grades |delta| vs a max_row_delta tolerance:
 *
 *   bronze_orders = COUNT(DISTINCT order_id) on bronze_events where the event is an
 *                   order event (event_type LIKE 'order.%'), brand-scoped under GUC.
 *   silver_orders = COUNT(DISTINCT order_id) on brain_silver.silver_order_state,
 *                   brand-scoped at the withSilver seam.
 *   delta         = |bronze_orders - silver_orders|.
 *
 * A perfect match (delta=0) → A+. Within tolerance → graded by the fraction
 * delta/max_row_delta. Beyond tolerance → D (the Silver projection is missing/extra
 * orders → the metric built on Silver is untrusted).
 *
 * Both sides empty → A+ (vacuously reconciled). Silver unreachable → honest D.
 */

import type { Pool } from 'pg';
import { gradeReconciliation } from './grade.js';
import type { DqCheckRow } from './writer.js';
import { BRAND_PREDICATE, type SilverReader } from './silver-reader.js';

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** Frozen reconciliation tolerance: max tolerated |bronze - silver| order-count delta. */
export const MAX_ROW_DELTA = 100;

export async function reconciliationCheck(
  pool: Pool,
  silver: SilverReader | null,
  brandId: string,
): Promise<DqCheckRow[]> {
  // ── Bronze order count (Postgres, brand-scoped under GUC) ──────────────────
  let bronzeOrders = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.current_brand_id', $1, true),
              set_config('app.current_user_id', $2, true),
              set_config('app.current_workspace_id', $2, true)`,
      [brandId, NIL_UUID],
    );
    // order_id lives at payload->'properties'->>'order_id' on order.* collector events
    // (Shopify order envelope). COALESCE the top-level form for legacy/synthetic payloads.
    const r = await client.query<{ n: string }>(
      `SELECT COUNT(DISTINCT COALESCE(payload->'properties'->>'order_id', payload->>'order_id'))::text AS n
         FROM bronze_events
        WHERE brand_id = $1
          AND event_type LIKE 'order.%'
          AND COALESCE(payload->'properties'->>'order_id', payload->>'order_id') IS NOT NULL`,
      [brandId],
    );
    bronzeOrders = Number(r.rows[0]?.n ?? '0');
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  if (silver === null) {
    return [
      {
        brandId,
        category: 'reconciliation',
        target: 'bronze_vs_silver.order_state',
        grade: 'D',
        score: null,
        observed: 'silver_disabled',
        threshold: String(MAX_ROW_DELTA),
        passing: false,
      },
    ];
  }

  // ── Silver order count (StarRocks, brand-scoped at the seam) ───────────────
  let silverOrders: number | null = null;
  try {
    const sr = await silver.scopedQuery<{ n: string | number }>(
      brandId,
      `SELECT COUNT(DISTINCT order_id) AS n
         FROM brain_silver.silver_order_state
        WHERE ${BRAND_PREDICATE}`,
    );
    silverOrders = Number(sr[0]?.n ?? 0);
  } catch (err) {
    console.error(`[dq:reconciliation] silver read failed brand=${brandId}`, err);
    return [
      {
        brandId,
        category: 'reconciliation',
        target: 'bronze_vs_silver.order_state',
        grade: 'D',
        score: null,
        observed: 'unreachable',
        threshold: String(MAX_ROW_DELTA),
        passing: false,
      },
    ];
  }

  const delta = Math.abs(bronzeOrders - silverOrders);
  const outcome = gradeReconciliation(delta, MAX_ROW_DELTA);
  return [
    {
      brandId,
      category: 'reconciliation',
      target: 'bronze_vs_silver.order_state',
      grade: outcome.grade,
      score: outcome.score,
      observed: `${delta} (bronze=${bronzeOrders},silver=${silverOrders})`,
      threshold: String(MAX_ROW_DELTA),
      passing: outcome.passing,
    },
  ];
}
