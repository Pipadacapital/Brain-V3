/**
 * journey-stitch-from-identity.live.test.ts — GAP-1 stitch-derivation proof (live PG, faked Silver).
 *
 * Proves the identity-graph fallback that completes the anon→customer bridge: given an `identify`-
 * created link (anon_id → the customer's brain_id) and an order resolved to that same brain_id, the
 * job writes the stitch row (order → raw anon → brain_id) that lets silver_touchpoint stitch.
 *
 * Seeds real PG (customer + identity_link anon_id + realized_revenue_ledger order) and injects a fake
 * Silver pool (the raw anons) — the job reads anons from Silver, hashes them with the SAME salt as the
 * resolver, joins identity_link → brain_id → orders, and upserts connector_journey_stitch_map.
 *
 * Asserts: (1) a 1:1 anon↔customer stitches; (2) an AMBIGUOUS customer (2 anons) is SKIPPED (never
 * guessed); (3) idempotent re-run. Skips cleanly when Postgres is unavailable.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { hashIdentifier, normalizeIdentifier, resolveSaltHex } from '@brain/identity-core';
import { SaltProvider, LocalSecretsProvider } from '../infrastructure/secrets/SaltProvider.js';
import { runJourneyStitchFromIdentity } from '../jobs/journey-stitch-from-identity.js';

const SUPER_URL = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const APP_URL = process.env['BRAIN_APP_DATABASE_URL'] ?? 'postgres://brain_app:brain_app@localhost:5432/brain';

const BRAND = 'fffff111-1de7-0111-0111-00000000face';
const brainOk = '11111111-1111-4111-8111-000000000aaa'; // 1:1 customer (stitches)
const brainAmbig = '22222222-2222-4222-8222-000000000bbb'; // 2 anons (skipped)
const anonOk = `anon-ok-${randomUUID()}`;
const anonAmbig1 = `anon-ambig1-${randomUUID()}`;
const anonAmbig2 = `anon-ambig2-${randomUUID()}`;
const orderOk = `order-stitch-ok-${randomUUID()}`;
const orderAmbig = `order-stitch-ambig-${randomUUID()}`;

let superPool: pg.Pool;
let appPool: pg.Pool;
let saltProvider: SaltProvider;
let available = false;

async function linkAnon(brainId: string, rawAnon: string, saltHex: string): Promise<void> {
  const hash = hashIdentifier(normalizeIdentifier(rawAnon, 'external_id'), 'external_id', saltHex);
  await superPool.query(
    `INSERT INTO identity.identity_link (brand_id, link_id, brain_id, identifier_type, identifier_value, tier, is_active)
     VALUES ($1,$2,$3,'anon_id',$4,'medium',TRUE) ON CONFLICT DO NOTHING`,
    [BRAND, randomUUID(), brainId, hash],
  );
}

async function seedOrder(orderId: string, brainId: string): Promise<void> {
  const now = new Date().toISOString();
  await superPool.query(
    `INSERT INTO billing.realized_revenue_ledger
       (brand_id, ledger_event_id, order_id, brain_id, event_type, amount_minor, currency_code,
        rounding_adjustment_minor, occurred_at, occurred_date, economic_effective_at,
        billing_posted_period, recognition_label)
     VALUES ($1,$2,$3,$4,'provisional_recognition',50000,'INR',0,$5,(timezone('UTC',$5::timestamptz))::date,$5,
             to_char(now(),'YYYY-MM'),'provisional') ON CONFLICT DO NOTHING`,
    [BRAND, randomUUID(), orderId, brainId, now],
  );
}

beforeAll(async () => {
  try {
    superPool = new pg.Pool({ connectionString: SUPER_URL, max: 2 });
    appPool = new pg.Pool({ connectionString: APP_URL, max: 3 });
    saltProvider = new SaltProvider(new LocalSecretsProvider(), resolveSaltHex);
    const saltHex = await saltProvider.saltHexForBrand(BRAND);

    const org = await superPool.query<{ id: string }>(`SELECT id FROM tenancy.organization LIMIT 1`);
    const orgId = org.rows[0]?.id;
    if (!orgId) { available = false; return; }
    await superPool.query(
      `INSERT INTO tenancy.brand (id, organization_id, display_name, currency_code, status)
       VALUES ($1,$2,'Stitch-From-Identity Test','INR','active')
       ON CONFLICT (id) DO UPDATE SET status='active'`,
      [BRAND, orgId],
    );
    for (const b of [brainOk, brainAmbig]) {
      await superPool.query(
        `INSERT INTO identity.customer (brand_id, brain_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [BRAND, b],
      );
    }
    // 1:1 customer: one anon. Ambiguous customer: two anons.
    await linkAnon(brainOk, anonOk, saltHex);
    await linkAnon(brainAmbig, anonAmbig1, saltHex);
    await linkAnon(brainAmbig, anonAmbig2, saltHex);
    await seedOrder(orderOk, brainOk);
    await seedOrder(orderAmbig, brainAmbig);
    available = true;
  } catch {
    available = false;
  }
});

afterAll(async () => {
  if (superPool) {
    await superPool.query(`DELETE FROM connectors.connector_journey_stitch_map WHERE brand_id=$1`, [BRAND]).catch(() => {});
    await superPool.query(`DELETE FROM billing.realized_revenue_ledger WHERE brand_id=$1`, [BRAND]).catch(() => {});
    await superPool.query(`DELETE FROM identity.identity_link WHERE brand_id=$1`, [BRAND]).catch(() => {});
    await superPool.query(`DELETE FROM identity.customer WHERE brand_id=$1`, [BRAND]).catch(() => {});
    await superPool.query(`DELETE FROM tenancy.brand WHERE id=$1`, [BRAND]).catch(() => {});
    await superPool.end().catch(() => {});
  }
  await appPool?.end().catch(() => {});
});

/** Fake Silver pool returning the three seeded raw anons for this brand. */
function fakeSilver() {
  return {
    query: async (_sql: string, _params?: unknown[]): Promise<[unknown[], unknown]> => [
      [{ brain_anon_id: anonOk }, { brain_anon_id: anonAmbig1 }, { brain_anon_id: anonAmbig2 }],
      null,
    ],
    end: async () => {},
  };
}

