/**
 * credit-writer.ts — the attribution credit-ledger WRITER use-case (Tier-0, append-only).
 *
 * ┌──────────────────────────────────────────────────────────────────────────────────────────────┐
 * │ BRAIN V4 PHASE 6a — TS WRITE PATH RETIRED. Spark is now the SOLE PRODUCER of the attribution    │
 * │ credit ledger. The Spark gold job db/iceberg/spark/gold/gold_attribution_credit.py (+           │
 * │ _attribution_math.py, Phase 2) re-drives this EXACT pipeline (Markov/position/largest-remainder │
 * │ apportionment, deterministic credit_id) and MERGEs into the Iceberg gold ledger                  │
 * │ brain_gold_local.brain_gold.gold_attribution_credit, served to the app via the serving MV        │
 * │ brain_serving.mv_gold_attribution_credit. This TS adapter NO LONGER WRITES: appendRows() is a    │
 * │ neutralized no-op and the read-backs (saved credits / clawed-back total) now read the serving MV │
 * │ — so there are ZERO references to the retiring dbt-internal brain_gold DB here. The class is kept │
 * │ (read-only) so the reconcile driver, BFF reconcile route and live tests keep their import paths.  │
 * └──────────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * Historically (pre-V4) this adapter WROTE credit/clawback to StarRocks brain_gold.gold_attribution_credit
 * (PG billing.attribution_credit_ledger was dropped at the Epic-2 medallion realignment). The deterministic
 * compute (metric-engine is the SOLE math layer — I-E03/E04: exact signed BIGINT minor units, deterministic
 * credit_id, Markov for data_driven) is preserved verbatim in the Spark port; only the I/O sink changed.
 *
 * GAP FLAGGED for the Spark job (db/iceberg/spark/gold/gold_attribution_credit.py): that job ONLY produces
 * the row_kind='credit' fold. The CLAWBACK fold (row_kind='clawback', signed-negative rows that re-use the
 * SAVED weight_fraction on a realized reversal — see computeAttributionClawback below + the R-11 cumulative
 * clamp) is documented there as omitted ("a strict no-op on the current 0-credit ledger … a follow-up once
 * stitched journeys + credit rows exist"). Once credit rows + reversals coexist, the Spark job MUST gain the
 * clawback fold to reach parity with this retired TS path. The clawback math is intact in @brain/metric-engine.
 *
 * Money is signed BIGINT minor units — never float (I-S07). Per-brand isolation: explicit brand_id scoping on
 * every read (StarRocks has no RLS; the metric-engine read seam enforces it for dashboard reads — I-ST01).
 */

import {
  computeAttributionCredit,
  computeAttributionCreditDataDriven,
  computeAttributionClawback,
  clampReversalBasis,
  type AttributionCreditRow,
  type CreditTouch,
  type SavedCreditRow,
  type ReversalReason,
  type AttributionModelId,
  type DataDrivenJourney,
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
  /** Rows inserted (after existing-id suppression). */
  inserted: number;
  /** Rows suppressed as replay duplicates (credit_id already present). */
  suppressed: number;
}

/**
 * READ-back source for the saved credit / clawed-back totals (clawback basis + idempotency).
 * V4 PHASE 6a: the WRITE sink is retired (Spark is the sole producer); the read-backs now read the
 * Phase-3 serving MV brain_serving.mv_gold_attribution_credit (which serves the Spark-written Iceberg
 * gold ledger) — NEVER the retiring dbt-internal brain_gold DB. No `brain_gold.` table refs remain here.
 */
const GOLD_READ_VIEW = 'brain_serving.mv_gold_attribution_credit';

export class AttributionCreditWriter {
  constructor(private readonly srPool: SilverPool) {}

  /**
   * writeCredit — compute + append the credit rows for one order's journey.
   * Idempotent: deterministic credit_id → INSERT-new-only. Returns insert/suppress counts.
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

  /**
   * writeDataDrivenCredit — append the GLOBAL data-driven (Markov) credit rows for one order's
   * journey, given the corpus-trained per-channel weights. Mirrors writeCredit but uses
   * computeAttributionCreditDataDriven (per-touch weights from the channel weights). Idempotent.
   */
  async writeDataDrivenCredit(
    params: Omit<WriteCreditParams, 'model'>,
    channelWeightUnits: Map<string, bigint>,
  ): Promise<WriteResult> {
    const touches = await this.readTouches(params.brandId, params.brainAnonId);
    if (touches.length === 0) return { inserted: 0, suppressed: 0 };
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
    const rows = computeAttributionCreditDataDriven(
      {
        brandId: params.brandId,
        orderId: params.orderId,
        brainAnonId: params.brainAnonId,
        model: 'data_driven',
        stitched,
        realizedRevenueMinor: params.realizedRevenueMinor,
        currencyCode: params.currencyCode,
        touches: creditTouches,
        occurredAt,
        economicEffectiveAt,
        billingPostedPeriod: toBillingPostedPeriod(occurredAt),
      },
      channelWeightUnits,
    );
    return this.appendRows(params.brandId, rows);
  }

  /**
   * readCorpusJourneys — the WHOLE brand journey corpus for training the Markov model: every anon's
   * ordered channel sequence + whether it converted (stitched to an order). Brand-scoped (I-ST01).
   */
  async readCorpusJourneys(brandId: string): Promise<DataDrivenJourney[]> {
    const rows = await withSilverBrand(this.srPool, brandId, async (scope) =>
      scope.runScoped<{ brain_anon_id: string; channel: string; touch_seq: string | number; stitched_order_id: string | null }>(
        `SELECT brain_anon_id, channel, touch_seq, stitched_order_id
           FROM brain_serving.mv_silver_touchpoint
          WHERE ${BRAND_PREDICATE}
          ORDER BY brain_anon_id ASC, touch_seq ASC`,
        [],
      ),
    );
    const byAnon = new Map<string, { channels: string[]; converted: boolean }>();
    for (const r of rows) {
      const j = byAnon.get(r.brain_anon_id) ?? { channels: [], converted: false };
      if (r.channel) j.channels.push(r.channel);
      if (r.stitched_order_id !== null) j.converted = true;
      byAnon.set(r.brain_anon_id, j);
    }
    return [...byAnon.values()];
  }

