/**
 * credit-writer.ts — the attribution credit-ledger WRITER use-case (Tier-0, append-only).
 *
 * The bounded-context write side for attribution_credit_ledger (Postgres Gold, 0032):
 *   • writeCredit(...)  — reads the journey touches (silver.touchpoint via the metric-engine
 *                         Silver seam) + the order's realized-revenue basis, computes the
 *                         per-touch credit rows (the metric engine is the SOLE math layer —
 *                         I-E03/E04), and APPENDS them (deterministic credit_id → ON CONFLICT
 *                         DO NOTHING, idempotent replay).
 *   • writeClawback(...) — on a realized-ledger reversal, reads the SAVED credit rows back from
 *                          the ledger and appends mirrored signed-negative clawback rows using
 *                          the SAVED weight_fraction (never re-apportioned). Deterministic
 *                          reversal id keyed on the source reversal event → idempotent.
 *
 * APPEND-ONLY by GRANT (0032 mirrors 0018): the connection is brain_app (SELECT+INSERT only,
 * no UPDATE/DELETE). Every write is a single txn with the brand GUC set first (RLS). Money is
 * signed BIGINT minor units — never float (I-S07). The compute is deterministic; this file is
 * the I/O adapter (DDD: the domain math lives in @brain/metric-engine).
 *
 * @see 05-architecture.md §1 (ledger) + §2 (models) + §3 (clawback)
 * @see apps/core/src/modules/measurement/internal/infrastructure/repositories/PgLedgerRepository.ts (the pattern)
 */

import { Pool, type PoolClient } from 'pg';
import {
  computeAttributionCredit,
  computeAttributionClawback,
  clampReversalBasis,
  type AttributionCreditRow,
  type CreditTouch,
  type SavedCreditRow,
  type ReversalReason,
  type AttributionModelId,
  type SilverPool,
} from '@brain/metric-engine';
import { withSilverBrand, BRAND_PREDICATE } from '@brain/metric-engine';

