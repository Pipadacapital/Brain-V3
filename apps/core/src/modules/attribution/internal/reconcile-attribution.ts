/**
 * reconcile-attribution.ts — the attribution WRITE pipeline driver (Phase 5, dead→live).
 *
 * The AttributionCreditWriter is the I/O adapter; THIS is the use-case that drives it over the
 * realized-revenue ledger, idempotently, so attribution_credit_ledger actually gets populated:
 *
 *   CREDIT pass   — for each FINALIZED order with no credit rows yet, resolve the order's journey
 *                   key (brain_anon_id, via silver_touchpoint.stitched_brain_id) and writeCredit:
 *                   the order's realized revenue is apportioned across its touches (or left
 *                   unattributed when there's no journey — honest).
 *   CLAWBACK pass — for each REVERSAL (rto/refund/chargeback/cancellation/concession) on an order
 *                   that has saved credits, writeClawback: mirror signed-negative rows using the
 *                   SAVED weights. Idempotent (deterministic ids → ON CONFLICT DO NOTHING), so a
 *                   re-run after no new ledger activity writes nothing.
 *
 * Runs in the attribution bounded context (core) — where the writer lives — over the Postgres Gold
 * ledger + the StarRocks Silver touch tier (the metric-engine is the SOLE Silver reader). Designed
 * to be invoked periodically (an Argo job) or on demand; brand_id is the session brand (BFF), never
 * the request. NOT auto-triggered by the finalization job (a different deployable) — kept here so the
 * write stays in its own context.
 */

import type { Pool, QueryResultRow } from 'pg';
import {
  ATTRIBUTION_MODEL_IDS,
  withSilverBrand,
  BRAND_PREDICATE,
  type AttributionModelId,
  type ReversalReason,
  type SilverPool,
} from '@brain/metric-engine';
import { AttributionCreditWriter } from './credit-writer.js';

const REVERSAL_EVENT_TYPES: readonly string[] = [
  'rto_reversal',
  'refund',
  'chargeback',
  'cancellation',
  'concession',
];

export interface ReconcileResult {
  /** orders newly credited this run. */
  credited: number;
  /** orders newly clawed back this run. */
  clawed_back: number;
  /** finalized orders with no resolvable journey (left unattributed — honest). */
  unattributed: number;
}

export interface ReconcileDeps {
  /** Raw pg pool as brain_app (the writer + ledger reads use it; GUC-scoped per txn). */
  pool: Pool;
  /** StarRocks Silver pool (mysql2) — the touch source for credit apportionment. */
  srPool: SilverPool;
}

interface FinalizedOrderRow {
  order_id: string;
  brain_id: string | null;
  amount_minor: string;
  currency_code: string;
  occurred_at: Date;
}

interface ReversalRow {
  order_id: string;
  event_type: string;
  ledger_event_id: string;
  amount_minor: string;
  occurred_at: Date;
}

/** Resolve the journey key (brain_anon_id) stitched to an order's brain_id, via Silver. */
async function resolveBrainAnonId(
  srPool: SilverPool,
  brandId: string,
  brainId: string,
): Promise<string | null> {
  const rows = await withSilverBrand(srPool, brandId, async (scope) =>
    scope.runScoped<{ brain_anon_id: string }>(
      `SELECT brain_anon_id
         FROM brain_silver.silver_touchpoint
        WHERE stitched_brain_id = ?
          AND ${BRAND_PREDICATE}
        ORDER BY touch_seq ASC
        LIMIT 1`,
      [brainId],
    ),
  );
  return rows[0]?.brain_anon_id ?? null;
}

/**
 * reconcileAttribution — drive the credit/clawback write pipeline for a brand.
 *
 * H8 FIX: when `model` is omitted (the production callers — the Argo job + the BFF reconcile
 * route — all omit it), the credit pass loops over EVERY registered model in ATTRIBUTION_MODEL_IDS
 * (first_touch / last_touch / linear / position_based) so all four models are written, not just the
 * position_based default. Previously the default-arg meant only 1 of 4 models ever got credit rows,
 * so the model selector on the dashboard had no data for 3 of its 4 options. When a SPECIFIC model is
 * passed, only that model is reconciled (the single-model path the live tests exercise).
 *
 * The per-model counts are SUMMED across models (an order credited under N models counts N times in
 * `credited`); idempotent per (brand, model) via deterministic credit_ids + ON CONFLICT.
 */
