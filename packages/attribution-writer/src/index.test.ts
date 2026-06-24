/**
 * index.test.ts — ISOLATION unit tests for AttributionCreditWriter (the SOLE writer of
 * brain_gold.gold_attribution_credit). NO DB: the StarRocks pool (SilverPool) is mocked and the
 * real metric-engine compute + the real withSilverBrand seam run unmocked, so these tests exercise
 * the writer's true SQL/IO behavior end-to-end against a fake pool.
 *
 * The pool is faked at two surfaces the writer uses:
 *   • srPool.query(sql, params)            — the gold-table reads (saved credits, clawed-back total,
 *                                            existing-id pre-filter) + the batched INSERT.
 *   • srPool.getConnection() → conn.query  — used by withSilverBrand (SET session var + the
 *                                            silver_touchpoint touch read).
 * A FakePool routes each call by a SQL substring to caller-supplied handlers and CAPTURES every
 * INSERT so the assertions inspect exactly what was written (rows + per-touch money).
 *
 * Cases:
 *   (a) writeCredit idempotency — a re-write whose credit_ids are already present writes NOTHING.
 *   (b) writeClawback R-11 cumulative clamp — zero / exact / exceeding / multiple-partial reversals
 *       never let Σ|clawback| exceed Σcredit (and never re-apportion the saved weights).
 *   (c) writeDataDrivenCredit — Markov weights distribute to EXACT integer minor units summing to the
 *       basis (no float drift), money stays signed BIGINT.
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

/** A captured INSERT — the flat params the writer pushed, regrouped per row (22 cols + NOW() literal). */
interface CapturedInsert {
  rowCount: number;
  /** credited_revenue_minor (col 11, 0-based index 10) per row, as the writer serialized it (string). */
  creditedMinor: string[];
  /** row_kind (col 9, index 8) per row. */
  rowKinds: string[];
  /** weight_fraction (col 10, index 9) per row. */
  weightFractions: string[];
}

/**
 * A fake SilverPool. `touches` are returned by the silver_touchpoint read (via getConnection); the
 * gold-table reads are served by handlers keyed on a SQL marker. Every INSERT is captured.
 */
class FakePool {
  inserts: CapturedInsert[] = [];
  /** credit_ids the gold table already holds (drives the existing-id pre-filter + saved-credit read). */
  existingCreditIds = new Set<string>();
  savedCredits: SavedCreditRow[] = [];
  clawedBackTotalMinor = 0n; // POSITIVE magnitude the writer would read back (SUM is negative in-store)
  private touches: FakeTouch[] = [];

  setTouches(t: FakeTouch[]): void {
    this.touches = t;
  }

  /** The 22 INSERT cols, 0-based: 8=row_kind, 9=weight_fraction, 10=credited_revenue_minor. */
  private capture(params: unknown[]): void {
    const COLS = 22;
    const rowCount = params.length / COLS;
    const creditedMinor: string[] = [];
    const rowKinds: string[] = [];
    const weightFractions: string[] = [];
    for (let r = 0; r < rowCount; r++) {
      const base = r * COLS;
      rowKinds.push(String(params[base + 8]));
      weightFractions.push(String(params[base + 9]));
      creditedMinor.push(String(params[base + 10]));
    }
    this.inserts.push({ rowCount, creditedMinor, rowKinds, weightFractions });
  }

