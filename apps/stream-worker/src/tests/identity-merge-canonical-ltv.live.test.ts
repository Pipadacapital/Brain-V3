/**
 * identity-merge-canonical-ltv.live.test.ts — F2 acceptance (alias-resolve → canonical LTV).
 *
 * THE BUG (F2): after a MERGE, the merged Customer is tombstoned + ALIAS_OF→canonical, but its
 * IDENTIFIES edges are NOT re-pointed. Pre-fix, readState returned the DEAD (merged-away) brain_id and
 * the identity export projected that dead brain_id into ops.silver_identity_link, so the merged
 * customer's orders rolled up under their OWN brain_id — LTV split across the merge boundary, defeating
 * the merge.
 *
 * THE FIX (end-to-end, alias-resolved & consistent):
 *   1. Neo4jIdentityRepository.readState follows the live ALIAS_OF chain → returns the CANONICAL brain_id.
 *   2. identity-export projects the CANONICAL brain_id into ops.silver_identity_link.brain_id; keeps
 *      merged_into on ops.silver_customer_identity.
 *   3. The Spark order/revenue readers fold merged_into → canonical (defensive single-hop net), then the
 *      silver_customer roll-up groups orders under the single canonical brain_id.
 *
 * THIS TEST drives the REAL resolver against live Neo4j + PG, merges two customers that EACH have one
 * order, then asserts: (a) readState resolves BOTH identifier sets to the canonical; (b) the export
 * projects canonical into ops.silver_identity_link + merged_into into ops.silver_customer_identity; and
 * (c) the silver_order_state identity-join + silver_customer roll-up (reproduced here in PG, byte-for-byte
 * the Spark `_read_identity_link` fold + groupBy) yields ONE customer row, lifetime_orders=2,
 * lifetime_value = sum of the two orders.
 *
 * REQUIRES: Neo4j on bolt://localhost:7687 + Postgres on localhost:5432 (skips PENDING otherwise).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import neo4j, { type Driver } from 'neo4j-driver';
import { Neo4jIdentityRepository } from '../infrastructure/neo4j/Neo4jIdentityRepository.js';
import { IdentityResolver, type ExtractedIdentifier } from '../domain/identity/IdentityResolver.js';

// runIdentityExport is imported DYNAMICALLY in beforeAll (same pattern as phone-guard-reeval):
// the job module resolves NEO4J_* / BRAIN_APP_DATABASE_URL via the memoized loadStreamWorkerConfig()
// AT IMPORT TIME, and the config default for NEO4J_PASSWORD ('neo4j') differs from the local stack's
// ('brain_neo4j', this test's fallback). A static import would freeze the job onto the wrong
// credentials whenever the env vars are unset → Neo.ClientError.Security.Unauthorized in step 2.
let runIdentityExport: (typeof import('../jobs/identity-export/run.js'))['runIdentityExport'];

const PG_SUPER = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const PG_APP = process.env['BRAIN_APP_DATABASE_URL'] ?? 'postgres://brain_app:brain_app@localhost:5432/brain';
const NEO4J_URI = process.env['NEO4J_URI'] ?? 'bolt://localhost:7687';
const NEO4J_USER = process.env['NEO4J_USER'] ?? 'neo4j';
const NEO4J_PASSWORD = process.env['NEO4J_PASSWORD'] ?? 'brain_neo4j';

const BRAND = 'c9990033-0033-0033-0033-000000000001';
const ORG_ID = 'd9990033-0033-0033-0033-000000000001';
const USER_ID = 'e9990033-0033-0033-0033-000000000001';

// Two orders, one per (soon-to-be-merged) customer. Money is bigint minor units.
const ORDER_A_VALUE = 1000n;
const ORDER_B_VALUE = 2500n;

/** 64-hex test hash from a small seed (a pre-hashed identifier value). */
function hex(seed: number): string {
  return seed.toString(16).padStart(64, '0');
}
/** A STRONG pre_hashed_email identifier (the connector-pre-hashed namespace the order-join reads). */
function preHashedEmail(seed: number): ExtractedIdentifier {
  return { type: 'pre_hashed_email', hash: hex(seed), tier: 'strong', confidence: 'high', preHashed: true };
}

const EMAIL_A = hex(0x5101);
const EMAIL_B = hex(0x5202);

let superPool: pg.Pool;
let repo: Neo4jIdentityRepository;
let driver: Driver;
let available = false;
const resolver = new IdentityResolver();

