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

import {
  ATTRIBUTION_MODEL_IDS,
  computeMarkovChannelWeights,
  withSilverBrand,
  BRAND_PREDICATE,
  type AttributionModelId,
  type ReversalReason,
  type SilverPool,
} from '@brain/metric-engine';
import { AttributionCreditWriter } from './credit-writer.js';

/**
 * The order's RECOGNIZED-revenue events — the attribution credit basis. An order is "won" (and so
 * gets attributed to its journey) when its revenue is recognized:
 *   - finalization           — PREPAID, recognized after the return/cancel horizon (GAP-2 job).
 *   - cod_delivery_confirmed  — COD, recognized on terminal delivery (the COD recognition path).
 * These are mutually exclusive per order (GAP-2: finalization excludes COD orders), so an order is
 * credited exactly once. Crediting ONLY 'finalization' (the old behaviour) left ALL COD revenue
 * unattributed — a large gap for COD-heavy (India) brands and a structural parity-oracle shortfall
 * (realized = every non-provisional event, which includes cod_delivery_confirmed). GAP-3 fix.
 */
const RECOGNITION_EVENT_TYPES: readonly string[] = ['finalization', 'cod_delivery_confirmed'];

const REVERSAL_EVENT_TYPES: readonly string[] = [
  'rto_reversal',
  'refund',
  'chargeback',
  'cancellation',
  'concession',
  'cod_rto_clawback', // COD RTO — reverses any credit on a COD order (GAP-3)
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
  /**
   * StarRocks Silver/Gold pool (mysql2) — MEDALLION REALIGNMENT (Epic 2): everything the reconcile
   * driver touches is now in the lakehouse (credit basis = gold_revenue_ledger, credit ledger =
   * gold_attribution_credit, touches = silver_touchpoint). No PostgreSQL.
   */
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

/**
 * BRAIN V4 PHASE 6a: the attribution credit LEDGER is now produced SOLELY by the Spark gold job
 * (db/iceberg/spark/gold/gold_attribution_credit.py). This driver still RESOLVES journeys and DRIVES the
 * (now read-only) AttributionCreditWriter so the deterministic compute + the BFF reconcile route + the
 * live tests keep exercising the exact apportionment math — but the writer no longer persists (Phase 6a),
 * so this is effectively a parity/observability driver, not a producer. Every read below targets the
 * Phase-3 serving MVs (brain_serving.mv_gold_*) — there are NO references to the retiring dbt-internal
 * brain_gold DB here. The credit BASIS (recognized revenue) reads brain_serving.mv_gold_revenue_ledger;
 * the already-credited idempotency filter reads brain_serving.mv_gold_attribution_credit (Spark-served).
 */

/** order_ids already credited for (brand, model) — the idempotency filter (gold credit ledger). */
async function readCreditedOrderIds(
  srPool: SilverPool,
  brandId: string,
  model: AttributionModelId,
): Promise<Set<string>> {
  const rows = await withSilverBrand(srPool, brandId, async (scope) =>
    scope.runScoped<{ order_id: string }>(
      `SELECT DISTINCT order_id
         FROM brain_serving.mv_gold_attribution_credit
        WHERE row_kind = 'credit' AND model_id = ? AND ${BRAND_PREDICATE}`,
      [model],
    ),
  );
  return new Set(rows.map((r) => r.order_id));
}

/** Recognized orders (credit basis) from the lakehouse gold ledger, NOT yet credited under `model`. */
async function readUncreditedRecognized(
  deps: ReconcileDeps,
  brandId: string,
  model: AttributionModelId,
): Promise<FinalizedOrderRow[]> {
  const credited = await readCreditedOrderIds(deps.srPool, brandId, model);
  const inList = RECOGNITION_EVENT_TYPES.map((t) => `'${t}'`).join(',');
  const rows = await withSilverBrand(deps.srPool, brandId, async (scope) =>
    scope.runScoped<FinalizedOrderRow>(
      `SELECT order_id, brain_id, CAST(amount_minor AS CHAR) AS amount_minor, currency_code, occurred_at
         FROM brain_serving.mv_gold_revenue_ledger
        WHERE ${BRAND_PREDICATE} AND event_type IN (${inList})`,
      [],
    ),
  );
  return rows
    .filter((r) => !credited.has(r.order_id))
    .map((r) => ({ ...r, occurred_at: new Date(r.occurred_at) }));
}

/** Reversals from the lakehouse gold ledger that land on orders already credited under `model`. */
async function readReversalsOnCredited(
  deps: ReconcileDeps,
  brandId: string,
  model: AttributionModelId,
): Promise<ReversalRow[]> {
  const credited = await readCreditedOrderIds(deps.srPool, brandId, model);
  if (credited.size === 0) return [];
  const inList = REVERSAL_EVENT_TYPES.map((t) => `'${t}'`).join(',');
  const rows = await withSilverBrand(deps.srPool, brandId, async (scope) =>
    scope.runScoped<ReversalRow>(
      `SELECT order_id, event_type, ledger_event_id, CAST(amount_minor AS CHAR) AS amount_minor, occurred_at
         FROM brain_serving.mv_gold_revenue_ledger
        WHERE ${BRAND_PREDICATE} AND event_type IN (${inList})`,
      [],
    ),
  );
  return rows
    .filter((r) => credited.has(r.order_id))
    .map((r) => ({ ...r, occurred_at: new Date(r.occurred_at) }));
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
         FROM brain_serving.mv_silver_touchpoint
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
 * (first_touch / last_touch / linear / position_based / time_decay) so all per-journey models are
 * written, not just the position_based default. Previously the default-arg meant only 1 model ever got
 * credit rows, so the model selector on the dashboard had no data for its other options. When a SPECIFIC model is
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

/**
 * reconcileDataDrivenAttribution — the GLOBAL data-driven (Markov) pass for a brand.
 *
 * Unlike the per-journey models (reconcileAttribution), the data-driven weights are trained ONCE from
 * the whole journey corpus, then applied per recognized order:
 *   1. read the corpus (silver_touchpoint) → computeMarkovChannelWeights → per-channel weights.
 *   2. CREDIT: each recognized order (finalization ∪ cod_delivery_confirmed) not yet credited under
 *      model_id='data_driven', with a stitched journey → writeDataDrivenCredit (exact closed-sum).
 *   3. CLAWBACK: reversals on data_driven-credited orders → writeClawback (SAVED weights).
 * Idempotent (deterministic credit_id → ON CONFLICT). No journey / no channels → unattributed (honest).
 */
export async function reconcileDataDrivenAttribution(
  brandId: string,
  correlationId: string,
  deps: ReconcileDeps,
): Promise<ReconcileResult> {
  const writer = new AttributionCreditWriter(deps.srPool);
  const model: AttributionModelId = 'data_driven';
  let credited = 0;
  let clawedBack = 0;
  let unattributed = 0;

  // 1. Train the global channel weights from the corpus.
  const corpus = await writer.readCorpusJourneys(brandId);
  const { channelWeightUnits } = computeMarkovChannelWeights(corpus);
  if (channelWeightUnits.size === 0) {
    return { credited: 0, clawed_back: 0, unattributed: 0 }; // no channels → nothing to attribute
  }

  // 2. CREDIT pass — recognized orders not yet credited under data_driven (lakehouse gold basis).
  const finalized = await readUncreditedRecognized(deps, brandId, model);

  for (const order of finalized) {
    if (!order.brain_id) {
      unattributed += 1;
      continue;
    }
    const brainAnonId = await resolveBrainAnonId(deps.srPool, brandId, order.brain_id);
    if (!brainAnonId) {
      unattributed += 1;
      continue;
    }
    const res = await writer.writeDataDrivenCredit(
      {
        brandId,
        orderId: order.order_id,
        brainAnonId,
        realizedRevenueMinor: BigInt(order.amount_minor),
        currencyCode: order.currency_code,
        occurredAt: order.occurred_at,
      },
      channelWeightUnits,
    );
    if (res.inserted > 0) credited += 1;
    else unattributed += 1;
  }

  // 3. CLAWBACK pass — reversals on data_driven-credited orders (SAVED weights; lakehouse basis).
  const reversals = await readReversalsOnCredited(deps, brandId, model);
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

/** Reconcile a single attribution model for a brand (the credit + clawback passes). */
async function reconcileOneModel(
  brandId: string,
  correlationId: string,
  deps: ReconcileDeps,
  model: AttributionModelId,
): Promise<ReconcileResult> {
  const writer = new AttributionCreditWriter(deps.srPool);
  let credited = 0;
  let clawedBack = 0;
  let unattributed = 0;

  // ── CREDIT pass: recognized orders not yet credited (for this model) ─────────
  // Recognized = finalization (prepaid) OR cod_delivery_confirmed (COD) — see RECOGNITION_EVENT_TYPES.
  // Basis is the lakehouse gold ledger (Bronze-sourced), filtered by the PG credited set in TS.
  const finalized = await readUncreditedRecognized(deps, brandId, model);

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

  // ── CLAWBACK pass: reversals on orders that have saved credits (lakehouse gold basis) ──
  const reversals = await readReversalsOnCredited(deps, brandId, model);

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
