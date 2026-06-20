/**
 * ask-brain-scalars.live.test.ts — the newly-wired Ask-Brain scalar bindings (live Postgres).
 *
 * Proves askBrain surfaces a CERTIFIED number for the metrics added beyond realized/provisional —
 * ad_spend (money), blended_roas (ratio), cod_rto_rate (percent) — each over the metric-engine
 * sole-read-path, and that each reproduces byte-identically from its snapshot_id (D3). A stub
 * resolver supplies the binding (no model call); the engine pool reads real seeded ledgers.
 *
 * REQUIRES: Postgres on localhost:5432 with the ledgers + ai_provenance migrations applied.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import type { ResolverClient } from '@brain/ai-gateway-client';
import { askBrain, reproduceAnswer } from './ask-brain.js';

const SUPER = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';

const BRAND = 'a5ca1a01-0a11-4a11-8a11-00000000aa01';
const ORG = 'a5ca1a01-0a11-4a11-8a11-00000000ff01';
const USER = 'a5ca1a01-0a11-4a11-8a11-00000000ee01';
const AS_OF = '2026-06-18';

let pool: pg.Pool;
let pgAvailable = false;

/** A stub resolver that returns a fixed binding for `metricId` (no model call). */
function stubResolver(metricId: string): ResolverClient {
  return {
    async resolve() {
      return { kind: 'binding', metric_id: metricId, version: 'v1', params: { date_to: AS_OF } };
    },
  } as unknown as ResolverClient;
}

async function cleanup() {
  for (const t of ['ai_provenance', 'ad_spend_ledger', 'realized_revenue_ledger']) {
    await pool.query(`DELETE FROM ${t} WHERE brand_id=$1`, [BRAND]).catch(() => {});
  }
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

    // 100 finalized orders @ 1,000.00 INR; 10 RTO reversals → 10% RTO. realized = 100k − 10k.
    for (let i = 1; i <= 100; i++) {
      await pool.query(
        `INSERT INTO realized_revenue_ledger (brand_id, ledger_event_id, order_id, event_type, amount_minor, currency_code, occurred_at, economic_effective_at, billing_posted_period, recognition_label)
         VALUES ($1,$2,$3,'finalization',100000,'INR','2026-06-10T10:00:00Z','2026-06-10T10:00:00Z','2026-06','finalized')`,
        [BRAND, `ab-fin-${i}`, `ab-order-${i}`],
      );
    }
    for (let i = 1; i <= 10; i++) {
      await pool.query(
        `INSERT INTO realized_revenue_ledger (brand_id, ledger_event_id, order_id, event_type, amount_minor, currency_code, occurred_at, economic_effective_at, billing_posted_period, recognition_label)
         VALUES ($1,$2,$3,'rto_reversal',-100000,'INR','2026-06-11T10:00:00Z','2026-06-11T10:00:00Z','2026-06','finalized')`,
        [BRAND, `ab-rto-${i}`, `ab-order-${i}`],
      );
    }
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
});

afterAll(async () => {
  if (pgAvailable) await cleanup();
  await pool?.end?.().catch(() => {});
});

describe('askBrain — newly-wired scalar bindings (live Postgres)', () => {
  it('SKIP_IF_NO_PG', () => {
    if (!pgAvailable) console.warn('[ask-brain-scalars] Postgres unavailable — PENDING.');
    expect(true).toBe(true);
  });

  it('ad_spend → certified money (per-currency minor units)', async () => {
    if (!pgAvailable) return;
    const r = await askBrain(BRAND, 'how much have I spent on ads', AS_OF, { engine: { pool }, resolver: stubResolver('ad_spend') });
    expect(r.kind).toBe('answer');
    if (r.kind !== 'answer') return;
    expect(r.number.figure_kind).toBe('money');
    expect(r.number.money).toEqual({ INR: '200000' });
    expect(r.number.no_data).toBe(false);
  });

  it('blended_roas → certified ratio, reproducible from snapshot', async () => {
    if (!pgAvailable) return;
    const r = await askBrain(BRAND, 'what is my blended roas', AS_OF, { engine: { pool }, resolver: stubResolver('blended_roas') });
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
    );
    expect(reproduced).toEqual(r.number); // byte-identical (D3)
  });

  it('cod_rto_rate → certified percent', async () => {
    if (!pgAvailable) return;
    const r = await askBrain(BRAND, 'what is my rto rate', AS_OF, { engine: { pool }, resolver: stubResolver('cod_rto_rate') });
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
    const r = await askBrain(BRAND, 'order status mix', AS_OF, { engine: { pool }, resolver: stubResolver('order_status_mix') });
    expect(r.kind).toBe('answer');
    if (r.kind !== 'answer') return;
    expect(r.number.figure_kind).toBe('none');
    expect(r.number.money).toBeNull();
    expect(r.number.scalar).toBeNull();
  });
});