  /** Read the journey touches for a brain_anon_id via the brand-scoped Silver seam (I-ST01). */
  private async readTouches(brandId: string, brainAnonId: string): Promise<SilverTouchRow[]> {
    return withSilverBrand(this.srPool, brandId, async (scope) => {
      return scope.runScoped<SilverTouchRow>(
        `SELECT touch_seq, channel, utm_campaign, utm_medium,
                fbclid, gclid, ttclid, stitched_brain_id
           FROM brain_serving.mv_silver_touchpoint
          WHERE brain_anon_id = ?
            AND ${BRAND_PREDICATE}
          ORDER BY touch_seq ASC`,
        [brainAnonId],
      );
    });
  }

  /**
   * Read the SAVED credit rows (row_kind='credit') for an order+model back from the lakehouse ledger.
   * Brand-scoped by explicit brand_id; the SAVED weight_fraction is the SOLE clawback basis.
   */
  private async readSavedCredits(
    brandId: string,
    orderId: string,
    model: AttributionModelId,
  ): Promise<SavedCreditRow[]> {
    // Brain V4: srPool is the Trino query PORT — query() returns the row array directly
    // (no mysql2 [rows, fields] tuple to destructure).
    const rows = await this.srPool.query(
      `SELECT credit_id, brand_id, order_id, brain_anon_id, touch_seq, channel,
              campaign_id, model_id, weight_fraction, credited_revenue_minor,
              currency_code, realized_revenue_minor, confidence_grade, attribution_confidence
         FROM ${GOLD_READ_VIEW}
        WHERE brand_id = ? AND order_id = ? AND model_id = ? AND row_kind = 'credit'
        ORDER BY touch_seq ASC`,
      [brandId, orderId, model],
    );
    const out = rows as Array<{
      credit_id: string; brand_id: string; order_id: string; brain_anon_id: string;
      touch_seq: number; channel: string; campaign_id: string | null; model_id: AttributionModelId;
      weight_fraction: string; credited_revenue_minor: string | number; currency_code: string;
      realized_revenue_minor: string | number; confidence_grade: SavedCreditRow['confidenceGrade'];
      attribution_confidence: string;
    }>;
    return out.map((r) => ({
      creditId: r.credit_id,
      brandId: r.brand_id,
      orderId: r.order_id,
      brainAnonId: r.brain_anon_id,
      touchSeq: Number(r.touch_seq),
      channel: r.channel,
      campaignId: r.campaign_id,
      modelId: r.model_id,
      weightFraction: r.weight_fraction,
      creditedRevenueMinor: BigInt(String(r.credited_revenue_minor).split('.')[0] || '0'),
      currencyCode: r.currency_code,
      realizedRevenueMinor: BigInt(String(r.realized_revenue_minor).split('.')[0] || '0'),
      confidenceGrade: r.confidence_grade,
      attributionConfidence: r.attribution_confidence,
    }));
  }

  /**
   * The magnitude of clawback ALREADY applied to an order+model (|Σ credited_revenue_minor| over the
   * clawback rows). Feeds the R-11 cumulative clamp so distinct reversals can't over-claw an order.
   * A replay of the same reversal re-reads its own (already-written) clawback here; the recomputed rows
   * carry the same deterministic id → pre-filter suppresses them, so the replay stays a safe no-op.
   */
  private async readClawedBackTotal(
    brandId: string,
    orderId: string,
    model: AttributionModelId,
  ): Promise<bigint> {
    // Brain V4: srPool is the Trino query PORT — query() returns the row array directly.
    const rows = await this.srPool.query(
      `SELECT COALESCE(SUM(credited_revenue_minor), 0) AS total
         FROM ${GOLD_READ_VIEW}
        WHERE brand_id = ? AND order_id = ? AND model_id = ? AND row_kind = 'clawback'`,
      [brandId, orderId, model],
    );
    const total = (rows as Array<{ total: string | number }>)[0]?.total ?? '0';
    const sum = BigInt(String(total).split('.')[0] || '0'); // signed-negative (clawbacks are negative)
    return sum < 0n ? -sum : sum; // return the positive magnitude
  }

  /**
   * appendRows — RETIRED no-op (Brain V4 Phase 6a). The attribution credit ledger is now produced
   * SOLELY by the Spark gold job (db/iceberg/spark/gold/gold_attribution_credit.py), which MERGEs the
   * SAME deterministic-credit_id rows into the Iceberg gold ledger. This TS adapter NO LONGER writes
   * to brain_gold.gold_attribution_credit — keeping a second writer would re-create the dual-writer
   * debt and re-introduce a dependency on the retiring dbt-internal brain_gold DB.
   *
   * The math above (computeAttributionCredit / Clawback / DataDriven) is intentionally preserved so the
   * reconcile driver, BFF reconcile route and live tests keep exercising it; the produced rows are simply
   * NOT persisted here. Every produced row is reported as `suppressed` (never `inserted`) so callers that
   * gate on inserted>0 (reconcile-attribution.ts) honestly report 0 newly-credited from the TS path.
   */
  private async appendRows(_brandId: string, rows: AttributionCreditRow[]): Promise<WriteResult> {
    return { inserted: 0, suppressed: rows.length };
  }
}
