/**
 * gokwik-shopflo-isolation.integration.test.ts — isolation + brand-resolution-from-connector
 * for the 0030 SECURITY DEFINER seams, verified UNDER brain_app (05-architecture.md §10).
 *
 * THE invariant (MEMORY: dev-db-superuser-masks-rls): per-brand isolation is real ONLY under
 * brain_app — superuser 'brain' BYPASSES RLS, so any isolation check run as superuser is INERT.
 * assertBrainApp() (is_superuser=false) gates every assertion here.
 *
 * I1: resolve_shopflo_connector_by_merchant(merchant_id) resolves brand_id from the CONNECTOR ROW
 *     (MT-1) — NOT from any caller-supplied brand. Two brands install Shopflo with DISTINCT
 *     merchant_ids → the fn returns each brand's OWN row, never the other's.
 * I2: an UNKNOWN merchant_id resolves to ZERO rows → the webhook handler would 401 (no write).
 *     A merchant_id whose connector is NOT 'connected' also resolves to zero rows.
 * I3: list_gokwik_connectors() enumerates connected gokwik connectors with NO GUC
 *     set (SECURITY DEFINER bypasses FORCE RLS) — the durable enumeration seam.
 * I4: connector_instance is FORCE-RLS — under brain_app WITHOUT a GUC, a direct SELECT returns
 *     ZERO rows (fail-closed), proving the SECURITY DEFINER fn is the ONLY enumeration path.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { assertBrainApp, seedTestBrand, cleanupConnectorFixtures } from './helpers/connector-lifecycle-fixtures.js';

const BRAIN_APP_DB_URL =
  process.env['BRAIN_APP_DATABASE_URL'] ?? 'postgres://brain_app:brain_app@localhost:5432/brain';
const SUPERUSER_DB_URL =
  process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';

const BRAND_X = 'a0c11501-0a00-4a00-8a00-00000000a0f1';
const BRAND_Y = 'a0c11502-0b00-4b00-8b00-00000000b0f2';
const BRAND_Z = 'a0c11503-0c00-4c00-8c00-00000000c0f3';   // disconnected-connector brand
const CI_SHOPFLO_X = 'a0c1150c-0c00-4c00-8c00-00000000c0f3';
const CI_SHOPFLO_Y = 'a0c1150d-0d00-4d00-8d00-00000000d0f4';
const CI_GOKWIK_X = 'a0c1150e-0e00-4e00-8e00-00000000e0f5';
const CI_SHOPFLO_DISCONNECTED = 'a0c1150f-0f00-4f00-8f00-00000000f0f6';

const MERCHANT_X = 'merchant_X_synth';
const MERCHANT_Y = 'merchant_Y_synth';
const MERCHANT_DISCONNECTED = 'merchant_disc_synth';

let superPool: Pool;
let appPool: Pool;
let infraAvailable = false;

async function pgReachable(): Promise<boolean> {
  try {
    const p = new Pool({ connectionString: SUPERUSER_DB_URL, max: 1 });
    await p.query('SELECT 1');
    await p.end();
    return true;
  } catch { return false; }
}

async function seedShopflo(brandId: string, ciId: string, merchantId: string, status = 'connected'): Promise<void> {
  await superPool.query(
    `INSERT INTO connector_instance (id, brand_id, provider, status, shop_domain, secret_ref, shopflo_merchant_id)
     VALUES ($1,$2,'shopflo',$3,'',$4,$5)
     ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, shopflo_merchant_id=EXCLUDED.shopflo_merchant_id, secret_ref=EXCLUDED.secret_ref`,
    [ciId, brandId, status, `brain/connector/shopflo/${brandId}/${merchantId}`, merchantId],
  );
}
async function seedGokwik(brandId: string, ciId: string, appid: string): Promise<void> {
  await superPool.query(
    `INSERT INTO connector_instance (id, brand_id, provider, status, shop_domain, secret_ref, gokwik_appid)
     VALUES ($1,$2,'gokwik','connected','',$3,$4)
     ON CONFLICT (id) DO UPDATE SET status='connected', gokwik_appid=EXCLUDED.gokwik_appid`,
    [ciId, brandId, `brain/connector/gokwik/${brandId}/e2e`, appid],
  );
}

beforeAll(async () => {
  infraAvailable = await pgReachable();
  if (!infraAvailable) { console.warn('[gokwik-shopflo-isolation] SKIP — PG not reachable'); return; }
  superPool = new Pool({ connectionString: SUPERUSER_DB_URL, max: 3 });
  appPool = new Pool({ connectionString: BRAIN_APP_DB_URL, max: 3 });
  await seedTestBrand(superPool, BRAND_X, 'INR');
  await seedTestBrand(superPool, BRAND_Y, 'INR');
  await seedTestBrand(superPool, BRAND_Z, 'INR');
  await seedShopflo(BRAND_X, CI_SHOPFLO_X, MERCHANT_X);
  await seedShopflo(BRAND_Y, CI_SHOPFLO_Y, MERCHANT_Y);
  await seedShopflo(BRAND_Z, CI_SHOPFLO_DISCONNECTED, MERCHANT_DISCONNECTED, 'disconnected');
  await seedGokwik(BRAND_X, CI_GOKWIK_X, 'appid_X');
}, 30_000);

afterAll(async () => {
  if (!infraAvailable) return;
  await cleanupConnectorFixtures(superPool, [BRAND_X, BRAND_Y, BRAND_Z]);
  await appPool?.end().catch(() => undefined);
  await superPool?.end().catch(() => undefined);
}, 30_000);

describe('I1: resolve_shopflo_connector_by_merchant — brand from connector row (MT-1)', () => {
  it('each merchant_id resolves to its OWN brand, never the other (under brain_app)', async () => {
    if (!infraAvailable) return;
    await assertBrainApp(appPool);   // is_superuser=false — else this check is INERT

    const x = await appPool.query<{ brand_id: string; connector_instance_id: string }>(
      `SELECT brand_id, connector_instance_id FROM resolve_shopflo_connector_by_merchant($1)`, [MERCHANT_X],
    );
    expect(x.rowCount).toBe(1);
    expect(x.rows[0]!.brand_id).toBe(BRAND_X);
    expect(x.rows[0]!.connector_instance_id).toBe(CI_SHOPFLO_X);

    const y = await appPool.query<{ brand_id: string }>(
      `SELECT brand_id FROM resolve_shopflo_connector_by_merchant($1)`, [MERCHANT_Y],
    );
    expect(y.rowCount).toBe(1);
    expect(y.rows[0]!.brand_id).toBe(BRAND_Y);
    // The brand is NEVER X for merchant Y — resolution is by the connector row, not a caller hint.
    expect(y.rows[0]!.brand_id).not.toBe(BRAND_X);
  });
});

describe('I2: unknown / disconnected merchant_id → zero rows (handler would 401)', () => {
  it('unknown merchant resolves to zero rows', async () => {
    if (!infraAvailable) return;
    await assertBrainApp(appPool);
    const r = await appPool.query(`SELECT * FROM resolve_shopflo_connector_by_merchant($1)`, ['merchant_does_not_exist']);
    expect(r.rowCount).toBe(0);
  });
  it('a disconnected connector resolves to zero rows (status=connected filter)', async () => {
    if (!infraAvailable) return;
    await assertBrainApp(appPool);
    const r = await appPool.query(`SELECT * FROM resolve_shopflo_connector_by_merchant($1)`, [MERCHANT_DISCONNECTED]);
    expect(r.rowCount).toBe(0);
  });
});

describe('I3/I4: enumeration seam + FORCE-RLS fail-closed', () => {
  it('list_gokwik_connectors() enumerates connected gokwik connectors (no GUC)', async () => {
    if (!infraAvailable) return;
    await assertBrainApp(appPool);
    const r = await appPool.query<{ brand_id: string; gokwik_appid: string }>(
      `SELECT brand_id, gokwik_appid FROM list_gokwik_connectors() WHERE brand_id = $1`, [BRAND_X],
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0]!.brand_id).toBe(BRAND_X);
    expect(r.rows[0]!.gokwik_appid).toBe('appid_X');
  });
  it('direct SELECT on connector_instance under brain_app WITHOUT a GUC returns ZERO rows (FORCE-RLS fail-closed)', async () => {
    if (!infraAvailable) return;
    await assertBrainApp(appPool);
    // No app.current_brand_id GUC set → two-arg current_setting → NULL → RLS denies all rows.
    const r = await appPool.query(
      `SELECT id FROM connector_instance WHERE id = $1`, [CI_SHOPFLO_X],
    );
    expect(r.rowCount).toBe(0);   // proves the SECURITY DEFINER fn is the ONLY enumeration path
  });
});
