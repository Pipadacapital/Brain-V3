/**
 * meta-token-refresh.live.test.ts — the full enumerate→read→exchange→write loop (live Postgres).
 *   MT1: a DUE meta token is re-exchanged and the new token + issued_at are written back.
 *   MT2: a NOT-DUE (recently issued) token is skipped (no exchange call).
 *   MT3: an exchange FAILURE (dead token) → reconnectRequired + sync_status='error'.
 * REQUIRES Postgres. App creds set via env so the exchange proceeds.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { runMetaTokenRefresh } from '../jobs/meta-token-refresh/run.js';

const SUPER = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const APP = process.env['BRAIN_APP_DATABASE_URL'] ?? 'postgres://brain_app:brain_app@localhost:5432/brain';

const BRAND = 'a3b70001-0a11-4a11-8a11-00000000aa01';
const ORG = 'a3b70001-0a11-4a11-8a11-00000000ff01';
const USER = 'a3b70001-0a11-4a11-8a11-00000000ee01';
const CI = 'a3b70001-0a11-4a11-8a11-00000000c101';
const SECRET_NAME = 'brain/connector/meta/a3b70001-token-refresh';
const NOW = Date.parse('2026-06-20T00:00:00Z');
const daysAgo = (n: number) => new Date(NOW - n * 86400000).toISOString();

let superPool: pg.Pool;
let appPool: pg.Pool;
let pgAvailable = false;

const okFetch = (newToken: string): typeof fetch =>
  (async () => new Response(JSON.stringify({ access_token: newToken, expires_in: 5184000 }), { status: 200 })) as unknown as typeof fetch;
const deadFetch: typeof fetch =
  (async () => new Response(JSON.stringify({ error: { code: 190 } }), { status: 400 })) as unknown as typeof fetch;

async function setBundle(issuedAt: string | null) {
  const bundle: Record<string, string> = { access_token: 'OLD-TOKEN', ad_account_id: 'act_tr' };
  if (issuedAt) bundle['access_token_issued_at'] = issuedAt;
  await superPool.query(
    `INSERT INTO dev_secret (name, secret_value) VALUES ($1,$2) ON CONFLICT (name) DO UPDATE SET secret_value=EXCLUDED.secret_value`,
    [SECRET_NAME, JSON.stringify(bundle)],
  );
}
async function getBundle(): Promise<{ access_token: string; access_token_issued_at?: string }> {
  const r = await superPool.query<{ secret_value: string }>(`SELECT secret_value FROM dev_secret WHERE name=$1`, [SECRET_NAME]);
  return JSON.parse(r.rows[0]!.secret_value);
}
async function syncState(): Promise<string | null> {
  const r = await superPool.query<{ state: string }>(`SELECT state FROM connector_sync_status WHERE connector_instance_id=$1`, [CI]);
  return r.rows[0]?.state ?? null;
}

async function cleanup() {
  await superPool.query(`DELETE FROM connector_sync_status WHERE connector_instance_id=$1`, [CI]).catch(() => {});
  await superPool.query(`DELETE FROM connector_instance WHERE id=$1`, [CI]).catch(() => {});
  await superPool.query(`DELETE FROM dev_secret WHERE name=$1`, [SECRET_NAME]).catch(() => {});
  await superPool.query(`DELETE FROM brand WHERE id=$1`, [BRAND]).catch(() => {});
  await superPool.query(`DELETE FROM organization WHERE id=$1`, [ORG]).catch(() => {});
  await superPool.query(`DELETE FROM app_user WHERE id=$1`, [USER]).catch(() => {});
}

beforeAll(async () => {
  try {
    superPool = new pg.Pool({ connectionString: SUPER, connectionTimeoutMillis: 4000, max: 3 });
    await superPool.query('SELECT 1');
    appPool = new pg.Pool({ connectionString: APP, max: 3 });
    await cleanup();
    await superPool.query(`INSERT INTO app_user (id,email,email_normalized,password_hash) VALUES ($1,$2,$3,'x')`, [USER, `${USER}@x.invalid`, `${USER}@x.invalid`]);
    await superPool.query(`INSERT INTO organization (id,name,slug,owner_user_id) VALUES ($1,'TR',$2,$3)`, [ORG, `tr-${ORG.slice(-6)}`, USER]);
    await superPool.query(`INSERT INTO brand (id,organization_id,display_name,currency_code,status) VALUES ($1,$2,'TR','INR','active')`, [BRAND, ORG]);
    // activated_at set: the 0106 activation gate means list_ad_connectors_for_spend_repull()
    // (the job's enumeration fn) only returns ACTIVATED ad accounts — an un-activated fixture
    // is invisible to the job and every assertion below would starve.
    await superPool.query(
      `INSERT INTO connector_instance (id,brand_id,provider,status,shop_domain,secret_ref,ad_account_id,activated_at) VALUES ($1,$2,'meta','connected','',$3,'act_tr',NOW())`,
      [CI, BRAND, SECRET_NAME],
    );
    // The connect flow seeds a sync_status row; setSyncState is UPDATE-only, so seed it here.
    await superPool.query(
      `INSERT INTO connector_sync_status (brand_id, connector_instance_id, state) VALUES ($1,$2,'connected')`,
      [BRAND, CI],
    );
    pgAvailable = true;
  } catch {
    pgAvailable = false;
  }
});

beforeEach(() => {
  process.env['META_APP_ID'] = 'app-id';
  process.env['META_APP_SECRET'] = 'app-secret';
});

afterAll(async () => {
  if (pgAvailable) await cleanup();
  delete process.env['META_APP_ID'];
  delete process.env['META_APP_SECRET'];
  await appPool?.end?.().catch(() => {});
  await superPool?.end?.().catch(() => {});
});

describe('runMetaTokenRefresh (live Postgres)', () => {
  it('SKIP_IF_NO_PG', () => {
    if (!pgAvailable) console.warn('[meta-token-refresh] Postgres unavailable — PENDING.');
    expect(true).toBe(true);
  });

  it('MT1: re-exchanges a DUE token and writes the new token + issued_at back', async () => {
    if (!pgAvailable) return;
    await setBundle(daysAgo(45)); // older than the 30d threshold → due
    // Scoped to the fixture connector (last arg): a dirty dev DB has REAL activated meta
    // connectors — an unscoped pass would fold them into the report counts (assertion noise)
    // AND mutate their sync state / secrets. Invariants asserted are unchanged.
    const report = await runMetaTokenRefresh(appPool, NOW, 30, okFetch('FRESH-TOKEN'), undefined, CI);
    expect(report.refreshed).toBeGreaterThanOrEqual(1);
    const b = await getBundle();
    expect(b.access_token).toBe('FRESH-TOKEN');
    expect(b.access_token_issued_at).toBe(new Date(NOW).toISOString());
  });

  it('MT2: skips a NOT-DUE (recently issued) token — no exchange', async () => {
    if (!pgAvailable) return;
    await setBundle(daysAgo(2)); // newer than threshold → not due
    let called = false;
    const spyFetch: typeof fetch = (async () => { called = true; return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
    const report = await runMetaTokenRefresh(appPool, NOW, 30, spyFetch, undefined, CI);
    expect(report.skippedNotDue).toBeGreaterThanOrEqual(1);
    expect(called).toBe(false);
    expect((await getBundle()).access_token).toBe('OLD-TOKEN'); // unchanged
  });

  it('MT3: a dead token (exchange fails) → reconnectRequired + sync_status=error', async () => {
    if (!pgAvailable) return;
    await setBundle(daysAgo(45));
    await superPool.query(`UPDATE connector_sync_status SET state='connected' WHERE connector_instance_id=$1`, [CI]).catch(() => {});
    const report = await runMetaTokenRefresh(appPool, NOW, 30, deadFetch, undefined, CI);
    expect(report.reconnectRequired).toBeGreaterThanOrEqual(1);
    expect(await syncState()).toBe('error');
    expect((await getBundle()).access_token).toBe('OLD-TOKEN'); // NOT overwritten on failure
  });
});
