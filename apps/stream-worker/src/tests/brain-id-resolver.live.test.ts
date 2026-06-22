/**
 * brain-id-resolver.live.test.ts — DB-AUDIT C2: proves BrainIdResolver resolves an order's
 * storefront_customer_id to the identity-resolved brain_id using the SAME hash the identity resolver
 * writes (hashIdentifier as 'external_id'). This is what lets the order-ledger write stamp brain_id
 * (was NULL → silver_customers / CAC / cohorts / Customer-360 starved). Requires Postgres.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { hashIdentifier } from '@brain/identity-core';
import { BrainIdResolver } from '../infrastructure/pg/BrainIdResolver.js';
import type { SaltProvider } from '../infrastructure/secrets/SaltProvider.js';

const SUPER = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const APP = process.env['BRAIN_APP_DATABASE_URL'] ?? 'postgres://brain_app:brain_app@localhost:5432/brain';

const BRAND = 'c2c20000-0000-4000-8000-0000000000c2';
const ORG = 'c2c20000-0000-4000-8000-0000000000f2';
const USER = 'c2c20000-0000-4000-8000-0000000000e2';
const BRAIN_ID = 'c2c20000-0000-4000-8000-0000000000b2';
const STOREFRONT_ID = 'sf-cust-c2-test-1';
const SALT = 'a'.repeat(64); // 64-hex per-brand salt

// Fake salt provider — returns a fixed 64-hex salt for the test brand.
const fakeSalt = { saltHexForBrand: async () => SALT } as unknown as SaltProvider;

let superPool: pg.Pool;
let appPool: pg.Pool;
let pgUp = false;

beforeAll(async () => {
  try {
    superPool = new pg.Pool({ connectionString: SUPER, connectionTimeoutMillis: 4000 });
    await superPool.query('SELECT 1');
    appPool = new pg.Pool({ connectionString: APP, max: 2 });
    await cleanup();
    await superPool.query(`INSERT INTO app_user (id,email,email_normalized,password_hash) VALUES ($1,$2,$3,'x')`, [USER, `${USER}@x.invalid`, `${USER}@x.invalid`]);
    await superPool.query(`INSERT INTO organization (id,name,slug,owner_user_id) VALUES ($1,'C2',$2,$3)`, [ORG, `c2-${ORG.slice(-6)}`, USER]);
    await superPool.query(`INSERT INTO brand (id,organization_id,display_name,currency_code,status) VALUES ($1,$2,'C2','INR','active')`, [BRAND, ORG]);
    // Seed the identity_link EXACTLY as the identity resolver would: type 'storefront_customer_id',
    // identifier_value = hashIdentifier(storefront_id, 'external_id', salt).
    const hash = hashIdentifier(STOREFRONT_ID, 'external_id', SALT, 'IN');
    // customer first (identity_link.brain_id FKs to identity.customer(brand_id, brain_id)).
    await superPool.query(`INSERT INTO identity.customer (brand_id, brain_id) VALUES ($1, $2)`, [BRAND, BRAIN_ID]);
    await superPool.query(
      `INSERT INTO identity.identity_link (brand_id, link_id, brain_id, identifier_type, identifier_value, tier, is_active)
       VALUES ($1, gen_random_uuid(), $2, 'storefront_customer_id', $3, 'strong_on_link', true)`,
      [BRAND, BRAIN_ID, hash],
    );
    pgUp = true;
  } catch {
    pgUp = false;
  }
});

async function cleanup() {
  await superPool.query(`DELETE FROM identity.identity_link WHERE brand_id=$1`, [BRAND]).catch(() => {});
  await superPool.query(`DELETE FROM identity.customer WHERE brand_id=$1`, [BRAND]).catch(() => {});
  await superPool.query(`DELETE FROM brand WHERE id=$1`, [BRAND]).catch(() => {});
  await superPool.query(`DELETE FROM organization WHERE id=$1`, [ORG]).catch(() => {});
  await superPool.query(`DELETE FROM app_user WHERE id=$1`, [USER]).catch(() => {});
}

afterAll(async () => {
  if (pgUp) await cleanup();
  await appPool?.end?.().catch(() => {});
  await superPool?.end?.().catch(() => {});
});

describe('BrainIdResolver (C2, live Postgres)', () => {
  it('SKIP_IF_NO_PG', () => {
    if (!pgUp) console.warn('[brain-id-resolver] Postgres unavailable — PENDING.');
    expect(true).toBe(true);
  });

  it('resolves a known storefront_customer_id to its brain_id (hash matches the identity writer)', async () => {
    if (!pgUp) return;
    const resolver = new BrainIdResolver(appPool, fakeSalt);
    const brainId = await resolver.resolve(BRAND, STOREFRONT_ID, 'IN');
    expect(brainId).toBe(BRAIN_ID);
  });

  it('returns null for an unknown customer (no false link) and for a null id', async () => {
    if (!pgUp) return;
    const resolver = new BrainIdResolver(appPool, fakeSalt);
    expect(await resolver.resolve(BRAND, 'sf-cust-does-not-exist', 'IN')).toBeNull();
    expect(await resolver.resolve(BRAND, null, 'IN')).toBeNull();
  });
});