describe('journey-stitch-from-identity (live PG)', () => {
  it('stitches a 1:1 anon↔customer order and SKIPS the ambiguous (2-anon) customer', async () => {
    if (!available) { console.warn('[skip] Postgres unavailable'); return; }
    const res = await runJourneyStitchFromIdentity({ pool: appPool, srPool: fakeSilver(), saltProvider });
    expect(res.errors).toBe(0);

    const ok = await superPool.query(
      `SELECT stitched_anon_id, brain_id FROM connectors.connector_journey_stitch_map WHERE brand_id=$1 AND order_id=$2`,
      [BRAND, orderOk],
    );
    expect(ok.rowCount, '1:1 order must stitch').toBe(1);
    expect(ok.rows[0]!.stitched_anon_id).toBe(anonOk);
    expect(ok.rows[0]!.brain_id).toBe(brainOk);

    const ambig = await superPool.query(
      `SELECT 1 FROM connectors.connector_journey_stitch_map WHERE brand_id=$1 AND order_id=$2`,
      [BRAND, orderAmbig],
    );
    expect(ambig.rowCount, 'ambiguous (2-anon) customer must NOT stitch').toBe(0);
    expect(res.ambiguousSkipped).toBeGreaterThanOrEqual(1);
  });

  it('is idempotent — a re-run leaves the same single stitch row', async () => {
    if (!available) return;
    await runJourneyStitchFromIdentity({ pool: appPool, srPool: fakeSilver(), saltProvider });
    const ok = await superPool.query(
      `SELECT count(*)::int AS n FROM connectors.connector_journey_stitch_map WHERE brand_id=$1 AND order_id=$2`,
      [BRAND, orderOk],
    );
    expect(ok.rows[0]!.n).toBe(1);
  });
});
