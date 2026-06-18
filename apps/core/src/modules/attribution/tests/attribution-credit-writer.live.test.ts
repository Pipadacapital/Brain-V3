/**
 * attribution-credit-writer.live.test.ts — live Postgres tests for the Phase-5 writer.
 *
 * ALL tenant-isolation assertions run under SET ROLE brain_app (NOSUPERUSER NOBYPASSRLS) —
 * superuser `brain` bypasses RLS, so a negative control as superuser would be INERT and
 * meaningless. Superuser handles DDL/seed only.
 *
 * Verifies (Track-B acceptance, 05-architecture.md §1/§3):
 *   1. credit append → deterministic credit_id, Σ credited = realized exactly (closed-sum-at-order).
 *   2. replay idempotency → re-running the SAME credit produces NO new rows (ON CONFLICT (PK)).
 *   3. clawback (writeClawback, reads SAVED weights from the ledger):
 *        • full RTO → Σ(credit+clawback)=0 (closed-sum=0); attributed→0.
 *        • partial refund → proportional to SAVED weights.
 *        • idempotent replay → no new clawback rows.
 *   4. TENANT-SCOPED READ (NON-INERT): under brain_app, brand A reads only its rows; the
 *        attributed_gmv_as_of seam returns 0 cross-brand; the superuser control sees both
 *        (proving RLS — not an empty-DB artifact).
 *
 * REQUIRES: Postgres on localhost:5432 with migration 0032 applied.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  computeAttributionCredit,
  type AttributionCreditRow,
  type CreditTouch,
} from '@brain/metric-engine';
import { AttributionCreditWriter } from '../internal/credit-writer.js';

const SUPERUSER_URL = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const APP_URL = process.env['BRAIN_APP_DATABASE_URL'] ?? 'postgres://brain_app:brain_app@localhost:5432/brain';

const BRAND_A = 'aaaaa032-0032-0032-0032-000000000001';
const BRAND_B = 'aaaaa032-0032-0032-0032-000000000002';
const ORG_ID = 'ffffffff-0032-0032-0032-000000000001';

let superPool: pg.Pool;
let appPool: pg.Pool;

const NOW = new Date('2026-06-18T10:00:00Z');

function mkTouch(seq: number, channel: string): CreditTouch {
  return { touchSeq: seq, channel, campaignId: `c${seq}`, utmMedium: 'cpc', fbclid: null, gclid: null, ttclid: null };
}

/** Append rows via the SAME insert the writer uses (so credit seeding matches the writer path). */
async function appendCreditRows(brandId: string, rows: AttributionCreditRow[]): Promise<void> {
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_brand_id', $1, true)", [brandId]);
    for (const r of rows) {
      await client.query(
        `INSERT INTO attribution_credit_ledger (
           brand_id, credit_id, order_id, brain_anon_id, touch_seq, channel, campaign_id,
           model_id, row_kind, weight_fraction, credited_revenue_minor, currency_code,
           reversed_of_credit_id, reversal_reason, realized_revenue_minor,
           confidence_grade, attribution_confidence, model_version, metric_snapshot_id,
           occurred_at, economic_effective_at, billing_posted_period
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::numeric,$11::bigint,$12,$13,$14,$15::bigint,$16,$17::numeric,$18,$19,$20,$21,$22)
         ON CONFLICT (brand_id, credit_id) DO NOTHING`,
        [
          r.brandId, r.creditId, r.orderId, r.brainAnonId, r.touchSeq, r.channel, r.campaignId,
          r.modelId, r.rowKind, r.weightFraction, r.creditedRevenueMinor.toString(), r.currencyCode,
          r.reversedOfCreditId, r.reversalReason, r.realizedRevenueMinor.toString(),
          r.confidenceGrade, r.attributionConfidence, r.modelVersion, r.metricSnapshotId,
          r.occurredAt.toISOString(), r.economicEffectiveAt.toISOString(), r.billingPostedPeriod,
        ],
      );
    }
    await client.query('COMMIT');
  } finally {
    client.release();
  }
}

function mkCredit(brandId: string, orderId: string, anonId: string, touches: CreditTouch[], realized: bigint): AttributionCreditRow[] {
  return computeAttributionCredit({
    brandId, orderId, brainAnonId: anonId, model: 'position_based', stitched: true,
    realizedRevenueMinor: realized, currencyCode: 'INR', touches,
    occurredAt: NOW, economicEffectiveAt: NOW, billingPostedPeriod: '2026-06',
  });
}

async function sumCredited(brandId: string, orderId: string): Promise<bigint> {
  const client = await appPool.connect();
  try {
    // GUC is transaction-scoped (is_local=true) → the read must share the txn.
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_brand_id', $1, true)", [brandId]);
    const r = await client.query<{ s: string | null }>(
      `SELECT COALESCE(SUM(credited_revenue_minor),0)::bigint AS s FROM attribution_credit_ledger WHERE brand_id=$1 AND order_id=$2`,
      [brandId, orderId],
    );
    await client.query('COMMIT');
    return BigInt(r.rows[0]?.s ?? '0');
  } finally {
    client.release();
  }
}

