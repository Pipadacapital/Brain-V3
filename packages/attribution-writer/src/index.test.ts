/**
 * index.test.ts — ISOLATION unit tests for AttributionCreditWriter.
 *
 * BRAIN V4 PHASE 6a: the TS WRITE PATH IS RETIRED. The attribution credit ledger is now produced SOLELY
 * by the Spark gold job (db/iceberg/spark/gold/gold_attribution_credit.py). AttributionCreditWriter is
 * kept (read-only) so the reconcile driver, BFF reconcile route and live tests keep their import paths +
 * the deterministic compute keeps running — but appendRows() no longer issues an INSERT.
 *
 * What these tests now lock down (the RETIRED contract):
 *   • The writer issues NO INSERT, EVER (Spark is the sole producer — a second writer would re-create the
 *     dual-writer debt and re-depend on the retiring dbt-internal brain_gold DB).
 *   • The deterministic compute STILL runs: every produced credit/clawback row is reported as `suppressed`
 *     (count == produced rows), `inserted` is always 0, so callers that gate on inserted>0 honestly report
 *     0 newly-credited from the TS path.
 *   • The R-11 cumulative clawback clamp (no over-claw, saved weights never re-apportioned) STILL runs
 *     through the read-backs (which now read the serving MV brain_serving.mv_gold_attribution_credit).
 *
 * NO DB: the StarRocks pool (SilverPool) is mocked; the real metric-engine compute + the real
 * withSilverBrand seam run unmocked. The FakePool ASSERTS no INSERT is ever issued.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { SavedCreditRow } from '@brain/metric-engine';

import { AttributionCreditWriter, type WriteCreditParams, type WriteClawbackParams } from './index.js';

const BRAND_ID = '00000000-0000-0000-0000-000000000001';
const ORDER_ID = 'order-1';
const ANON_ID = 'anon-1';
const INR = 'INR';
const OCCURRED = new Date('2026-06-24T10:00:00.000Z');

/** A touch row as silver_touchpoint projects it (string touch_seq, like the real driver). */
interface FakeTouch {
  touch_seq: string | number;
  channel: string;
  utm_campaign?: string | null;
  utm_medium?: string | null;
  fbclid?: string | null;
  gclid?: string | null;
  ttclid?: string | null;
  stitched_brain_id?: string | null;
}

function touch(seq: number, channel: string, extra: Partial<FakeTouch> = {}): FakeTouch {
  return {
    touch_seq: String(seq),
    channel,
    utm_campaign: null,
    utm_medium: null,
    fbclid: null,
    gclid: null,
    ttclid: null,
    stitched_brain_id: null,
    ...extra,
  };
}

/**
 * A fake SilverPool. `touches` are returned by the silver_touchpoint read (via getConnection); the
 * read-back queries (saved credits / clawed-back total) are served from the serving MV by SQL marker.
 * RETIRED-CONTRACT GUARD: an INSERT is a hard test failure (the write path must stay retired).
 */
class FakePool {
  insertAttempts = 0;
  savedCredits: SavedCreditRow[] = [];
  clawedBackTotalMinor = 0n; // POSITIVE magnitude the writer would read back (SUM is negative in-store)
  private touches: FakeTouch[] = [];

  setTouches(t: FakeTouch[]): void {
    this.touches = t;
  }

  // srPool.query — the serving-MV read-backs ONLY; an INSERT must never happen (retired write path).
  async query(sql: string): Promise<[unknown, unknown]> {
    if (sql.trimStart().toUpperCase().startsWith('INSERT')) {
      this.insertAttempts += 1;
      throw new Error('RETIRED: AttributionCreditWriter must NOT issue an INSERT (Spark is the sole producer)');
    }
    // readSavedCredits — SELECT ... row_kind = 'credit'  (now from brain_serving.mv_gold_attribution_credit)
    if (sql.includes("row_kind = 'credit'")) {
      return [this.savedCredits.map(savedToStoreRow), undefined];
    }
    // readClawedBackTotal — SUM(...) ... row_kind = 'clawback'  (store holds it negative)
    if (sql.includes("row_kind = 'clawback'")) {
      return [[{ total: (-this.clawedBackTotalMinor).toString() }], undefined];
    }
    throw new Error(`FakePool.query: unhandled SQL: ${sql.slice(0, 80)}`);
  }

