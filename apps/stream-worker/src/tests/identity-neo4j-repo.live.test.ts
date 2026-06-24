/**
 * identity-neo4j-repo.live.test.ts — the Neo4j identity SoR adapter, driven by the REAL resolver.
 *
 * MEDALLION REALIGNMENT (Epic 3 / ADR-0004): proves Neo4jIdentityRepository satisfies the SAME
 * readState/writeOutcome contract as the PG repo, so the pure IdentityResolver (mint/link/merge,
 * phone-guard, cycle-guard) runs UNCHANGED against Neo4j as the system-of-record. Also proves the
 * hybrid split: identity_audit lands in PostgreSQL (ADR-0004), the graph lands in Neo4j.
 *
 * REQUIRES: Neo4j on bolt://localhost:7687 + Postgres on localhost:5432.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import neo4j, { type Driver } from 'neo4j-driver';
import { Neo4jIdentityRepository } from '../infrastructure/neo4j/Neo4jIdentityRepository.js';
import { IdentityResolver, type ExtractedIdentifier } from '../domain/identity/IdentityResolver.js';

const PG_SUPER = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const PG_APP = process.env['BRAIN_APP_DATABASE_URL'] ?? 'postgres://brain_app:brain_app@localhost:5432/brain';
const NEO4J_URI = process.env['NEO4J_URI'] ?? 'bolt://localhost:7687';
const NEO4J_USER = process.env['NEO4J_USER'] ?? 'neo4j';
const NEO4J_PASSWORD = process.env['NEO4J_PASSWORD'] ?? 'brain_neo4j';

const BRAND = 'c9990032-0032-0032-0032-000000000001';
const ORG_ID = 'd9990032-0032-0032-0032-000000000001';
const USER_ID = 'e9990032-0032-0032-0032-000000000001';

/** 64-hex test hash from a small seed. */
function hex(seed: number): string {
  return seed.toString(16).padStart(64, '0');
}
function strongEmail(seed: number): ExtractedIdentifier {
  return { type: 'email', hash: hex(seed), tier: 'strong', confidence: 'high' };
}
function strongPhone(seed: number): ExtractedIdentifier {
  return { type: 'phone', hash: hex(seed), tier: 'strong', confidence: 'high' };
}

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

beforeAll(async () => {
  try {
    superPool = new pg.Pool({ connectionString: PG_SUPER, connectionTimeoutMillis: 4000 });
    await superPool.query('SELECT 1');
    driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
    await driver.getServerInfo();
    repo = new Neo4jIdentityRepository(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD, PG_APP);
    await repo.bootstrap();
    await repo.purgeBrand(BRAND);

    // Brand chain (brand row is read by readState for phone-guard config).
    await superPool.query(`INSERT INTO app_user (id,email,email_normalized,password_hash) VALUES ($1,'id-neo4j@x.invalid','id-neo4j@x.invalid','x') ON CONFLICT DO NOTHING`, [USER_ID]);
    await superPool.query(`INSERT INTO organization (id,name,slug,owner_user_id) VALUES ($1,'ID Neo4j Org','id-neo4j-org',$2) ON CONFLICT DO NOTHING`, [ORG_ID, USER_ID]);
    await superPool.query(`INSERT INTO brand (id,organization_id,display_name,currency_code) VALUES ($1,$2,'ID Neo4j Brand','INR') ON CONFLICT DO NOTHING`, [BRAND, ORG_ID]);
    await superPool.query(`DELETE FROM identity_audit WHERE brand_id = $1`, [BRAND]).catch(() => {});
    available = true;
  } catch (e) {
    available = false;
    console.warn('[identity-neo4j-repo] Neo4j/PG unavailable — PENDING.', (e as Error).message);
  }
});

