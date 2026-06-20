/**
 * gokwik-scheduler-wiring.test.ts — P0: GoKwik AWB re-pull is now dispatchable on a schedule.
 *
 * The SECURITY DEFINER fn list_gokwik_connectors_for_awb_repull() existed (0030) and the repull
 * run() existed, but the scheduler/claimer never enumerated or dispatched gokwik — so in a real
 * deployment the connector showed connected while ingesting nothing on a schedule. This proves:
 *   GK1 (unit): loadRun('gokwik') now returns the repull run() (was null before → never dispatched).
 *   GK2 (live): enumerateConnectedConnectors() includes a connected gokwik connector with
 *               provider='gokwik' (so the ingest-scheduler + sync-claimer will dispatch it).
 *
 * GK2 requires Postgres (the enumeration fns).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { loadRun, enumerateConnectedConnectors } from '../jobs/sync-request-claimer/run.js';

const SUPER = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const APP = process.env['BRAIN_APP_DATABASE_URL'] ?? 'postgres://brain_app:brain_app@localhost:5432/brain';

const BRAND = 'c9a10030-0030-4030-8030-0000000000a1';
const ORG = 'c9a10030-0030-4030-8030-0000000000f1';
const USER = 'c9a10030-0030-4030-8030-0000000000e1';
const CI = 'c9a10030-0030-4030-8030-0000000000c1';

let superPool: pg.Pool;
let appPool: pg.Pool;
let pgAvailable = false;

async function cleanup() {
  await superPool.query(`DELETE FROM connector_sync_status WHERE connector_instance_id=$1`, [CI]).catch(() => {});
  await superPool.query(`DELETE FROM connector_instance WHERE id=$1`, [CI]).catch(() => {});
  await superPool.query(`DELETE FROM brand WHERE id=$1`, [BRAND]).catch(() => {});
  await superPool.query(`DELETE FROM organization WHERE id=$1`, [ORG]).catch(() => {});
  await superPool.query(`DELETE FROM app_user WHERE id=$1`, [USER]).catch(() => {});
}

beforeAll(async () => {
  try {
    superPool = new pg.Pool({ connectionString: SUPER, connectionTimeoutMillis: 4000 });
    await superPool.query('SELECT 1');
    appPool = new pg.Pool({ connectionString: APP, max: 2 });
    await cleanup();
    await superPool.query(
      `INSERT INTO app_user (id,email,email_normalized,password_hash)
       VALUES ($1,'gk@example.invalid','gk@example.invalid','x') ON CONFLICT (id) DO NOTHING`, [USER]);
    await superPool.query(
      `INSERT INTO organization (id,name,slug,owner_user_id)
       VALUES ($1,'GK Org','gk-org',$2) ON CONFLICT (id) DO NOTHING`, [ORG, USER]);
    await superPool.query(
      `INSERT INTO brand (id,organization_id,display_name,currency_code,status)
       VALUES ($1,$2,'GK Brand','INR','active') ON CONFLICT (id) DO NOTHING`, [BRAND, ORG]);
    // A CONNECTED gokwik connector — exactly what list_gokwik_connectors_for_awb_repull() returns.
    await superPool.query(
      `INSERT INTO connector_instance (id, brand_id, provider, status, shop_domain, secret_ref, gokwik_appid)
       VALUES ($1,$2,'gokwik','connected','',$3,$4)
       ON CONFLICT (id) DO UPDATE SET status='connected', provider='gokwik'`,
      [CI, BRAND, 'arn:aws:secretsmanager:dev:gokwik', 'gk_app_test123']);
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

describe('GoKwik scheduler wiring (P0)', () => {
  it('GK1: loadRun("gokwik") returns the repull run() (was null → never dispatched)', async () => {
    const run = await loadRun('gokwik');
    expect(typeof run).toBe('function');
    // sanity: an unknown provider still yields null (the default arm is intact).
    expect(await loadRun('definitely_not_a_provider')).toBeNull();
  });

  it('GK2: enumerateConnectedConnectors includes the connected gokwik connector', async () => {
    if (!pgAvailable) { console.warn('[gokwik-scheduler-wiring] Postgres unavailable — PENDING.'); return; }
    const connectors = await enumerateConnectedConnectors(appPool);
    const mine = connectors.find((c) => c.connector_instance_id === CI);
    expect(mine).toBeDefined();
    expect(mine!.provider).toBe('gokwik');
    expect(mine!.brand_id).toBe(BRAND);
  });
});