  // srPool.getConnection — used by withSilverBrand (SET session var + silver_touchpoint read).
  async getConnection(): Promise<{
    query(sql: string, params?: unknown[]): Promise<[unknown, unknown]>;
    release(): void;
  }> {
    const self = this;
    return {
      async query(sql: string): Promise<[unknown, unknown]> {
        if (sql.startsWith('SET ')) return [{}, undefined];
        if (sql.includes('silver_touchpoint')) return [self.touches, undefined];
        throw new Error(`FakeConn.query: unhandled SQL: ${sql.slice(0, 80)}`);
      },
      release() {
        /* no-op */
      },
    };
  }
}

/** Convert a SavedCreditRow into the snake_case store shape readSavedCredits maps back from. */
function savedToStoreRow(s: SavedCreditRow): Record<string, unknown> {
  return {
    credit_id: s.creditId,
    brand_id: s.brandId,
    order_id: s.orderId,
    brain_anon_id: s.brainAnonId,
    touch_seq: s.touchSeq,
    channel: s.channel,
    campaign_id: s.campaignId,
    model_id: s.modelId,
    weight_fraction: s.weightFraction,
    credited_revenue_minor: s.creditedRevenueMinor.toString(),
    currency_code: s.currencyCode,
    realized_revenue_minor: s.realizedRevenueMinor.toString(),
    confidence_grade: s.confidenceGrade,
    attribution_confidence: s.attributionConfidence,
  };
}

const creditParams = (over: Partial<WriteCreditParams> = {}): WriteCreditParams => ({
  brandId: BRAND_ID,
  orderId: ORDER_ID,
  brainAnonId: ANON_ID,
  model: 'last_touch',
  realizedRevenueMinor: 100_00n,
  currencyCode: INR,
  occurredAt: OCCURRED,
  ...over,
});

const clawbackParams = (over: Partial<WriteClawbackParams> = {}): WriteClawbackParams => ({
  brandId: BRAND_ID,
  orderId: ORDER_ID,
  model: 'last_touch',
  reversalReason: 'refund',
  reversalLedgerEventId: 'rev-1',
  reversalBasisMinor: -100_00n,
  occurredAt: OCCURRED,
  ...over,
});

/**
 * Build the SAVED credit rows for a 2-touch (equal-split) journey so the clawback path has a real,
 * weight-sum-valid basis (Σweight == 1.0). The clawback path re-derives clawback from these SAVED
 * weights — never re-apportions.
 */
function savedTwoTouchEqual(total: bigint): SavedCreditRow[] {
  const half = total / 2n;
  const base: Omit<SavedCreditRow, 'creditId' | 'touchSeq' | 'channel' | 'weightFraction' | 'creditedRevenueMinor'> = {
    brandId: BRAND_ID,
    orderId: ORDER_ID,
    brainAnonId: ANON_ID,
    campaignId: null,
    modelId: 'linear',
    currencyCode: INR,
    realizedRevenueMinor: total,
    confidenceGrade: 'partial',
    attributionConfidence: '0.50000000',
  };
  return [
    { ...base, creditId: 'c1', touchSeq: 1, channel: 'paid_meta', weightFraction: '0.50000000', creditedRevenueMinor: half },
    { ...base, creditId: 'c2', touchSeq: 2, channel: 'referral', weightFraction: '0.50000000', creditedRevenueMinor: total - half },
  ];
}