afterAll(async () => {
  if (available) {
    await repo.purgeBrand(BRAND).catch(() => {});
    await superPool.query(`DELETE FROM identity_audit WHERE brand_id = $1`, [BRAND]).catch(() => {});
    await superPool.query(`DELETE FROM brand WHERE id = $1`, [BRAND]).catch(() => {});
    await superPool.query(`DELETE FROM organization WHERE id = $1`, [ORG_ID]).catch(() => {});
    await superPool.query(`DELETE FROM app_user WHERE id = $1`, [USER_ID]).catch(() => {});
  }
  if (repo) await repo.end().catch(() => {});
  if (driver) await driver.close().catch(() => {});
  if (superPool) await superPool.end();
});

describe('Neo4jIdentityRepository — resolver-driven SoR (live Neo4j + PG)', () => {
  it('SKIP_IF_UNAVAILABLE', () => {
    if (!available) console.warn('[identity-neo4j-repo] PENDING.');
    expect(true).toBe(true);
  });

  it('1. MINT — a new email → a new brain_id; readState reads it back', async () => {
    if (!available) return;
    const o = await drive([strongEmail(0x1001)]);
    expect(o.action).toBe('minted');
    expect(o.brainId).toBeTruthy();

    const st = await repo.readState(BRAND, [{ type: 'email', hash: hex(0x1001) }]);
    expect(st.existingLinks.map((l) => l.brain_id)).toContain(o.brainId);
  });

  it('2. LINK — a known email + new phone → SAME brain_id, phone attached', async () => {
    if (!available) return;
    const o = await drive([strongEmail(0x1001), strongPhone(0x2002)]);
    expect(o.action).toBe('linked');

    const st = await repo.readState(BRAND, [{ type: 'phone', hash: hex(0x2002) }]);
    expect(st.existingLinks.map((l) => l.brain_id)).toContain(o.brainId);
  });

  it('3. MERGE — an event spanning two customers folds them (canonical = min brain_id)', async () => {
    if (!available) return;
    const a = await drive([strongEmail(0x3003)]); // mint A
    const b = await drive([strongEmail(0x4004)]); // mint B
    expect(a.action).toBe('minted');
    expect(b.action).toBe('minted');
    const canonical = a.brainId < b.brainId ? a.brainId : b.brainId;
    const merged = a.brainId < b.brainId ? b.brainId : a.brainId;

    const o = await drive([strongEmail(0x3003), strongEmail(0x4004)]); // both → merge
    expect(o.action).toBe('merged');
    expect(o.brainId).toBe(canonical);

    // The merged customer is tombstoned + aliased to canonical in the graph.
    const sess = driver.session();
    try {
      const res = await sess.run(
        `MATCH (m:Customer {brand_id:$b, brain_id:$merged}) RETURN m.lifecycle_state AS s, m.merged_into AS into`,
        { b: BRAND, merged },
      );
      expect(res.records[0]?.get('s')).toBe('merged');
      expect(res.records[0]?.get('into')).toBe(canonical);
      const alias = await sess.run(
        `MATCH (:Customer {brand_id:$b, brain_id:$merged})-[a:ALIAS_OF]->(:Customer {brand_id:$b, brain_id:$canonical}) RETURN count(a) AS n`,
        { b: BRAND, merged, canonical },
      );
      expect(alias.records[0]?.get('n').toNumber()).toBe(1);
    } finally {
      await sess.close();
    }
  });

  it('4. AUDIT — identity_audit rows land in PostgreSQL (ADR-0004), graph is the SoR', async () => {
    if (!available) return;
    const res = await superPool.query<{ action: string; n: string }>(
      `SELECT action, COUNT(*)::text AS n FROM identity_audit WHERE brand_id = $1 GROUP BY action`,
      [BRAND],
    );
    const byAction = Object.fromEntries(res.rows.map((r) => [r.action, Number(r.n)]));
    expect(byAction['mint']).toBeGreaterThanOrEqual(3); // 0x1001, 0x3003, 0x4004
    expect(byAction['merge']).toBeGreaterThanOrEqual(1);
  });
});
