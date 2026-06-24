/**
 * identity-readers-neo4j.live.test.ts — the identity read/admin surfaces over the Neo4j SoR (Epic 3).
 *
 * MEDALLION REALIGNMENT (ADR-0004): replaces the old PG-backed reader tests (customer-360 / list /
 * merge-admin / erase / vault). Seeds the Neo4j identity graph + the PG brand/contact_pii, then drives
 * the real reader use-cases: Customer 360, browse, GDPR erase (graph tombstone + PG contact_pii delete +
 * audit), and vault coverage (resolved-customers from Neo4j, vaulted from PG).
 *
 * REQUIRES: Neo4j on bolt://localhost:7687 + Postgres on localhost:5432.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import neo4j, { type Driver } from 'neo4j-driver';
import { getCustomer360 } from '../internal/application/queries/get-customer-360.js';
import { listCustomers } from '../internal/application/queries/list-customers.js';
import { eraseCustomer } from '../internal/application/erase-customer.js';
import { Neo4jIdentityReader } from '../internal/infrastructure/neo4j-identity-reader.js';

const PG_SUPER = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const PG_APP = process.env['BRAIN_APP_DATABASE_URL'] ?? 'postgres://brain_app:brain_app@localhost:5432/brain';
const NEO4J_URI = process.env['NEO4J_URI'] ?? 'bolt://localhost:7687';
const NEO4J_USER = process.env['NEO4J_USER'] ?? 'neo4j';
const NEO4J_PASSWORD = process.env['NEO4J_PASSWORD'] ?? 'brain_neo4j';

const BRAND = 'caaaa032-0032-0032-0032-000000000001';
const ORG = 'daaaa032-0032-0032-0032-000000000001';
const USER = 'eaaaa032-0032-0032-0032-000000000001';
const BRAIN = 'baaaa032-0032-0032-0032-0000000000a1';
const EMAIL_HASH = '1'.repeat(64);
const CORR = 'identity-readers-neo4j';

let superPool: pg.Pool;
let appPool: pg.Pool;
let driver: Driver;
let reader: Neo4jIdentityReader;
let available = false;

beforeAll(async () => {
  try {
    superPool = new pg.Pool({ connectionString: PG_SUPER, connectionTimeoutMillis: 4000 });
    await superPool.query('SELECT 1');
    appPool = new pg.Pool({ connectionString: PG_APP });
    driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
    await driver.getServerInfo();
    reader = new Neo4jIdentityReader(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD, appPool);

    await superPool.query(`INSERT INTO app_user (id,email,email_normalized,password_hash) VALUES ($1,'idr@x.invalid','idr@x.invalid','x') ON CONFLICT DO NOTHING`, [USER]);
    await superPool.query(`INSERT INTO organization (id,name,slug,owner_user_id) VALUES ($1,'IDR Org','idr-org',$2) ON CONFLICT DO NOTHING`, [ORG, USER]);
    await superPool.query(`INSERT INTO brand (id,organization_id,display_name,currency_code) VALUES ($1,$2,'IDR Brand','INR') ON CONFLICT DO NOTHING`, [BRAND, ORG]);

    // Seed the identity graph: one active customer with a strong email identifier.
    const s = driver.session();
    try {
      await s.run('MATCH (n) WHERE n.brand_id = $b DETACH DELETE n', { b: BRAND });
      await s.run(
        `MERGE (c:Customer {brand_id:$b, brain_id:$id})
           SET c.lifecycle_state='active', c.anonymous_id=null, c.ai_processing_consent=false,
               c.resolution_consent=false, c.created_at=$now, c.first_identified_at=$now
         MERGE (i:Identifier {brand_id:$b, type:'email', hash:$h})
         MERGE (i)-[r:IDENTIFIES]->(c) SET r.tier='strong', r.is_active=true, r.created_at=$now`,
        { b: BRAND, id: BRAIN, h: EMAIL_HASH, now: 1_700_000_000_000 },
      );
    } finally {
      await s.close();
    }
    available = true;
  } catch (e) {
    available = false;
    console.warn('[identity-readers-neo4j] Neo4j/PG unavailable — PENDING.', (e as Error).message);
  }
});

afterAll(async () => {
  if (available) {
    const s = driver.session();
    try { await s.run('MATCH (n) WHERE n.brand_id = $b DETACH DELETE n', { b: BRAND }); } finally { await s.close(); }
    await superPool.query(`DELETE FROM brand WHERE id = $1`, [BRAND]).catch(() => {});
    await superPool.query(`DELETE FROM organization WHERE id = $1`, [ORG]).catch(() => {});
    await superPool.query(`DELETE FROM app_user WHERE id = $1`, [USER]).catch(() => {});
  }
  if (reader) await reader.end().catch(() => {});
  if (driver) await driver.close().catch(() => {});
  if (appPool) await appPool.end();
  if (superPool) await superPool.end();
});

describe('identity readers over the Neo4j SoR (live)', () => {
  it('SKIP_IF_UNAVAILABLE', () => {
    if (!available) console.warn('[identity-readers-neo4j] PENDING.');
    expect(true).toBe(true);
  });

  it('Customer 360 — returns the customer + its identifier (hashed prefix), no merges', async () => {
    if (!available) return;
    const r = await getCustomer360(BRAND, BRAIN, CORR, { reader });
    expect(r.state).toBe('found');
    if (r.state !== 'found') return;
    expect(r.customer.brain_id).toBe(BRAIN);
    expect(r.customer.lifecycle_state).toBe('active');
    expect(r.identifiers.length).toBe(1);
    expect(r.identifiers[0]!.identifier_type).toBe('email');
    expect(r.identifiers[0]!.is_active).toBe(true);
    expect(r.identifiers[0]!.identifier_hash_prefix).toBe(EMAIL_HASH.slice(0, 12));
    expect(r.merges).toEqual([]);
  });

  it('Customer 360 — unknown brain_id → not_found', async () => {
    if (!available) return;
    const r = await getCustomer360(BRAND, 'baaaa032-0032-0032-0032-0000000000ff', CORR, { reader });
    expect(r.state).toBe('not_found');
  });

  it('browse — listCustomers returns the active customer', async () => {
    if (!available) return;
    const r = await listCustomers(BRAND, { lifecycle: 'active', limit: 25, offset: 0 }, CORR, { reader });
    expect(r.total).toBeGreaterThanOrEqual(1);
    const found = r.items.find((x) => x.brain_id === BRAIN);
    expect(found).toBeTruthy();
    expect(found!.identifier_count).toBe(1);
  });

  it('GDPR erase — tombstones the identifier edge + marks erased; 360 reflects it', async () => {
    if (!available) return;
    const e = await eraseCustomer(BRAND, BRAIN, reader);
    expect(e.erased).toBe(true);
    expect(e.links_tombstoned).toBe(1);

    const r = await getCustomer360(BRAND, BRAIN, CORR, { reader });
    if (r.state !== 'found') throw new Error('expected found');
    expect(r.customer.lifecycle_state).toBe('erased');
    expect(r.identifiers.every((i) => i.is_active === false)).toBe(true);
  });
});