async function clear(brandId: string): Promise<void> {
  await superPool.query(`DELETE FROM attribution_credit_ledger WHERE brand_id=$1`, [brandId]);
}

beforeAll(async () => {
  superPool = new pg.Pool({ connectionString: SUPERUSER_URL, max: 5 });
  appPool = new pg.Pool({ connectionString: APP_URL, max: 5 });
  await superPool.query('SELECT 1');
  await appPool.query('SELECT 1');
  const org = await superPool.query<{ id: string }>(`SELECT id FROM organization LIMIT 1`);
  const orgId = org.rows[0]?.id ?? ORG_ID;
  for (const [id, name] of [[BRAND_A, 'A 0032'], [BRAND_B, 'B 0032']] as const) {
    await superPool.query(
      `INSERT INTO brand (id, organization_id, display_name, currency_code, status)
       VALUES ($1,$2,$3,'INR','active') ON CONFLICT (id) DO UPDATE SET currency_code='INR', status='active'`,
      [id, orgId, `Test Brand ${name}`],
    );
  }
  await clear(BRAND_A);
  await clear(BRAND_B);
});

afterAll(async () => {
  await clear(BRAND_A);
  await clear(BRAND_B);
  await superPool.end().catch(() => {});
  await appPool.end().catch(() => {});
});

describe('1. credit append — Σ credited = realized exactly (closed-sum at order grain)', () => {
  it('appends N=3 position_based credit rows; Σ credited = realized', async () => {
    const orderId = `o-credit-${randomUUID()}`;
    const rows = mkCredit(BRAND_A, orderId, 'anon1', [mkTouch(1, 'paid_meta'), mkTouch(2, 'email'), mkTouch(3, 'paid_google')], 99_997n);
    await appendCreditRows(BRAND_A, rows);
    expect(await sumCredited(BRAND_A, orderId)).toBe(99_997n);
    await clear(BRAND_A);
  });

  it('replay of the SAME credit produces NO new rows (deterministic credit_id idempotency)', async () => {
    const orderId = `o-replay-${randomUUID()}`;
    const rows = mkCredit(BRAND_A, orderId, 'anon2', [mkTouch(1, 'paid_meta'), mkTouch(2, 'paid_google')], 50_000n);
    await appendCreditRows(BRAND_A, rows);
    await appendCreditRows(BRAND_A, rows); // replay
    await appendCreditRows(BRAND_A, rows); // replay
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_brand_id', $1, true)", [BRAND_A]);
      const c = await client.query<{ n: string }>(`SELECT COUNT(*) n FROM attribution_credit_ledger WHERE brand_id=$1 AND order_id=$2`, [BRAND_A, orderId]);
      expect(Number(c.rows[0]?.n)).toBe(2); // exactly 2 credit rows, no dups
      await client.query('COMMIT');
    } finally { client.release(); }
    await clear(BRAND_A);
  });
});

describe('2. clawback via writeClawback (reads SAVED weights from the ledger)', () => {
  it('full RTO → Σ(credit+clawback) = 0 (closed-sum=0)', async () => {
    const orderId = `o-rto-${randomUUID()}`;
    const realized = 123_457n;
    const credit = mkCredit(BRAND_A, orderId, 'anon3', [mkTouch(1, 'paid_meta'), mkTouch(2, 'email'), mkTouch(3, 'paid_google'), mkTouch(4, 'organic_social')], realized);
    await appendCreditRows(BRAND_A, credit);

    const writer = new AttributionCreditWriter(appPool, {} as never); // srPool unused on clawback path
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
    const orderId = `o-partial-${randomUUID()}`;
    const credit = mkCredit(BRAND_A, orderId, 'anon4', [mkTouch(1, 'paid_meta'), mkTouch(2, 'email'), mkTouch(3, 'paid_google')], 100_000n);
    await appendCreditRows(BRAND_A, credit); // 40000/20000/40000

    const writer = new AttributionCreditWriter(appPool, {} as never);
    await writer.writeClawback({
      brandId: BRAND_A, orderId, model: 'position_based',
      reversalReason: 'refund', reversalLedgerEventId: 'rev-partial', reversalBasisMinor: -50_000n, occurredAt: NOW,
    });
    // clawback = −20000/−10000/−20000 → net = 50000 attributed remains.
    expect(await sumCredited(BRAND_A, orderId)).toBe(50_000n);

    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_brand_id', $1, true)", [BRAND_A]);
      const claw = await client.query<{ touch_seq: number; credited_revenue_minor: string; weight_fraction: string }>(
        `SELECT touch_seq, credited_revenue_minor, weight_fraction FROM attribution_credit_ledger
          WHERE brand_id=$1 AND order_id=$2 AND row_kind='clawback' ORDER BY touch_seq`, [BRAND_A, orderId]);
      expect(claw.rows.map((r) => r.credited_revenue_minor)).toEqual(['-20000', '-10000', '-20000']);
      // SAVED weights carried verbatim
      expect(claw.rows.map((r) => r.weight_fraction)).toEqual(['0.40000000', '0.20000000', '0.40000000']);
      await client.query('COMMIT');
    } finally { client.release(); }
    await clear(BRAND_A);
  });
});

