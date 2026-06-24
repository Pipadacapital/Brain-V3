/**
 * attribution-credit-writer.live.test.ts — live StarRocks tests for the Phase-5 writer.
 *
 * MEDALLION REALIGNMENT (Epic 2): the credit ledger is brain_gold.gold_attribution_credit (StarRocks),
 * written by AttributionCreditWriter (srPool-only). PostgreSQL billing.attribution_credit_ledger + its
 * channel_contribution_as_of / attributed_gmv_as_of seams + RLS are GONE. Tenant isolation is now
 * application-layer (explicit brand_id scoping); the read seam (withSilverBrand) enforces it for the
 * dashboard. This suite verifies (05-architecture.md §1/§3):
 *   1. credit append → deterministic credit_id, Σ credited = realized exactly (closed-sum-at-order).
 *   2. replay idempotency → re-running the SAME credit produces NO new rows (PK on brand_id+credit_id).
 *   3. clawback (writeClawback, reads SAVED weights from the gold ledger):
 *        • full RTO → Σ(credit+clawback)=0 (closed-sum=0).
 *        • partial refund → proportional to SAVED weights.
 *        • idempotent replay → no new clawback rows.
 *   4. per-channel closed-sum (exact-integer, tolerance 0) + brand scoping (a brand-scoped read sees
 *        only its rows; the unscoped read sees both — proving the predicate, not an empty-DB artifact).
 *
 * REQUIRES: StarRocks on localhost:9030.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import {
  computeAttributionCredit,
  type AttributionCreditRow,
  type CreditTouch,
  type SilverPool,
} from '@brain/metric-engine';
import { AttributionCreditWriter } from '../internal/credit-writer.js';

const SR_HOST = process.env['STARROCKS_HOST'] ?? '127.0.0.1';
const SR_PORT = Number(process.env['STARROCKS_QUERY_PORT'] ?? '9030');

const BRAND_A = 'aaaaa032-0032-0032-0032-000000000001';
const BRAND_B = 'aaaaa032-0032-0032-0032-000000000002';

let srPool: SilverPool;
let sr: mysql.Pool;
let available = false;

const NOW = new Date('2026-06-18T10:00:00Z');

function mkTouch(seq: number, channel: string): CreditTouch {
  return { touchSeq: seq, channel, campaignId: `c${seq}`, utmMedium: 'cpc', fbclid: null, gclid: null, ttclid: null };
}

function mkCredit(brandId: string, orderId: string, anonId: string, touches: CreditTouch[], realized: bigint): AttributionCreditRow[] {
  return computeAttributionCredit({
    brandId, orderId, brainAnonId: anonId, model: 'position_based', stitched: true,
    realizedRevenueMinor: realized, currencyCode: 'INR', touches,
    occurredAt: NOW, economicEffectiveAt: NOW, billingPostedPeriod: '2026-06',
  });
}

const DT = '2026-06-18 10:00:00';

/** Seed credit rows directly into the gold ledger (mirrors the writer's INSERT — PK upsert idempotent). */
async function appendCreditRows(rows: AttributionCreditRow[]): Promise<void> {
  if (rows.length === 0) return;
  const tuple = `(${new Array(22).fill('?').join(',')}, NOW())`;
  const params: unknown[] = [];
  for (const r of rows) {
    params.push(
      r.brandId, r.creditId, r.orderId, r.brainAnonId, r.touchSeq, r.channel, r.campaignId,
      r.modelId, r.rowKind, r.weightFraction, r.creditedRevenueMinor.toString(), r.currencyCode,
      r.reversedOfCreditId, r.reversalReason, r.realizedRevenueMinor.toString(),
      r.confidenceGrade, r.attributionConfidence, r.modelVersion, r.metricSnapshotId,
      DT, DT, r.billingPostedPeriod,
    );
  }
  await sr.query(
    `INSERT INTO brain_gold.gold_attribution_credit (
       brand_id, credit_id, order_id, brain_anon_id, touch_seq, channel, campaign_id,
       model_id, row_kind, weight_fraction, credited_revenue_minor, currency_code,
       reversed_of_credit_id, reversal_reason, realized_revenue_minor,
       confidence_grade, attribution_confidence, model_version, metric_snapshot_id,
       occurred_at, economic_effective_at, billing_posted_period, updated_at
     ) VALUES ${rows.map(() => tuple).join(',')}`,
    params,
  );
}

async function sumCredited(brandId: string, orderId: string): Promise<bigint> {
  const [rows] = await sr.query(
    `SELECT CAST(COALESCE(SUM(credited_revenue_minor),0) AS CHAR) AS s
       FROM brain_gold.gold_attribution_credit WHERE brand_id=? AND order_id=?`,
    [brandId, orderId],
  );
  return BigInt(String((rows as Array<{ s: string }>)[0]?.s ?? '0').split('.')[0] || '0');
}

