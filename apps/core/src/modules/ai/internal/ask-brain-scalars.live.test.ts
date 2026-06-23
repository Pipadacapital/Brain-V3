/**
 * ask-brain-scalars.live.test.ts — the newly-wired Ask-Brain scalar bindings (live Postgres).
 *
 * Proves askBrain surfaces a CERTIFIED number for the metrics added beyond realized/provisional —
 * ad_spend (money), blended_roas (ratio), cod_rto_rate (percent) — each over the metric-engine
 * sole-read-path, and that each reproduces byte-identically from its snapshot_id (D3). A stub
 * resolver supplies the binding (no model call); the engine pool reads real seeded ledgers.
 *
 * PHASE G: ad_spend + blended_roas now read the LAKEHOUSE (silver_marketing_spend +
 * gold_revenue_ledger) via withSilverBrand — so this test ALSO seeds StarRocks and passes srPool.
 * cod_rto_rate / order_status_mix stay on PG. The lakehouse cases SKIP if StarRocks is down.
 *
 * REQUIRES: Postgres on localhost:5432 (ledgers + ai_provenance) + StarRocks on :9030 (Phase-G marts).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import type { ResolverClient } from '@brain/ai-gateway-client';
import type { SilverPool } from '@brain/metric-engine';
import { askBrain, reproduceAnswer } from './ask-brain.js';

const SUPER = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const SR_HOST = process.env['STARROCKS_HOST'] ?? '127.0.0.1';
const SR_PORT = Number(process.env['STARROCKS_QUERY_PORT'] ?? 9030);

const BRAND = 'a5ca1a01-0a11-4a11-8a11-00000000aa01';
const ORG = 'a5ca1a01-0a11-4a11-8a11-00000000ff01';
const USER = 'a5ca1a01-0a11-4a11-8a11-00000000ee01';
const AS_OF = '2026-06-18';

let pool: pg.Pool;
let pgAvailable = false;
let srPool: mysql.Pool;
let srUp = false;
const sr = (): SilverPool => srPool as unknown as SilverPool;

/** A stub resolver that returns a fixed binding for `metricId` (no model call). */
function stubResolver(metricId: string): ResolverClient {
  return {
    async resolve() {
      return { kind: 'binding', metric_id: metricId, version: 'v1', params: { date_to: AS_OF } };
    },
  } as unknown as ResolverClient;
}

async function cleanupSilver() {
  if (!srUp) return;
  await srPool.query(`DELETE FROM brain_silver.silver_marketing_spend WHERE brand_id=?`, [BRAND]).catch(() => {});
  await srPool.query(`DELETE FROM brain_gold.gold_revenue_ledger WHERE brand_id=?`, [BRAND]).catch(() => {});
}

async function cleanup() {
  for (const t of ['ai_provenance', 'ad_spend_ledger']) {
    await pool.query(`DELETE FROM ${t} WHERE brand_id=$1`, [BRAND]).catch(() => {});
  }
  await cleanupSilver();
  await pool.query(`DELETE FROM brand WHERE id=$1`, [BRAND]).catch(() => {});
  await pool.query(`DELETE FROM organization WHERE id=$1`, [ORG]).catch(() => {});
  await pool.query(`DELETE FROM app_user WHERE id=$1`, [USER]).catch(() => {});
}

beforeAll(async () => {
  try {
    pool = new pg.Pool({ connectionString: SUPER, connectionTimeoutMillis: 4000, max: 4 });
    await pool.query('SELECT 1');
    await cleanup();
    await pool.query(`INSERT INTO app_user (id,email,email_normalized,password_hash) VALUES ($1,$2,$3,'x')`, [USER, `${USER}@x.invalid`, `${USER}@x.invalid`]);
    await pool.query(`INSERT INTO organization (id,name,slug,owner_user_id) VALUES ($1,'AB',$2,$3)`, [ORG, `ab-${ORG.slice(-6)}`, USER]);
    await pool.query(`INSERT INTO brand (id,organization_id,display_name,currency_code,status) VALUES ($1,$2,'AB','INR','active')`, [BRAND, ORG]);

    // MEDALLION REALIGNMENT (Epic 1): revenue is the lakehouse gold ledger (seeded below), not PG.
    // Ad spend 2,000.00 INR → ROAS = realized ÷ spend.
    await pool.query(
      `INSERT INTO ad_spend_ledger (brand_id, spend_event_id, platform, level, level_id, stat_date, spend_minor, currency_code, raw_event_id, occurred_at)
       VALUES ($1,'ab-spend-1','meta','campaign','c1','2026-06-12',200000,'INR','ab-spend-1','2026-06-12T00:00:00Z')`,
      [BRAND],
    );
    pgAvailable = true;
  } catch {
    pgAvailable = false;
  }

  // ── Phase G: seed the LAKEHOUSE equivalents (ad_spend + blended_roas read here now) ──
  try {
    srPool = mysql.createPool({ host: SR_HOST, port: SR_PORT, user: 'root', password: '', connectionLimit: 2 });
    await srPool.query('SELECT 1');
    srUp = true;
  } catch {
    srUp = false;
  }
  if (srUp && pgAvailable) {
    await cleanupSilver();
    // gold_revenue_ledger: 100 finalizations (100000) + 10 rto_reversals (-100000) → net 9,000,000.
    // ONE batched multi-row INSERT (per-row StarRocks INSERTs are slow → would time the hook out).
    const tuples: string[] = [];
    const params: unknown[] = [];
    for (let i = 1; i <= 100; i++) {
      tuples.push(`(?,?,?,NULL,'finalization',100000,'INR',0,'2026-06-10 10:00:00','2026-06-10 10:00:00','finalized','2026-06',NOW())`);
      params.push(BRAND, `ab-fin-${i}`, `ab-order-${i}`);
    }
    for (let i = 1; i <= 10; i++) {
      tuples.push(`(?,?,?,NULL,'rto_reversal',-100000,'INR',0,'2026-06-11 10:00:00','2026-06-11 10:00:00','finalized','2026-06',NOW())`);
      params.push(BRAND, `ab-rto-${i}`, `ab-order-${i}`);
    }
    await srPool.query(
      `INSERT INTO brain_gold.gold_revenue_ledger (brand_id, ledger_event_id, order_id, brain_id, event_type, amount_minor, currency_code, fee_minor, occurred_at, economic_effective_at, recognition_label, billing_posted_period, updated_at)
       VALUES ${tuples.join(',')}`,
      params,
    );
    // silver_marketing_spend: 2,000.00 INR on meta.
    await srPool.query(
      `INSERT INTO brain_silver.silver_marketing_spend (brand_id, spend_event_id, platform, level, level_id, parent_id, campaign_id, campaign_name, stat_date, spend_minor, currency_code, impressions, clicks, account_timezone, occurred_at, updated_at)
       VALUES (?, 'ab-spend-1','meta','campaign','c1',NULL,'c1','AB','2026-06-12',200000,'INR',1000,50,'Asia/Kolkata','2026-06-12 00:00:00',NOW())`,
      [BRAND],
    );
  }
});

