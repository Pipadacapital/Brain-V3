/**
 * bronze-ledger-provenance.live.test.ts — P2.4: the Bronze→Gold rebuildability guard (live Postgres).
 *
 * Proves bronzeLedgerProvenanceCheck detects when a realized_revenue_ledger row's order_id has NO
 * corresponding order.* event in Bronze — i.e. a ledger row that Bronze cannot rebuild ("Bronze is
 * source of truth" violation):
 *   PV1: a ledger order WITH a matching Bronze order event → 0 orphans → A+ (passing).
 *   PV2: a ledger order WITHOUT a Bronze order event → 1 orphan → counted (the guard fires).
 *
 * Runs as brain_app under the brand GUC (RLS FORCE — never superuser). REQUIRES Postgres.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { bronzeLedgerProvenanceCheck, PROVENANCE_TARGET } from '../jobs/dq/bronze-ledger-provenance-check.js';
import type { SilverReader } from '../jobs/dq/silver-reader.js';

/**
 * Fake Bronze reader. DB-AUDIT C4 moved Bronze to the Iceberg SoR (StarRocks), so provenance reads
 * Bronze order_ids via the SilverReader seam (the ledger side stays real PG). The check issues a
 * single bronze query (DISTINCT order.* order_ids), so the fake returns the configured set.
 */
function fakeBronzeSilver(orderIds: string[]): SilverReader {
  return {
    async scopedQuery<T = Record<string, unknown>>(): Promise<T[]> {
      return orderIds.map((order_id) => ({ order_id })) as T[];
    },
    async end(): Promise<void> { /* no-op */ },
  };
}

const SUPER = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const APP = process.env['BRAIN_APP_DATABASE_URL'] ?? 'postgres://brain_app:brain_app@localhost:5432/brain';

const BRAND = 'b2040000-2040-4040-8040-000000000a01';
const ORG = 'b2040000-2040-4040-8040-000000000f01';
const USER = 'b2040000-2040-4040-8040-000000000e01';
const ORDER_WITH_BRONZE = 'prov-order-bronze-1';
const ORDER_NO_BRONZE = 'prov-order-orphan-1';

let superPool: pg.Pool;
let appPool: pg.Pool;
let pgAvailable = false;

async function cleanup() {
  await superPool.query(`DELETE FROM realized_revenue_ledger WHERE brand_id=$1`, [BRAND]).catch(() => {});
  await superPool.query(`DELETE FROM brand WHERE id=$1`, [BRAND]).catch(() => {});
  await superPool.query(`DELETE FROM organization WHERE id=$1`, [ORG]).catch(() => {});
  await superPool.query(`DELETE FROM app_user WHERE id=$1`, [USER]).catch(() => {});
}

beforeAll(async () => {
  try {
    superPool = new pg.Pool({ connectionString: SUPER, connectionTimeoutMillis: 4000 });
    await superPool.query('SELECT 1');
    appPool = new pg.Pool({ connectionString: APP, max: 3 });
    await cleanup();
    await superPool.query(`INSERT INTO app_user (id,email,email_normalized,password_hash) VALUES ($1,$2,$3,'x')`, [USER, `${USER}@x.invalid`, `${USER}@x.invalid`]);
    await superPool.query(`INSERT INTO organization (id,name,slug,owner_user_id) VALUES ($1,'PV',$2,$3)`, [ORG, `pv-${ORG.slice(-6)}`, USER]);
    await superPool.query(`INSERT INTO brand (id,organization_id,display_name,currency_code,status) VALUES ($1,$2,'PV','INR','active')`, [BRAND, ORG]);

    // Bronze order_ids are injected via the fake reader per-test (Iceberg SoR; see fakeBronzeSilver).
    // Ledger: a provisional_recognition row for BOTH order_ids. ORDER_NO_BRONZE is the orphan.
    for (const oid of [ORDER_WITH_BRONZE, ORDER_NO_BRONZE]) {
      await superPool.query(
        `INSERT INTO realized_revenue_ledger
           (brand_id, ledger_event_id, order_id, event_type, amount_minor, currency_code, occurred_at, economic_effective_at, billing_posted_period, recognition_label)
         VALUES ($1,$2,$3,'provisional_recognition',10000,'INR',now(),now(),'2026-06','provisional')`,
        [BRAND, `prov-led-${oid}`, oid],
      );
    }
    pgAvailable = true;
  } catch {
    pgAvailable = false;
  }
});

afterAll(async () => {
  if (pgAvailable) await cleanup();
  await appPool?.end?.().catch(() => {});
  await superPool?.end?.().catch(() => {});
});

describe('bronzeLedgerProvenanceCheck (P2.4, live Postgres)', () => {
  it('SKIP_IF_NO_PG', () => {
    if (!pgAvailable) console.warn('[bronze-ledger-provenance] Postgres unavailable — PENDING.');
    expect(true).toBe(true);
  });

  it('detects the orphan ledger order (no Bronze order event) — the rebuildability guard fires', async () => {
    if (!pgAvailable) return;
    // Bronze has ONLY ORDER_WITH_BRONZE → ORDER_NO_BRONZE is the orphan.
    const [row] = await bronzeLedgerProvenanceCheck(appPool, fakeBronzeSilver([ORDER_WITH_BRONZE]), BRAND);
    expect(row?.category).toBe('reconciliation');
    expect(row?.target).toBe(PROVENANCE_TARGET);
    // Exactly one of the two ledger orders (ORDER_NO_BRONZE) is missing from Bronze.
    expect(row?.observed).toBe('orphans=1 of 2 ledger_orders');
  });

  it('reports zero orphans once every ledger order has a Bronze order event → A+', async () => {
    if (!pgAvailable) return;
    // Bronze now has BOTH order_ids → every ledger order traces to Bronze → 0 orphans.
    const [row] = await bronzeLedgerProvenanceCheck(
      appPool,
      fakeBronzeSilver([ORDER_WITH_BRONZE, ORDER_NO_BRONZE]),
      BRAND,
    );
    expect(row?.observed).toBe('orphans=0 of 2 ledger_orders');
    expect(row?.grade).toBe('A+');
    expect(row?.passing).toBe(true);
  });
});