describe('AttributionCreditWriter — writeCredit (RETIRED write path, Phase 6a)', () => {
  let pool: FakePool;
  let writer: AttributionCreditWriter;
  beforeEach(() => {
    pool = new FakePool();
    writer = new AttributionCreditWriter(pool as never);
    pool.setTouches([touch(1, 'paid_meta'), touch(2, 'referral')]);
  });

  it('computes the credit rows but NEVER inserts — produced rows reported as suppressed', async () => {
    const res = await writer.writeCredit(creditParams());
    // 2 touches → 2 produced credit rows; none persisted (Spark is the sole producer).
    expect(res).toEqual({ inserted: 0, suppressed: 2 });
    expect(pool.insertAttempts).toBe(0);
  });

  it('zero touches → no produced rows, no insert (honest unattributed)', async () => {
    pool.setTouches([]);
    const res = await writer.writeCredit(creditParams());
    expect(res).toEqual({ inserted: 0, suppressed: 0 });
    expect(pool.insertAttempts).toBe(0);
  });
});

describe('AttributionCreditWriter — writeClawback R-11 clamp (RETIRED write path)', () => {
  let pool: FakePool;
  let writer: AttributionCreditWriter;
  const TOTAL = 100_00n; // Σ credit
  beforeEach(() => {
    pool = new FakePool();
    writer = new AttributionCreditWriter(pool as never);
    pool.savedCredits = savedTwoTouchEqual(TOTAL);
  });

  it('no saved credits → no clawback (nothing to reverse)', async () => {
    pool.savedCredits = [];
    const res = await writer.writeClawback(clawbackParams());
    expect(res).toEqual({ inserted: 0, suppressed: 0 });
    expect(pool.insertAttempts).toBe(0);
  });

  it('zero remaining (already fully clawed) → clamp to 0, no produced rows', async () => {
    pool.clawedBackTotalMinor = TOTAL; // whole credit already reversed
    const res = await writer.writeClawback(clawbackParams({ reversalBasisMinor: -50_00n }));
    expect(res).toEqual({ inserted: 0, suppressed: pool.savedCredits.length });
    expect(pool.insertAttempts).toBe(0);
  });

  it('exact reversal — clamp runs, 2 clawback rows produced but suppressed (never inserted)', async () => {
    const res = await writer.writeClawback(clawbackParams({ reversalBasisMinor: -TOTAL }));
    // The clamp + saved-weight clawback math runs (2 rows produced); none persisted.
    expect(res).toEqual({ inserted: 0, suppressed: 2 });
    expect(pool.insertAttempts).toBe(0);
  });

  it('exceeding reversal — clamp runs, rows produced but suppressed', async () => {
    const res = await writer.writeClawback(clawbackParams({ reversalBasisMinor: -300_00n }));
    expect(res).toEqual({ inserted: 0, suppressed: 2 });
    expect(pool.insertAttempts).toBe(0);
  });
});

describe('AttributionCreditWriter — writeDataDrivenCredit (RETIRED write path)', () => {
  let pool: FakePool;
  let writer: AttributionCreditWriter;
  beforeEach(() => {
    pool = new FakePool();
    writer = new AttributionCreditWriter(pool as never);
  });

  it('computes Markov-distributed rows but never inserts — produced rows suppressed', async () => {
    pool.setTouches([touch(1, 'paid_meta'), touch(2, 'referral'), touch(3, 'paid_meta')]);
    const channelWeightUnits = new Map<string, bigint>([
      ['paid_meta', 70_000_000n], // 0.70 of WEIGHT_SCALE (1e8)
      ['referral', 30_000_000n], // 0.30
    ]);
    const basis = 100_03n; // deliberately not cleanly divisible (largest-remainder closer must run)
    const res = await writer.writeDataDrivenCredit(creditParams({ realizedRevenueMinor: basis }), channelWeightUnits);
    expect(res).toEqual({ inserted: 0, suppressed: 3 });
    expect(pool.insertAttempts).toBe(0);
  });

  it('zero touches → no produced rows, no insert', async () => {
    pool.setTouches([]);
    const res = await writer.writeDataDrivenCredit(creditParams(), new Map([['paid_meta', 100_000_000n]]));
    expect(res).toEqual({ inserted: 0, suppressed: 0 });
    expect(pool.insertAttempts).toBe(0);
  });
});