/** readState → resolve → writeOutcome (mirrors ResolveIdentityUseCase), returns the outcome. */
async function drive(identifiers: ExtractedIdentifier[]) {
  const idHashes = identifiers.map((i) => ({ type: i.type, hash: i.hash }));
  const st = await repo.readState(BRAND, idHashes);
  const outcome = resolver.resolve(
    BRAND, identifiers, st.existingLinks, st.sharedUtilityMap, st.phoneCount, st.brandConfig, st.aliasChain,
  );
  await repo.writeOutcome(BRAND, outcome, identifiers);
  return outcome;
}

let canonical = '';
let merged = '';

beforeAll(async () => {
  try {
    superPool = new pg.Pool({ connectionString: PG_SUPER, connectionTimeoutMillis: 4000 });
    await superPool.query('SELECT 1');
    driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
    await driver.getServerInfo();
    // The export job reads NEO4J_* / BRAIN_APP_DATABASE_URL at import; set them BEFORE the dynamic
    // import so the job connects to the SAME graph + PG this test writes its fixture into.
    process.env['NEO4J_URI'] = NEO4J_URI;
    process.env['NEO4J_USER'] = NEO4J_USER;
    process.env['NEO4J_PASSWORD'] = NEO4J_PASSWORD;
    process.env['BRAIN_APP_DATABASE_URL'] = PG_APP;
    ({ runIdentityExport } = await import('../jobs/identity-export/run.js'));
    repo = new Neo4jIdentityRepository(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD, PG_APP);
    await repo.bootstrap();
    await repo.purgeBrand(BRAND);

    await superPool.query(`INSERT INTO app_user (id,email,email_normalized,password_hash) VALUES ($1,'f2-ltv@x.invalid','f2-ltv@x.invalid','x') ON CONFLICT DO NOTHING`, [USER_ID]);
    await superPool.query(`INSERT INTO organization (id,name,slug,owner_user_id) VALUES ($1,'F2 LTV Org','f2-ltv-org',$2) ON CONFLICT DO NOTHING`, [ORG_ID, USER_ID]);
    await superPool.query(`INSERT INTO brand (id,organization_id,display_name,currency_code) VALUES ($1,$2,'F2 LTV Brand','INR') ON CONFLICT DO NOTHING`, [BRAND, ORG_ID]);
    await superPool.query(`DELETE FROM identity_audit WHERE brand_id = $1`, [BRAND]).catch(() => {});
    // Start the export projections clean for this brand (incremental export will re-fill them).
    await superPool.query(`DELETE FROM ops.silver_identity_link WHERE brand_id = $1`, [BRAND]).catch(() => {});
    await superPool.query(`DELETE FROM ops.silver_customer_identity WHERE brand_id = $1`, [BRAND]).catch(() => {});
    available = true;
  } catch (e) {
    available = false;
    console.warn('[identity-merge-canonical-ltv] Neo4j/PG unavailable — PENDING.', (e as Error).message);
  }
});

afterAll(async () => {
  if (available) {
    await repo.purgeBrand(BRAND).catch(() => {});
    await superPool.query(`DELETE FROM ops.silver_identity_link WHERE brand_id = $1`, [BRAND]).catch(() => {});
    await superPool.query(`DELETE FROM ops.silver_customer_identity WHERE brand_id = $1`, [BRAND]).catch(() => {});
    await superPool.query(`DELETE FROM identity_audit WHERE brand_id = $1`, [BRAND]).catch(() => {});
    await superPool.query(`DELETE FROM brand WHERE id = $1`, [BRAND]).catch(() => {});
    await superPool.query(`DELETE FROM organization WHERE id = $1`, [ORG_ID]).catch(() => {});
    await superPool.query(`DELETE FROM app_user WHERE id = $1`, [USER_ID]).catch(() => {});
  }
  if (repo) await repo.end().catch(() => {});
  if (driver) await driver.close().catch(() => {});
  if (superPool) await superPool.end();
});