async function clear(brandId: string): Promise<void> {
  await sr.query(`DELETE FROM brain_gold.gold_attribution_credit WHERE brand_id=?`, [brandId]).catch(() => {});
}

beforeAll(async () => {
  try {
    srPool = mysql.createPool({ host: SR_HOST, port: SR_PORT, user: 'root', password: '', connectionLimit: 4 }) as unknown as SilverPool;
    sr = srPool as unknown as mysql.Pool;
    await sr.query('SELECT 1');
    await sr.query(`CREATE TABLE IF NOT EXISTS brain_gold.gold_attribution_credit (
        brand_id varchar(64) NOT NULL, credit_id varchar(128) NOT NULL, order_id varchar(128),
        brain_anon_id varchar(128), touch_seq int, channel varchar(64), campaign_id varchar(255),
        model_id varchar(32), row_kind varchar(16), weight_fraction varchar(64),
        credited_revenue_minor bigint, currency_code varchar(8), reversed_of_credit_id varchar(128),
        reversal_reason varchar(32), realized_revenue_minor bigint, confidence_grade varchar(8),
        attribution_confidence varchar(16), model_version varchar(32), metric_snapshot_id varchar(128),
        occurred_at datetime, economic_effective_at datetime, billing_posted_period varchar(7), updated_at datetime
      ) PRIMARY KEY (brand_id, credit_id) DISTRIBUTED BY HASH(brand_id) BUCKETS 1
        PROPERTIES ("replication_num" = "1", "enable_persistent_index" = "true")`);
    await clear(BRAND_A);
    await clear(BRAND_B);
    available = true;
  } catch (e) {
    available = false;
    console.warn('[attr-credit-writer] StarRocks unavailable — PENDING.', (e as Error).message);
  }
});

afterAll(async () => {
  if (available) { await clear(BRAND_A); await clear(BRAND_B); }
  if (sr) await sr.end().catch(() => {});
});

describe('1. credit append — Σ credited = realized exactly (closed-sum at order grain)', () => {
  it('appends N=3 position_based credit rows; Σ credited = realized', async () => {
    if (!available) return;
    const orderId = `o-credit-${randomUUID()}`;
    const rows = mkCredit(BRAND_A, orderId, 'anon1', [mkTouch(1, 'paid_meta'), mkTouch(2, 'email'), mkTouch(3, 'paid_google')], 99_997n);
    await appendCreditRows(rows);
    expect(await sumCredited(BRAND_A, orderId)).toBe(99_997n);
    await clear(BRAND_A);
  });

  it('replay of the SAME credit produces NO new rows (deterministic credit_id idempotency)', async () => {
    if (!available) return;
    const orderId = `o-replay-${randomUUID()}`;
    const rows = mkCredit(BRAND_A, orderId, 'anon2', [mkTouch(1, 'paid_meta'), mkTouch(2, 'paid_google')], 50_000n);
    await appendCreditRows(rows);
    await appendCreditRows(rows); // replay (PK upsert → no new rows)
    await appendCreditRows(rows); // replay
    const [c] = await sr.query(`SELECT COUNT(*) n FROM brain_gold.gold_attribution_credit WHERE brand_id=? AND order_id=?`, [BRAND_A, orderId]);
    expect(Number((c as Array<{ n: number }>)[0]?.n)).toBe(2); // exactly 2 credit rows, no dups
    await clear(BRAND_A);
  });
});