afterAll(async () => {
  if (pgAvailable) await cleanup();
  await pool?.end?.().catch(() => {});
  if (srPool) await srPool.end().catch(() => {});
});

describe('askBrain — newly-wired scalar bindings (live Postgres)', () => {
  it('SKIP_IF_NO_PG', () => {
    if (!pgAvailable) console.warn('[ask-brain-scalars] Postgres unavailable — PENDING.');
    expect(true).toBe(true);
  });

  it('ad_spend → certified money (per-currency minor units)', async () => {
    if (!pgAvailable || !srUp) return;
    const r = await askBrain(BRAND, 'how much have I spent on ads', AS_OF, { engine: { pool }, srPool: sr(), resolver: stubResolver('ad_spend') });
    expect(r.kind).toBe('answer');
    if (r.kind !== 'answer') return;
    expect(r.number.figure_kind).toBe('money');
    expect(r.number.money).toEqual({ INR: '200000' });
    expect(r.number.no_data).toBe(false);
  });

  it('blended_roas → certified ratio, reproducible from snapshot', async () => {
    if (!pgAvailable || !srUp) return;
    const r = await askBrain(BRAND, 'what is my blended roas', AS_OF, { engine: { pool }, srPool: sr(), resolver: stubResolver('blended_roas') });
    expect(r.kind).toBe('answer');
    if (r.kind !== 'answer') return;
    expect(r.number.figure_kind).toBe('ratio');
    expect(r.number.scalar).not.toBeNull();
    expect(r.number.scalar!.unit).toBe('ratio');
    // realized 9,000,000 minor ÷ spend 200,000 minor = 45.0×
    expect(Number(r.number.scalar!.value)).toBeCloseTo(45, 1);
    expect(r.number.scalar!.display).toContain('×');

    const reproduced = await reproduceAnswer(
      BRAND,
      { metric_id: r.binding.metric_id, version: r.binding.metric_version, params: r.binding.params },
      r.binding.snapshot_id,
      { pool },
      sr(),
    );
    expect(reproduced).toEqual(r.number); // byte-identical (D3)
  });

  it('cod_rto_rate → certified percent', async () => {
    if (!pgAvailable) return;
    const r = await askBrain(BRAND, 'what is my rto rate', AS_OF, { engine: { pool }, srPool: sr(), resolver: stubResolver('cod_rto_rate') });
    expect(r.kind).toBe('answer');
    if (r.kind !== 'answer') return;
    expect(r.number.figure_kind).toBe('percent');
    expect(r.number.scalar).not.toBeNull();
    expect(r.number.scalar!.unit).toBe('percent');
    expect(Number(r.number.scalar!.value)).toBeCloseTo(10, 1); // 10 RTO / 100 orders
    expect(r.number.scalar!.display).toContain('%');
  });

  it('a distribution metric (order_status_mix) stays honestly figure_kind:none', async () => {
    if (!pgAvailable) return;
    const r = await askBrain(BRAND, 'order status mix', AS_OF, { engine: { pool }, srPool: sr(), resolver: stubResolver('order_status_mix') });
    expect(r.kind).toBe('answer');
    if (r.kind !== 'answer') return;
    expect(r.number.figure_kind).toBe('none');
    expect(r.number.money).toBeNull();
    expect(r.number.scalar).toBeNull();
  });
});
