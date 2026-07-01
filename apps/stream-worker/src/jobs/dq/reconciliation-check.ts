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
import { incrementCounter } from '@brain/observability';
import { gradeReconciliation } from './grade.js';
import type { DqCheckRow } from './writer.js';
import { BRAND_PREDICATE, BRONZE_COLLECTOR_PREDICATE, ICEBERG_BRONZE, type SilverReader } from './silver-reader.js';
import { log } from "../../log.js";

/** Frozen reconciliation tolerance: max tolerated |bronze - silver| order-count delta. */
export const MAX_ROW_DELTA = 100;

export async function reconciliationCheck(
  _pool: Pool,
  silver: SilverReader | null,
  brandId: string,
): Promise<DqCheckRow[]> {
  // DB-AUDIT C4: both tiers now read StarRocks — Bronze from the Iceberg SoR (collector_events),
  // Silver from brain_silver. No StarRocks → cannot measure either side → honest D.
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

  // ── Bronze order count (Iceberg Bronze via StarRocks, brand-scoped at the seam) ──
  // order_id lives at payload.properties.order_id on order.* events (COALESCE the top-level form
  // for legacy/synthetic payloads). collector_events.payload is a JSON string → get_json_string.
  let bronzeOrders = 0;
  try {
    const br = await silver.scopedQuery<{ n: string | number }>(
      brandId,
      // Trino dialect: json_extract_scalar (NOT StarRocks get_json_string, which Trino has no function
      // for → it threw and silently became bronze_unreachable/D in the reconciliation check).
      `SELECT COUNT(DISTINCT COALESCE(json_extract_scalar(payload, '$.properties.order_id'), json_extract_scalar(payload, '$.order_id'))) AS n
         FROM ${ICEBERG_BRONZE}
        WHERE ${BRONZE_COLLECTOR_PREDICATE} AND ${BRAND_PREDICATE}
          AND event_type LIKE 'order.%'`,
    );
    bronzeOrders = Number(br[0]?.n ?? 0);
  } catch (err) {
    log.error(`iceberg bronze reconciliation read failed brand=${brandId}`, { err: err });
    incrementCounter('dq_silver_lag_breach_total', { reason: 'bronze_unreachable' });
    return [
      {
        brandId,
        category: 'reconciliation',
        target: 'bronze_vs_silver.order_state',
        grade: 'D',
        score: null,
        observed: 'bronze_unreachable',
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
         FROM brain_serving.mv_silver_order_state
        WHERE ${BRONZE_COLLECTOR_PREDICATE} AND ${BRAND_PREDICATE}`,
    );
    silverOrders = Number(sr[0]?.n ?? 0);
  } catch (err) {
    log.error(`silver read failed brand=${brandId}`, { err: err });
    // Silver unreachable = maximal lag. Continuous Silver-lag signal (the DQ loop runs in the
    // deployed worker every interval, so this fires even though dbt itself is batch/nightly).
    incrementCounter('dq_silver_lag_breach_total', { reason: 'unreachable' });
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
  // Silver lagging Bronze beyond tolerance (the common cause: dbt hasn't rebuilt Silver recently).
  // Emit only on genuine lag (silver < bronze); a transient silver>bronze is not a staleness signal.
  if (!outcome.passing && silverOrders < bronzeOrders) {
    incrementCounter('dq_silver_lag_breach_total', { reason: 'delta' });
  }
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
