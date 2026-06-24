/**
 * journey-stitch-from-identity.live.test.ts — GAP-1 stitch-derivation proof (live PG brand + connector
 * stitch map; lakehouse reads mocked).
 *
 * MEDALLION REALIGNMENT (Epic 3 / ADR-0004): the job now reads anons from silver_touchpoint, anon→brain_id
 * from silver_identity_link (Neo4j→StarRocks export), and order→brain_id from gold_revenue_ledger — all
 * via the StarRocks pool (no PG identity / no PG realized_revenue_ledger). It writes the stitch row to
 * connectors.connector_journey_stitch_map (PG, kept). This test mocks the three lakehouse reads and
 * asserts: (1) a 1:1 anon↔customer stitches; (2) an AMBIGUOUS customer (2 anons) is SKIPPED; (3) idempotent.
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
let saltHex: string;
let available = false;

beforeAll(async () => {
  try {
    superPool = new pg.Pool({ connectionString: SUPER_URL, max: 2 });
    appPool = new pg.Pool({ connectionString: APP_URL, max: 3 });
    saltProvider = new SaltProvider(new LocalSecretsProvider(), resolveSaltHex);
    saltHex = await saltProvider.saltHexForBrand(BRAND);

    const org = await superPool.query<{ id: string }>(`SELECT id FROM tenancy.organization LIMIT 1`);
    const orgId = org.rows[0]?.id;
    if (!orgId) { available = false; return; }
    await superPool.query(
      `INSERT INTO tenancy.brand (id, organization_id, display_name, currency_code, status)
       VALUES ($1,$2,'Stitch-From-Identity Test','INR','active')
       ON CONFLICT (id) DO UPDATE SET status='active'`,
      [BRAND, orgId],
    );
    available = true;
  } catch {
    available = false;
  }
});

afterAll(async () => {
  if (superPool) {
    await superPool.query(`DELETE FROM connectors.connector_journey_stitch_map WHERE brand_id=$1`, [BRAND]).catch(() => {});
    await superPool.query(`DELETE FROM tenancy.brand WHERE id=$1`, [BRAND]).catch(() => {});
    await superPool.end().catch(() => {});
  }
  await appPool?.end().catch(() => {});
});

/** anon→hash (the SAME normalization+hash the job applies). */
function anonHash(rawAnon: string): string {
  return hashIdentifier(normalizeIdentifier(rawAnon, 'external_id'), 'external_id', saltHex);
}

/**
 * Fake StarRocks pool serving the job's THREE lakehouse reads by SQL shape:
 *   silver_touchpoint → the raw anons; silver_identity_link → anon-hash→brain_id; gold ledger → order→brain_id.
 */
function fakeSilver() {
  return {
    query: async (sql: string): Promise<[unknown[], unknown]> => {
      const text = String(sql);
      if (text.includes('silver_touchpoint')) {
        return [[{ brain_anon_id: anonOk }, { brain_anon_id: anonAmbig1 }, { brain_anon_id: anonAmbig2 }], null];
      }
      if (text.includes('silver_identity_link')) {
        return [[
          { identifier_value: anonHash(anonOk), brain_id: brainOk },
          { identifier_value: anonHash(anonAmbig1), brain_id: brainAmbig },
          { identifier_value: anonHash(anonAmbig2), brain_id: brainAmbig },
        ], null];
      }
      if (text.includes('gold_revenue_ledger')) {
        return [[
          { order_id: orderOk, brain_id: brainOk },
          { order_id: orderAmbig, brain_id: brainAmbig },
        ], null];
      }
      return [[], null];
    },
    end: async () => {},
  };
}

describe('journey-stitch-from-identity (lakehouse)', () => {
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