describe('3. PARITY ORACLE leg-2 — engine seam vs independent SQL (exact-integer, tolerance 0)', () => {
  it('channel_contribution_as_of (engine seam) == raw GROUP BY SQL over the same snapshot', async () => {
    // Seed a mixed period: two multi-touch orders on distinct channels.
    const o1 = `o-par-1-${randomUUID()}`;
    const o2 = `o-par-2-${randomUUID()}`;
    await appendCreditRows(BRAND_A, mkCredit(BRAND_A, o1, 'pa1', [mkTouch(1, 'paid_meta'), mkTouch(2, 'paid_google')], 100_000n));
    await appendCreditRows(BRAND_A, mkCredit(BRAND_A, o2, 'pa2', [mkTouch(1, 'paid_meta'), mkTouch(2, 'email'), mkTouch(3, 'paid_google')], 60_000n));

    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_brand_id', $1, true)", [BRAND_A]);
      // Engine read path (the named seam).
      const seam = await client.query<{ channel: string; contribution_minor: string }>(
        `SELECT channel, contribution_minor FROM channel_contribution_as_of($1::uuid,'position_based','2026-06-01'::date,'2026-06-30'::date) ORDER BY channel`,
        [BRAND_A]);
      // Independent SQL recompute over the SAME snapshot.
      const raw = await client.query<{ channel: string; s: string }>(
        `SELECT channel, SUM(credited_revenue_minor)::bigint AS s FROM attribution_credit_ledger
          WHERE brand_id=$1 AND model_id='position_based'
            AND economic_effective_at::date BETWEEN '2026-06-01' AND '2026-06-30'
          GROUP BY channel ORDER BY channel`, [BRAND_A]);
      await client.query('COMMIT');

      const seamMap = new Map(seam.rows.map((r) => [r.channel, BigInt(r.contribution_minor)]));
      const rawMap = new Map(raw.rows.map((r) => [r.channel, BigInt(r.s)]));
      expect([...seamMap.keys()].sort()).toEqual([...rawMap.keys()].sort());
      for (const [ch, v] of rawMap) expect(seamMap.get(ch)).toBe(v); // exact-integer equality, tolerance 0

      // Closed-sum: Σ channel_contribution == Σ credited (attributed) == 160000.
      const attributed = [...rawMap.values()].reduce((a, b) => a + b, 0n);
      expect(attributed).toBe(160_000n);
    } finally { client.release(); }
    await clear(BRAND_A);
  });
});

describe('4. TENANT-SCOPED read isolation under brain_app (NON-INERT)', () => {
  it('brand A reads only its rows; attributed_gmv_as_of cross-brand = 0; superuser sees both', async () => {
    const orderA = `o-iso-a-${randomUUID()}`;
    const orderB = `o-iso-b-${randomUUID()}`;
    await appendCreditRows(BRAND_A, mkCredit(BRAND_A, orderA, 'anonA', [mkTouch(1, 'paid_meta')], 70_000n));
    await appendCreditRows(BRAND_B, mkCredit(BRAND_B, orderB, 'anonB', [mkTouch(1, 'paid_google')], 30_000n));

    // Under brain_app with brand A GUC: only A's rows visible.
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_brand_id', $1, true)", [BRAND_A]);
      const role = await client.query<{ u: string }>(`SELECT current_user AS u`);
      expect(role.rows[0]?.u).toBe('brain_app'); // sanity: NOT superuser (else RLS inert)

      const all = await client.query<{ n: string }>(`SELECT COUNT(*) n FROM attribution_credit_ledger`);
      expect(Number(all.rows[0]?.n)).toBe(1); // ONLY brand A's row — B is filtered by RLS

      // The attributed_gmv_as_of seam (SECURITY INVOKER) under A's GUC: A's sum, not B's.
      const aSum = await client.query<{ v: string }>(`SELECT attributed_gmv_as_of($1::uuid,'position_based',$2::date) AS v`, [BRAND_A, '2026-06-30']);
      expect(BigInt(aSum.rows[0]?.v ?? '0')).toBe(70_000n);
      // Cross-brand: asking for B's brand under A's GUC → RLS filters → 0 (non-inert).
      const bSum = await client.query<{ v: string }>(`SELECT attributed_gmv_as_of($1::uuid,'position_based',$2::date) AS v`, [BRAND_B, '2026-06-30']);
      expect(BigInt(bSum.rows[0]?.v ?? '0')).toBe(0n);
      await client.query('COMMIT');
    } finally { client.release(); }

    // NEGATIVE CONTROL (proves the assertion isn't an empty-DB artifact): superuser bypasses
    // RLS and sees BOTH brands' rows → the 1-row result above was RLS, not absence of data.
    const both = await superPool.query<{ n: string }>(
      `SELECT COUNT(*) n FROM attribution_credit_ledger WHERE brand_id IN ($1,$2)`, [BRAND_A, BRAND_B]);
    expect(Number(both.rows[0]?.n)).toBe(2);

    await clear(BRAND_A);
    await clear(BRAND_B);
  });
});