export async function reconcileAttribution(
  brandId: string,
  correlationId: string,
  deps: ReconcileDeps,
  model?: AttributionModelId,
): Promise<ReconcileResult> {
  const models: readonly AttributionModelId[] = model ? [model] : ATTRIBUTION_MODEL_IDS;
  const total: ReconcileResult = { credited: 0, clawed_back: 0, unattributed: 0 };
  for (const m of models) {
    const r = await reconcileOneModel(brandId, correlationId, deps, m);
    total.credited += r.credited;
    total.clawed_back += r.clawed_back;
    total.unattributed += r.unattributed;
  }
  return total;
}

/** Reconcile a single attribution model for a brand (the credit + clawback passes). */
async function reconcileOneModel(
  brandId: string,
  correlationId: string,
  deps: ReconcileDeps,
  model: AttributionModelId,
): Promise<ReconcileResult> {
  const writer = new AttributionCreditWriter(deps.pool, deps.srPool);
  let credited = 0;
  let clawedBack = 0;
  let unattributed = 0;

  // ── CREDIT pass: finalized orders not yet credited (for this model) ─────────
  const finalized = await readScoped<FinalizedOrderRow>(
    deps.pool,
    brandId,
    correlationId,
    `SELECT f.order_id, f.brain_id, f.amount_minor::text AS amount_minor, f.currency_code, f.occurred_at
       FROM realized_revenue_ledger f
      WHERE f.brand_id = $1 AND f.event_type = 'finalization'
        AND NOT EXISTS (
          SELECT 1 FROM attribution_credit_ledger a
           WHERE a.brand_id = $1 AND a.order_id = f.order_id
             AND a.row_kind = 'credit' AND a.model_id = $2
        )`,
    [brandId, model],
  );

  for (const order of finalized) {
    if (!order.brain_id) {
      unattributed += 1;
      continue;
    }
    const brainAnonId = await resolveBrainAnonId(deps.srPool, brandId, order.brain_id);
    if (!brainAnonId) {
      unattributed += 1; // no journey stitched → realized revenue is unattributed (honest)
      continue;
    }
    const res = await writer.writeCredit({
      brandId,
      orderId: order.order_id,
      brainAnonId,
      model,
      realizedRevenueMinor: BigInt(order.amount_minor),
      currencyCode: order.currency_code,
      occurredAt: order.occurred_at,
    });
    if (res.inserted > 0) credited += 1;
    else unattributed += 1; // zero touches → no credit rows written
  }

  // ── CLAWBACK pass: reversals on orders that have saved credits ───────────────
  const reversals = await readScoped<ReversalRow>(
    deps.pool,
    brandId,
    correlationId,
    `SELECT r.order_id, r.event_type, r.ledger_event_id, r.amount_minor::text AS amount_minor, r.occurred_at
       FROM realized_revenue_ledger r
      WHERE r.brand_id = $1 AND r.event_type = ANY($2::text[])
        AND EXISTS (
          SELECT 1 FROM attribution_credit_ledger a
           WHERE a.brand_id = $1 AND a.order_id = r.order_id
             AND a.row_kind = 'credit' AND a.model_id = $3
        )`,
    [brandId, REVERSAL_EVENT_TYPES, model],
  );

  for (const rev of reversals) {
    const res = await writer.writeClawback({
      brandId,
      orderId: rev.order_id,
      model,
      reversalReason: rev.event_type as ReversalReason,
      reversalLedgerEventId: rev.ledger_event_id,
      reversalBasisMinor: BigInt(rev.amount_minor),
      occurredAt: rev.occurred_at,
    });
    if (res.inserted > 0) clawedBack += 1;
  }

  return { credited, clawed_back: clawedBack, unattributed };
}

/** Run a brand-scoped SELECT under brain_app with the brand GUC set (RLS), as a single txn. */
async function readScoped<T extends QueryResultRow>(
  pool: Pool,
  brandId: string,
  _correlationId: string,
  sql: string,
  params: unknown[],
): Promise<T[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_brand_id', $1, true)", [brandId]);
    const res = await client.query<T>(sql, params);
    await client.query('COMMIT');
    return res.rows;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