  // srPool.query — the gold-table reads + the batched INSERT.
  async query(sql: string, params: unknown[] = []): Promise<[unknown, unknown]> {
    if (sql.startsWith('INSERT INTO')) {
      this.capture(params);
      return [{}, undefined];
    }
    // readSavedCredits — SELECT ... row_kind = 'credit'
    if (sql.includes("row_kind = 'credit'")) {
      return [this.savedCredits.map(savedToStoreRow), undefined];
    }
    // readClawedBackTotal — SUM(...) ... row_kind = 'clawback'  (store holds it negative)
    if (sql.includes("row_kind = 'clawback'")) {
      return [[{ total: (-this.clawedBackTotalMinor).toString() }], undefined];
    }
    // appendRows existing-id pre-filter — SELECT credit_id ... credit_id IN (...)
    if (sql.includes('credit_id IN (')) {
      const present = [...this.existingCreditIds].map((id) => ({ credit_id: id }));
      return [present, undefined];
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
 * weight-sum-valid basis (Σweight == 1.0). For last_touch on 2 touches, last touch gets 100%; use a
 * 2-touch linear-style equal split here by writing the weights explicitly (the writer's clawback path
 * re-derives clawback from these SAVED weights — never re-apportions).
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

describe('AttributionCreditWriter — writeCredit idempotency', () => {
  let pool: FakePool;
  let writer: AttributionCreditWriter;
  beforeEach(() => {
    pool = new FakePool();
    writer = new AttributionCreditWriter(pool as never);
    pool.setTouches([touch(1, 'paid_meta'), touch(2, 'referral')]);
  });

  it('(a) writes the credit rows on first write', async () => {
    const res = await writer.writeCredit(creditParams());
    expect(res).toEqual({ inserted: 2, suppressed: 0 });
    expect(pool.inserts).toHaveLength(1);
    expect(pool.inserts[0]!.rowKinds).toEqual(['credit', 'credit']);
    // exact closed-sum: Σ credited == realized basis (no float drift).
    const sum = pool.inserts[0]!.creditedMinor.reduce((a, m) => a + BigInt(m), 0n);
    expect(sum).toBe(100_00n);
  });

  it('(a) idempotent — re-writing the SAME credit_ids writes NOTHING (all suppressed)', async () => {
    // First write to learn the deterministic credit_ids, then mark them all present and re-write.
    await writer.writeCredit(creditParams());
    // The writer computes deterministic ids; re-run with the same inputs and pre-seed them as existing.
    // Capture the ids by replaying: existing pre-filter returns these → no INSERT.
    // We learn the ids from a fresh compute via the same path: mark every id the first INSERT would use.
    // Simpler: any credit_id IN (...) lookup returns ALL queried ids ⇒ everything suppressed.
    pool.inserts = [];
    pool.query = makeAllExistingQuery(pool);
    const res = await writer.writeCredit(creditParams());
    expect(res).toEqual({ inserted: 0, suppressed: 2 });
    expect(pool.inserts).toHaveLength(0); // no INSERT issued at all
  });

  it('(a) zero touches → no rows, no INSERT (honest unattributed)', async () => {
    pool.setTouches([]);
    const res = await writer.writeCredit(creditParams());
    expect(res).toEqual({ inserted: 0, suppressed: 0 });
    expect(pool.inserts).toHaveLength(0);
  });
});

/** A query() variant where the existing-id pre-filter echoes back EVERY queried credit_id. */
function makeAllExistingQuery(pool: FakePool) {
  return async (sql: string, params: unknown[] = []): Promise<[unknown, unknown]> => {
    if (sql.includes('credit_id IN (')) {
      // params = [brandId, ...ids]; echo all ids as present.
      const ids = params.slice(1) as string[];
      return [ids.map((id) => ({ credit_id: id })), undefined];
    }
    if (sql.startsWith('INSERT INTO')) {
      throw new Error('INSERT must not run when every credit_id is already present');
    }
    return [[], undefined];
  };
}

describe('AttributionCreditWriter — writeClawback R-11 cumulative clamp', () => {
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
    expect(pool.inserts).toHaveLength(0);
  });

  it('zero remaining (already fully clawed) → clamp to 0, no INSERT', async () => {
    pool.clawedBackTotalMinor = TOTAL; // whole credit already reversed
    const res = await writer.writeClawback(clawbackParams({ reversalBasisMinor: -50_00n }));
    expect(res).toEqual({ inserted: 0, suppressed: pool.savedCredits.length });
    expect(pool.inserts).toHaveLength(0);
  });

  it('exact reversal (basis == Σ credit) → Σ|clawback| == Σ credit', async () => {
    const res = await writer.writeClawback(clawbackParams({ reversalBasisMinor: -TOTAL }));
    expect(res.inserted).toBe(2);
    const ins = pool.inserts[0]!;
    expect(ins.rowKinds).toEqual(['clawback', 'clawback']);
    const sum = ins.creditedMinor.reduce((a, m) => a + BigInt(m), 0n);
    expect(sum).toBe(-TOTAL); // signed-negative, magnitude == Σ credit
    // saved weights re-used verbatim (never re-apportioned)
    expect(ins.weightFractions).toEqual(['0.50000000', '0.50000000']);
  });

  it('exceeding reversal (basis > Σ credit) → CLAMPED so Σ|clawback| never exceeds Σ credit', async () => {
    const res = await writer.writeClawback(clawbackParams({ reversalBasisMinor: -300_00n }));
    expect(res.inserted).toBe(2);
    const sum = pool.inserts[0]!.creditedMinor.reduce((a, m) => a + BigInt(m), 0n);
    expect(sum).toBe(-TOTAL); // clamped to -Σ credit, NOT -300_00
  });

  it('multiple partial reversals — cumulative never over-claws', async () => {
    // First partial: 60_00 of 100_00. Nothing clawed yet.
    const r1 = await writer.writeClawback(
      clawbackParams({ reversalLedgerEventId: 'rev-A', reversalBasisMinor: -60_00n }),
    );
    expect(r1.inserted).toBe(2);
    const sum1 = pool.inserts[0]!.creditedMinor.reduce((a, m) => a + BigInt(m), 0n);
    expect(sum1).toBe(-60_00n);

    // Second partial: requests 70_00 more, but only 40_00 remains → clamps to -40_00.
    pool.clawedBackTotalMinor = 60_00n; // the store now reflects the first clawback
    pool.inserts = [];
    const r2 = await writer.writeClawback(
      clawbackParams({ reversalLedgerEventId: 'rev-B', reversalBasisMinor: -70_00n }),
    );
    expect(r2.inserted).toBe(2);
    const sum2 = pool.inserts[0]!.creditedMinor.reduce((a, m) => a + BigInt(m), 0n);
    expect(sum2).toBe(-40_00n); // 100_00 cap − 60_00 already = 40_00 remaining

    // Third partial: nothing remains → clamp to 0, no INSERT.
    pool.clawedBackTotalMinor = 100_00n;
    pool.inserts = [];
    const r3 = await writer.writeClawback(
      clawbackParams({ reversalLedgerEventId: 'rev-C', reversalBasisMinor: -10_00n }),
    );
    expect(r3.inserted).toBe(0);
    expect(pool.inserts).toHaveLength(0);
  });
});

describe('AttributionCreditWriter — writeDataDrivenCredit Markov distribution', () => {
  let pool: FakePool;
  let writer: AttributionCreditWriter;
  beforeEach(() => {
    pool = new FakePool();
    writer = new AttributionCreditWriter(pool as never);
  });

  it('(c) distributes Markov channel weights to EXACT integer minor units summing to the basis', async () => {
    // 3 touches across 2 channels with uneven global weights; basis is INDIVISIBLE by the weights so the
    // largest-remainder closer must run — assert NO float drift: Σ == basis EXACTLY.
    pool.setTouches([touch(1, 'paid_meta'), touch(2, 'referral'), touch(3, 'paid_meta')]);
    const channelWeightUnits = new Map<string, bigint>([
      ['paid_meta', 70_000_000n], // 0.70 of WEIGHT_SCALE (1e8)
      ['referral', 30_000_000n], // 0.30
    ]);
    const basis = 100_03n; // deliberately not cleanly divisible
    const res = await writer.writeDataDrivenCredit(creditParams({ realizedRevenueMinor: basis }), channelWeightUnits);
    expect(res.inserted).toBe(3);
    const ins = pool.inserts[0]!;
    expect(ins.rowCount).toBe(3);
    const minors = ins.creditedMinor.map((m) => BigInt(m));
    const sum = minors.reduce((a, m) => a + m, 0n);
    expect(sum).toBe(basis); // EXACT closed-sum, no float drift
    // every credited amount is a whole minor-unit integer (no fractional / float string)
    for (const m of ins.creditedMinor) expect(m).toMatch(/^-?\d+$/);
  });

  it('(c) zero touches → no rows, no INSERT', async () => {
    pool.setTouches([]);
    const res = await writer.writeDataDrivenCredit(creditParams(), new Map([['paid_meta', 100_000_000n]]));
    expect(res).toEqual({ inserted: 0, suppressed: 0 });
    expect(pool.inserts).toHaveLength(0);
  });
});
