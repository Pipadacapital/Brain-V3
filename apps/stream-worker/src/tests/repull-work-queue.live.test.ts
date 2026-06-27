/**
 * repull-work-queue.live.test.ts — P1: the due-time work queue (live Postgres).
 *
 * Proves the claim semantics the parallel scheduler relies on (claim_due_repull_connectors, 0053):
 *   WQ1: two concurrent "replicas" claiming get DISJOINT sets (FOR UPDATE SKIP LOCKED) — no
 *        connector dispatched twice; together they cover all due connectors.
 *   WQ2: a just-claimed connector is NOT re-claimed until its next_repull_at passes (stamped ahead).
 *
 * REQUIRES Postgres with migration 0053.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { claimDueRepullConnectors } from '../jobs/sync-request-claimer/run.js';

const SUPER = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const APP = process.env['BRAIN_APP_DATABASE_URL'] ?? 'postgres://brain_app:brain_app@localhost:5432/brain';

const BRAND = 'a2c30053-0053-4053-8053-0000000000a1';
const ORG = 'a2c30053-0053-4053-8053-0000000000f1';
const USER = 'a2c30053-0053-4053-8053-0000000000e1';
// Six connectors for this brand-less-uniqueness test — connector_instance is UNIQUE per
// (brand_id, provider), so we use distinct brands? No — use one brand with one provider per row is
// impossible (unique). Use SIX brands, one shopify connector each, to get six claimable rows.
const N = 6;

let superPool: pg.Pool;
let appPool: pg.Pool;
let pgAvailable = false;
const ids: { brand: string; org: string; user: string; ci: string }[] = [];

for (let i = 0; i < N; i++) {
  ids.push({
    brand: `a2c30053-0053-4053-8053-0000000000b${i}`, // last group = 12 hex
    org: `a2c30053-0053-4053-8053-0000000000c${i}`,
    user: `a2c30053-0053-4053-8053-0000000000d${i}`,
    ci: `a2c30053-0053-4053-8053-0000000000e${i}`,
  });
}

async function cleanup() {
  for (const x of ids) {
    await superPool.query(`DELETE FROM connector_instance WHERE id=$1`, [x.ci]).catch(() => {});
    await superPool.query(`DELETE FROM brand WHERE id=$1`, [x.brand]).catch(() => {});
    await superPool.query(`DELETE FROM organization WHERE id=$1`, [x.org]).catch(() => {});
    await superPool.query(`DELETE FROM app_user WHERE id=$1`, [x.user]).catch(() => {});
  }
}

beforeAll(async () => {
  try {
    superPool = new pg.Pool({ connectionString: SUPER, connectionTimeoutMillis: 4000 });
    await superPool.query('SELECT 1');
    appPool = new pg.Pool({ connectionString: APP, max: 4 });
    await cleanup();
    for (const x of ids) {
      await superPool.query(`INSERT INTO app_user (id,email,email_normalized,password_hash) VALUES ($1,$2,$3,'x')`, [x.user, `${x.user}@x.invalid`, `${x.user}@x.invalid`]);
      await superPool.query(`INSERT INTO organization (id,name,slug,owner_user_id) VALUES ($1,'WQ',$2,$3)`, [x.org, `wq-${x.org.slice(-6)}`, x.user]);
      await superPool.query(`INSERT INTO brand (id,organization_id,display_name,currency_code,status) VALUES ($1,$2,'WQ','INR','active')`, [x.brand, x.org]);
      // status connected, next_repull_at NULL → immediately due.
      await superPool.query(`INSERT INTO connector_instance (id,brand_id,provider,status,shop_domain,secret_ref) VALUES ($1,$2,'shopify','connected','','')`, [x.ci, x.brand]);
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

const mine = (rows: { connector_instance_id: string }[]) =>
  rows.map((r) => r.connector_instance_id).filter((id) => ids.some((x) => x.ci === id));

describe('repull work-queue claim (P1, live Postgres)', () => {
  it('SKIP_IF_NO_PG', () => {
    if (!pgAvailable) console.warn('[repull-work-queue] Postgres unavailable — PENDING.');
    expect(true).toBe(true);
  });

  it('WQ1: two concurrent replicas claim DISJOINT sets covering all due connectors', async () => {
    if (!pgAvailable) return;
    // Each "replica" claims a batch of 3 concurrently. SKIP LOCKED → no overlap.
    const [a, b] = await Promise.all([
      claimDueRepullConnectors(appPool, 3, 45),
      claimDueRepullConnectors(appPool, 3, 45),
    ]);
    const setA = new Set(mine(a));
    const setB = new Set(mine(b));
    // Disjoint: no connector claimed by both.
    const overlap = [...setA].filter((id) => setB.has(id));
    expect(overlap).toEqual([]);
    // Together they cover all 6 of OUR seeded connectors (other dev connectors may also appear).
    expect(new Set([...setA, ...setB]).size).toBe(N);
  });

  it('WQ2: a just-claimed connector is not re-claimed until next_repull_at passes', async () => {
    if (!pgAvailable) return;
    // After WQ1 stamped all 6 to now()+45s, a fresh claim returns NONE of ours.
    const again = await claimDueRepullConnectors(appPool, 50, 45);
    expect(mine(again)).toEqual([]);
  });

  // WQ3 (0112): a connector stuck in the TERMINAL reconnect-required error state must be BACKED OFF —
  // not re-claimed every interval — while a TRANSIENT-error connector keeps fast-retrying, and a
  // reconnect (clearing the error) makes it immediately claimable again. This is the durable fix for
  // the infinite error-level repull loop a missing/rotated secret used to cause.
  it('WQ3: RECONNECT_REQUIRED connectors are backed off; transient errors and reconnects are not', async () => {
    if (!pgAvailable) return;
    const reconnect = ids[0]!; // terminal RECONNECT_REQUIRED → must be excluded
    const transient = ids[1]!; // transient error → must still be claimed
    const clean = ids[2]!;     // healthy → must still be claimed

    // Make all three due again (WQ1 stamped them ahead).
    for (const x of [reconnect, transient, clean]) {
      await superPool.query(`UPDATE connector_instance SET next_repull_at = NULL WHERE id=$1`, [x.ci]);
    }
    // Seed sync_status: terminal reconnect-required vs a transient blip. clean has no row.
    await superPool.query(
      `INSERT INTO connector_sync_status (id, brand_id, connector_instance_id, state, last_error, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'error', 'shopify token not found — RECONNECT_REQUIRED', now())
       ON CONFLICT (brand_id, connector_instance_id)
         DO UPDATE SET state='error', last_error=EXCLUDED.last_error, updated_at=now()`,
      [reconnect.brand, reconnect.ci],
    );
    await superPool.query(
      `INSERT INTO connector_sync_status (id, brand_id, connector_instance_id, state, last_error, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'error', 'page_error: transient 503', now())
       ON CONFLICT (brand_id, connector_instance_id)
         DO UPDATE SET state='error', last_error=EXCLUDED.last_error, updated_at=now()`,
      [transient.brand, transient.ci],
    );

    const claimed = new Set(mine(await claimDueRepullConnectors(appPool, 50, 45)));
    expect(claimed.has(reconnect.ci)).toBe(false); // backed off
    expect(claimed.has(transient.ci)).toBe(true);  // transient error still fast-retries
    expect(claimed.has(clean.ci)).toBe(true);      // healthy still claimed

    // Reconnect: state→connected, last_error cleared. The connector becomes claimable again immediately
    // (no reset job needed). It's still due (was never claimed above → next_repull_at still NULL).
    await superPool.query(
      `UPDATE connector_sync_status SET state='connected', last_error=NULL, updated_at=now()
         WHERE connector_instance_id=$1`,
      [reconnect.ci],
    );
    const afterReconnect = new Set(mine(await claimDueRepullConnectors(appPool, 50, 45)));
    expect(afterReconnect.has(reconnect.ci)).toBe(true);
  });
});