/** 'YYYY-MM' billing period from an event-time Date (UTC), mirrors 0018's dual-date rule. */
function toBillingPostedPeriod(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/** The Silver touch projection used by the writer (a subset of silver.touchpoint). */
interface SilverTouchRow {
  touch_seq: string | number;
  channel: string;
  utm_campaign: string | null;
  utm_medium: string | null;
  fbclid: string | null;
  gclid: string | null;
  ttclid: string | null;
  stitched_brain_id: string | null;
}

export interface WriteCreditParams {
  brandId: string;
  orderId: string;
  /** The journey key (brain_anon_id) stitched to this order. */
  brainAnonId: string;
  model: AttributionModelId;
  /** The order's realized revenue basis (signed BIGINT minor units). */
  realizedRevenueMinor: bigint;
  currencyCode: string;
  /** Conversion/credit event-time + economic-effective time. */
  occurredAt: Date;
  economicEffectiveAt?: Date;
}

export interface WriteClawbackParams {
  brandId: string;
  orderId: string;
  model: AttributionModelId;
  reversalReason: ReversalReason;
  /** The source reversal's deterministic ledger_event_id (idempotency key). */
  reversalLedgerEventId: string;
  /** The (negative) reversal basis in signed minor units. */
  reversalBasisMinor: bigint;
  occurredAt: Date;
  economicEffectiveAt?: Date;
}

export interface WriteResult {
  /** Rows inserted (after ON CONFLICT DO NOTHING suppression). */
  inserted: number;
  /** Rows suppressed as replay duplicates. */
  suppressed: number;
}

export class AttributionCreditWriter {
  constructor(
    private readonly pool: Pool,
    private readonly srPool: SilverPool,
  ) {}

  /**
   * writeCredit — compute + append the credit rows for one order's journey.
   * Idempotent: deterministic credit_id → ON CONFLICT DO NOTHING. Returns insert/suppress counts.
   * No journey (zero touches) → no rows (the order's realized revenue is unattributed — honest).
   */
  async writeCredit(params: WriteCreditParams): Promise<WriteResult> {
    const touches = await this.readTouches(params.brandId, params.brainAnonId);
    const stitched = touches.some((t) => t.stitched_brain_id !== null);

    const creditTouches: CreditTouch[] = touches.map((t) => ({
      touchSeq: Number(t.touch_seq),
      channel: t.channel,
      campaignId: t.utm_campaign,
      utmMedium: t.utm_medium,
      fbclid: t.fbclid,
      gclid: t.gclid,
      ttclid: t.ttclid,
    }));

    const occurredAt = params.occurredAt;
    const economicEffectiveAt = params.economicEffectiveAt ?? occurredAt;
    const rows = computeAttributionCredit({
      brandId: params.brandId,
      orderId: params.orderId,
      brainAnonId: params.brainAnonId,
      model: params.model,
      stitched,
      realizedRevenueMinor: params.realizedRevenueMinor,
      currencyCode: params.currencyCode,
      touches: creditTouches,
      occurredAt,
      economicEffectiveAt,
      billingPostedPeriod: toBillingPostedPeriod(occurredAt),
    });

    return this.appendRows(params.brandId, rows);
  }

  /**
   * writeClawback — read the SAVED credit rows for the order+model and append mirrored
   * signed-negative clawback rows (SAVED weights, deterministic reversal id, idempotent).
   * No saved credits (unattributed order) → no clawback (nothing to reverse).
   */
  async writeClawback(params: WriteClawbackParams): Promise<WriteResult> {
    const saved = await this.readSavedCredits(params.brandId, params.orderId, params.model);
    if (saved.length === 0) return { inserted: 0, suppressed: 0 };

    // R-11 cumulative clamp: |Σ clawback| for an order can NEVER exceed Σ credit (a duplicate or
    // over-sized reversal must not drive net attributed revenue negative). Clamp the reversal basis to
    // the credit still un-reversed; re-using the SAVED weights keeps every per-touch clawback ≤ its credit.
    const creditTotal = saved.reduce((acc, s) => acc + s.creditedRevenueMinor, 0n);
    const alreadyClawed = await this.readClawedBackTotal(params.brandId, params.orderId, params.model);
    const clampedBasisMinor = clampReversalBasis(params.reversalBasisMinor, creditTotal, alreadyClawed);
    if (clampedBasisMinor === 0n) return { inserted: 0, suppressed: saved.length }; // nothing left to reverse

    const occurredAt = params.occurredAt;
    const economicEffectiveAt = params.economicEffectiveAt ?? occurredAt;
    const rows = computeAttributionClawback({
      savedCredits: saved,
      reversalLedgerEventId: params.reversalLedgerEventId,
      reversalReason: params.reversalReason,
      reversalBasisMinor: clampedBasisMinor,
      occurredAt,
      economicEffectiveAt,
      billingPostedPeriod: toBillingPostedPeriod(occurredAt),
    });

    return this.appendRows(params.brandId, rows);
  }

  /** Read the journey touches for a brain_anon_id via the brand-scoped Silver seam (I-ST01). */
  private async readTouches(brandId: string, brainAnonId: string): Promise<SilverTouchRow[]> {
    return withSilverBrand(this.srPool, brandId, async (scope) => {
      return scope.runScoped<SilverTouchRow>(
        `SELECT touch_seq, channel, utm_campaign, utm_medium,
                fbclid, gclid, ttclid, stitched_brain_id
           FROM brain_silver.silver_touchpoint
          WHERE brain_anon_id = ?
            AND ${BRAND_PREDICATE}
          ORDER BY touch_seq ASC`,
        [brainAnonId],
      );
    });
  }

  /**
   * Read the SAVED credit rows (row_kind='credit') for an order+model back from the ledger.
   * Brand-scoped via the GUC (RLS); the SAVED weight_fraction is the SOLE clawback basis.
   */
  private async readSavedCredits(
    brandId: string,
    orderId: string,
    model: AttributionModelId,
  ): Promise<SavedCreditRow[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_brand_id', $1, true)", [brandId]);
      const res = await client.query<{
        credit_id: string;
        brand_id: string;
        order_id: string;
        brain_anon_id: string;
        touch_seq: number;
        channel: string;
        campaign_id: string | null;
        model_id: AttributionModelId;
        weight_fraction: string;
        credited_revenue_minor: string;
        currency_code: string;
        realized_revenue_minor: string;
        confidence_grade: SavedCreditRow['confidenceGrade'];
        attribution_confidence: string;
      }>(
        `SELECT credit_id, brand_id, order_id, brain_anon_id, touch_seq, channel,
                campaign_id, model_id, weight_fraction, credited_revenue_minor,
                currency_code, realized_revenue_minor, confidence_grade, attribution_confidence
           FROM attribution_credit_ledger
          WHERE brand_id = $1 AND order_id = $2 AND model_id = $3 AND row_kind = 'credit'
          ORDER BY touch_seq ASC`,
        [brandId, orderId, model],
      );
      await client.query('COMMIT');
      return res.rows.map((r) => ({
        creditId: r.credit_id,
        brandId: r.brand_id,
        orderId: r.order_id,
        brainAnonId: r.brain_anon_id,
        touchSeq: Number(r.touch_seq),
        channel: r.channel,
        campaignId: r.campaign_id,
        modelId: r.model_id,
        weightFraction: r.weight_fraction,
        creditedRevenueMinor: BigInt(r.credited_revenue_minor),
        currencyCode: r.currency_code,
        realizedRevenueMinor: BigInt(r.realized_revenue_minor),
        confidenceGrade: r.confidence_grade,
        attributionConfidence: r.attribution_confidence,
      }));
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * The magnitude of clawback ALREADY applied to an order+model (|Σ credited_revenue_minor| over the
   * clawback rows). Feeds the R-11 cumulative clamp so distinct reversals can't over-claw an order.
   * A replay of the same reversal re-reads its own (already-written) clawback here, but the recomputed
   * rows carry the same deterministic id → ON CONFLICT DO NOTHING, so the replay stays a safe no-op.
   * Brand-scoped via the GUC (RLS) under brain_app.
   */
  private async readClawedBackTotal(
    brandId: string,
    orderId: string,
    model: AttributionModelId,
  ): Promise<bigint> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_brand_id', $1, true)", [brandId]);
      const res = await client.query<{ total: string }>(
        `SELECT COALESCE(SUM(credited_revenue_minor), 0)::text AS total
           FROM attribution_credit_ledger
          WHERE brand_id = $1 AND order_id = $2 AND model_id = $3 AND row_kind = 'clawback'`,
        [brandId, orderId, model],
      );
      await client.query('COMMIT');
      const sum = BigInt(res.rows[0]?.total ?? '0'); // signed-negative (clawbacks are negative)
      return sum < 0n ? -sum : sum; // return the positive magnitude
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Append rows to attribution_credit_ledger. Single txn, GUC-first, ON CONFLICT
   * (the dedup UNIQUE) DO NOTHING → idempotent. Returns insert/suppress counts.
   */
  private async appendRows(brandId: string, rows: AttributionCreditRow[]): Promise<WriteResult> {
    if (rows.length === 0) return { inserted: 0, suppressed: 0 };
    const client: PoolClient = await this.pool.connect();
    let inserted = 0;
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_brand_id', $1, true)", [brandId]);
      for (const r of rows) {
        const res = await client.query(
          `INSERT INTO attribution_credit_ledger (
             brand_id, credit_id, order_id, brain_anon_id, touch_seq, channel, campaign_id,
             model_id, row_kind, weight_fraction, credited_revenue_minor, currency_code,
             reversed_of_credit_id, reversal_reason, realized_revenue_minor,
             confidence_grade, attribution_confidence, model_version, metric_snapshot_id,
             occurred_at, economic_effective_at, billing_posted_period
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7,
             $8, $9, $10::numeric, $11::bigint, $12,
             $13, $14, $15::bigint,
             $16, $17::numeric, $18, $19,
             $20, $21, $22
           )
           ON CONFLICT (brand_id, credit_id)
           DO NOTHING`,
          [
            r.brandId, r.creditId, r.orderId, r.brainAnonId, r.touchSeq, r.channel, r.campaignId,
            r.modelId, r.rowKind, r.weightFraction, r.creditedRevenueMinor.toString(), r.currencyCode,
            r.reversedOfCreditId, r.reversalReason, r.realizedRevenueMinor.toString(),
            r.confidenceGrade, r.attributionConfidence, r.modelVersion, r.metricSnapshotId,
            r.occurredAt.toISOString(), r.economicEffectiveAt.toISOString(), r.billingPostedPeriod,
          ],
        );
        inserted += res.rowCount ?? 0;
      }
      await client.query('COMMIT');
      return { inserted, suppressed: rows.length - inserted };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}

/**
 * createAttributionReversalHook — adapt the writer to the measurement OrderEventConsumer
 * reversal fan-out. On a revenue reversal, fan out a clawback across ALL models that have
 * saved credit rows for the order (the writer's readSavedCredits is per-model, so we run the
 * default model set; idempotent ON CONFLICT means re-running a model with no saved rows is a
 * no-op). Returns the hook the composition root injects into OrderEventConsumer.
 *
 * @param pool   - The pg.Pool (brain_app).
 * @param srPool - The StarRocks Silver pool (mysql2; unused on the clawback path but the writer
 *                 is constructed once for both credit + clawback).
 */
export function createAttributionReversalHook(
  pool: Pool,
  srPool: SilverPool,
): {
  onRevenueReversal(reversal: {
    brandId: string;
    orderId: string;
    reversalReason: ReversalReason;
    reversalLedgerEventId: string;
    reversalBasisMinor: bigint;
    occurredAt: Date;
  }): Promise<void>;
} {
  const writer = new AttributionCreditWriter(pool, srPool);
  // The default model set — clawback fans out per model that has saved credit rows.
  const models: AttributionModelId[] = ['first_touch', 'last_touch', 'linear', 'position_based'];
  return {
    async onRevenueReversal(reversal): Promise<void> {
      for (const model of models) {
        await writer.writeClawback({
          brandId: reversal.brandId,
          orderId: reversal.orderId,
          model,
          reversalReason: reversal.reversalReason,
          reversalLedgerEventId: reversal.reversalLedgerEventId,
          reversalBasisMinor: reversal.reversalBasisMinor,
          occurredAt: reversal.occurredAt,
        });
      }
    },
  };
}