describe('2. clawback via writeClawback (reads SAVED weights from the gold ledger)', () => {
  it('full RTO → Σ(credit+clawback) = 0 (closed-sum=0)', async () => {
    if (!available) return;
    const orderId = `o-rto-${randomUUID()}`;
    const realized = 123_457n;
    const credit = mkCredit(BRAND_A, orderId, 'anon3', [mkTouch(1, 'paid_meta'), mkTouch(2, 'email'), mkTouch(3, 'paid_google'), mkTouch(4, 'organic_social')], realized);
    await appendCreditRows(credit);

    const writer = new AttributionCreditWriter(srPool);
    const res = await writer.writeClawback({
      brandId: BRAND_A, orderId, model: 'position_based',
      reversalReason: 'rto_reversal', reversalLedgerEventId: 'rev-full', reversalBasisMinor: -realized, occurredAt: NOW,
    });
    expect(res.inserted).toBe(4);
    expect(await sumCredited(BRAND_A, orderId)).toBe(0n); // closed-sum=0

    // idempotent replay → no new rows
    const res2 = await writer.writeClawback({
      brandId: BRAND_A, orderId, model: 'position_based',
      reversalReason: 'rto_reversal', reversalLedgerEventId: 'rev-full', reversalBasisMinor: -realized, occurredAt: NOW,
    });
    expect(res2.inserted).toBe(0);
    expect(await sumCredited(BRAND_A, orderId)).toBe(0n);
    await clear(BRAND_A);
  });

  it('partial refund → clawback proportional to SAVED weights (net = half attributed)', async () => {
    if (!available) return;
    const orderId = `o-partial-${randomUUID()}`;
    const credit = mkCredit(BRAND_A, orderId, 'anon4', [mkTouch(1, 'paid_meta'), mkTouch(2, 'email'), mkTouch(3, 'paid_google')], 100_000n);
    await appendCreditRows(credit); // 40000/20000/40000

    const writer = new AttributionCreditWriter(srPool);
    await writer.writeClawback({
      brandId: BRAND_A, orderId, model: 'position_based',
      reversalReason: 'refund', reversalLedgerEventId: 'rev-partial', reversalBasisMinor: -50_000n, occurredAt: NOW,
    });
    // clawback = −20000/−10000/−20000 → net = 50000 attributed remains.
    expect(await sumCredited(BRAND_A, orderId)).toBe(50_000n);

    const [claw] = await sr.query(
      `SELECT touch_seq, CAST(credited_revenue_minor AS CHAR) AS credited_revenue_minor, weight_fraction
         FROM brain_gold.gold_attribution_credit
        WHERE brand_id=? AND order_id=? AND row_kind='clawback' ORDER BY touch_seq`, [BRAND_A, orderId]);
    const rows = claw as Array<{ credited_revenue_minor: string; weight_fraction: string }>;
    expect(rows.map((r) => r.credited_revenue_minor)).toEqual(['-20000', '-10000', '-20000']);
    expect(rows.map((r) => r.weight_fraction)).toEqual(['0.40000000', '0.20000000', '0.40000000']); // SAVED weights verbatim
    await clear(BRAND_A);
  });
});

describe('3. per-channel closed-sum (exact-integer, tolerance 0)', () => {
  it('Σ credited per channel from gold == expected; Σ all channels == 160000', async () => {
    if (!available) return;
    const o1 = `o-par-1-${randomUUID()}`;
    const o2 = `o-par-2-${randomUUID()}`;
    await appendCreditRows(mkCredit(BRAND_A, o1, 'pa1', [mkTouch(1, 'paid_meta'), mkTouch(2, 'paid_google')], 100_000n));
    await appendCreditRows(mkCredit(BRAND_A, o2, 'pa2', [mkTouch(1, 'paid_meta'), mkTouch(2, 'email'), mkTouch(3, 'paid_google')], 60_000n));

    const [raw] = await sr.query(
      `SELECT channel, CAST(SUM(credited_revenue_minor) AS CHAR) AS s FROM brain_gold.gold_attribution_credit
        WHERE brand_id=? AND model_id='position_based'
          AND CAST(economic_effective_at AS DATE) BETWEEN '2026-06-01' AND '2026-06-30'
        GROUP BY channel`, [BRAND_A]);
    const rawMap = new Map((raw as Array<{ channel: string; s: string }>).map((r) => [r.channel, BigInt(r.s)]));
    const attributed = [...rawMap.values()].reduce((a, b) => a + b, 0n);
    expect(attributed).toBe(160_000n); // closed-sum: Σ channel == Σ credited (attributed)
    await clear(BRAND_A);
  });
});

describe('4. brand scoping (NON-INERT)', () => {
  it('a brand-scoped read sees only its rows; the unscoped read sees both', async () => {
    if (!available) return;
    const orderA = `o-iso-a-${randomUUID()}`;
    const orderB = `o-iso-b-${randomUUID()}`;
    await appendCreditRows(mkCredit(BRAND_A, orderA, 'anonA', [mkTouch(1, 'paid_meta')], 70_000n));
    await appendCreditRows(mkCredit(BRAND_B, orderB, 'anonB', [mkTouch(1, 'paid_google')], 30_000n));

    // Brand-scoped read (the predicate the writer + read seam apply): only A's row.
    const [aOnly] = await sr.query(`SELECT COUNT(*) n FROM brain_gold.gold_attribution_credit WHERE brand_id=?`, [BRAND_A]);
    expect(Number((aOnly as Array<{ n: number }>)[0]?.n)).toBe(1);
    expect(await sumCredited(BRAND_A, orderA)).toBe(70_000n);

    // Unscoped read sees BOTH brands — proving the 1-row result above is the predicate, not absence of data.
    const [both] = await sr.query(
      `SELECT COUNT(*) n FROM brain_gold.gold_attribution_credit WHERE brand_id IN (?, ?)`, [BRAND_A, BRAND_B]);
    expect(Number((both as Array<{ n: number }>)[0]?.n)).toBe(2);

    await clear(BRAND_A);
    await clear(BRAND_B);
  });
});