describe('F2 — merge consolidates downstream identity + LTV (alias-resolve, end-to-end)', () => {
  it('SKIP_IF_UNAVAILABLE', () => {
    if (!available) console.warn('[identity-merge-canonical-ltv] PENDING.');
    expect(true).toBe(true);
  });

  it('mints two customers (one order each), then merges them → canonical/merged established', async () => {
    if (!available) return;
    const a = await drive([preHashedEmail(0x5101)]); // customer A (its order joins by EMAIL_A)
    const b = await drive([preHashedEmail(0x5202)]); // customer B (its order joins by EMAIL_B)
    expect(a.action).toBe('minted');
    expect(b.action).toBe('minted');
    canonical = a.brainId < b.brainId ? a.brainId : b.brainId;
    merged = a.brainId < b.brainId ? b.brainId : a.brainId;

    const o = await drive([preHashedEmail(0x5101), preHashedEmail(0x5202)]); // spanning event → merge
    expect(o.action).toBe('merged');
    expect(o.brainId).toBe(canonical);
    expect(canonical).not.toBe(merged);
  });

  it('1. readState ALIAS-RESOLVES both identifier sets to the CANONICAL brain_id', async () => {
    if (!available) return;
    const stA = await repo.readState(BRAND, [{ type: 'pre_hashed_email', hash: EMAIL_A }]);
    const stB = await repo.readState(BRAND, [{ type: 'pre_hashed_email', hash: EMAIL_B }]);
    // BOTH the canonical-side and the merged-side identifier now resolve to the canonical (not the dead alias).
    expect(stA.existingLinks.map((l) => l.brain_id)).toEqual([canonical]);
    expect(stB.existingLinks.map((l) => l.brain_id)).toEqual([canonical]);
  });

  it('2. identity-export projects CANONICAL into silver_identity_link + merged_into into silver_customer_identity', async () => {
    if (!available) return;
    await runIdentityExport();

    const links = await superPool.query<{ identifier_value: string; brain_id: string }>(
      `SELECT identifier_value, brain_id::text AS brain_id FROM ops.silver_identity_link
       WHERE brand_id = $1 AND identifier_type = 'pre_hashed_email' AND identifier_value = ANY($2)`,
      [BRAND, [EMAIL_A, EMAIL_B]],
    );
    const byHash = Object.fromEntries(links.rows.map((r) => [r.identifier_value, r.brain_id]));
    // Both email hashes — including the merged customer's — now map to the canonical brain_id.
    expect(byHash[EMAIL_A]).toBe(canonical);
    expect(byHash[EMAIL_B]).toBe(canonical);

    const mc = await superPool.query<{ lifecycle_state: string; merged_into: string | null }>(
      `SELECT lifecycle_state, merged_into::text AS merged_into FROM ops.silver_customer_identity
       WHERE brand_id = $1 AND brain_id = $2`,
      [BRAND, merged],
    );
    expect(mc.rows[0]?.lifecycle_state).toBe('merged');
    expect(mc.rows[0]?.merged_into).toBe(canonical);
  });

  it('3. silver_order_state join + silver_customer roll-up → ONE row, lifetime_orders=2, value=sum', async () => {
    if (!available) return;
    // Reproduce the Spark chain in PG exactly:
    //   - link CTE = silver_order_state._read_identity_link (canonical export + defensive merged_into fold)
    //   - the orders→link join = silver_order_state's identity_join (order brain_id = canonical)
    //   - GROUP BY brain_id = silver_customer's order_rollup (lifetime_orders / lifetime_value)
    const rollup = await superPool.query<{ brain_id: string; lifetime_orders: string; lifetime_value: string }>(
      `WITH orders(order_id, hashed_email, order_value_minor) AS (
         VALUES ('o-A', $2::text, $3::bigint), ('o-B', $4::text, $5::bigint)
       ),
       link AS (
         SELECT l.identifier_value AS hashed_email,
                MIN(COALESCE(c.merged_into, l.brain_id)::text) AS brain_id
         FROM ops.silver_identity_link l
         LEFT JOIN ops.silver_customer_identity c
           ON c.brand_id = l.brand_id AND c.brain_id = l.brain_id
         WHERE l.brand_id = $1 AND l.identifier_type = 'pre_hashed_email'
           AND l.is_active = true AND l.brain_id IS NOT NULL
         GROUP BY l.identifier_value
       )
       SELECT b.brain_id::text AS brain_id,
              COUNT(*)::text AS lifetime_orders,
              SUM(o.order_value_minor)::text AS lifetime_value
       FROM orders o
       JOIN link b ON b.hashed_email = o.hashed_email
       GROUP BY b.brain_id`,
      [BRAND, EMAIL_A, ORDER_A_VALUE.toString(), EMAIL_B, ORDER_B_VALUE.toString()],
    );

    // The merge is consolidated: ONE canonical customer, both orders, summed LTV (no boundary split).
    expect(rollup.rows.length).toBe(1);
    expect(rollup.rows[0]?.brain_id).toBe(canonical);
    expect(rollup.rows[0]?.lifetime_orders).toBe('2');
    expect(rollup.rows[0]?.lifetime_value).toBe((ORDER_A_VALUE + ORDER_B_VALUE).toString());
  });
});
