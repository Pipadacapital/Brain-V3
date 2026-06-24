/**
 * phone-guard-reeval.live.test.ts — the job must ENUMERATE active brands under brain_app and
 * re-evaluate SharedUtility suppressions in the Neo4j identity SoR (Epic 3 / ADR-0004).
 *
 * Brand enumeration + per-brand config (threshold/window) are PG (operational state); the SharedUtility
 * suppression state + the windowed distinct-brain_id count (over IDENTIFIES edges) are Neo4j. This test
 * seeds an EXPIRED suppression with zero live IDENTIFIES edges (count 0 ≤ threshold) and asserts the job
 * un-suppresses it IN NEO4J. It also proves the brand WAS enumerated — the pre-fix bare `SELECT id FROM
 * brand` under no app.current_brand_id GUC returned zero rows (NN-1 fail-closed) → silent no-op, leaving
 * expired suppressions stuck (a slow LTV-breaking bug at prod COD volume). The fix routes enumeration
 * through `list_active_brand_ids()` (durable rule system-job-force-rls-enumeration).
 *
 * REQUIRES Postgres (list_active_brand_ids) + Neo4j.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import neo4j from 'neo4j-driver';

const SUPER = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const APP = process.env['BRAIN_APP_DATABASE_URL'] ?? 'postgres://brain_app:brain_app@localhost:5432/brain';
const NEO4J_URI = process.env['NEO4J_URI'] ?? 'bolt://localhost:7687';
const NEO4J_USER = process.env['NEO4J_USER'] ?? 'neo4j';
const NEO4J_PASSWORD = process.env['NEO4J_PASSWORD'] ?? 'brain_neo4j';

const BRAND = 'a9000a1a-0a1a-4a1a-8a1a-000000000a01';
const ORG = 'a9000a1a-0a1a-4a1a-8a1a-0000000000f1';
const USER = 'a9000a1a-0a1a-4a1a-8a1a-0000000000e1';
const PHONE_HASH = 'a'.repeat(64); // 64-hex sentinel (never raw PII)

let superPool: pg.Pool;
let driver: neo4j.Driver;
let available = false;

async function cleanupPg() {
  await superPool.query(`DELETE FROM brand WHERE id=$1`, [BRAND]).catch(() => {});
  await superPool.query(`DELETE FROM organization WHERE id=$1`, [ORG]).catch(() => {});
  await superPool.query(`DELETE FROM app_user WHERE id=$1`, [USER]).catch(() => {});
}
async function cleanupNeo4j() {
  const s = driver.session();
  try {
    await s.run(`MATCH (u:SharedUtility {brand_id:$b}) DETACH DELETE u`, { b: BRAND });
  } finally {
    await s.close();
  }
}

beforeAll(async () => {
  try {
    superPool = new pg.Pool({ connectionString: SUPER, connectionTimeoutMillis: 4000 });
    await superPool.query('SELECT 1');
    driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
    await driver.verifyConnectivity();
    // The job reads NEO4J_PASSWORD / BRAIN_APP_DATABASE_URL at import; set them BEFORE the dynamic
    // import in the test so the job connects with the same credentials this test seeds against.
    process.env['NEO4J_PASSWORD'] = NEO4J_PASSWORD;
    process.env['BRAIN_APP_DATABASE_URL'] = APP;

    await cleanupPg();
    await cleanupNeo4j();
    await superPool.query(
      `INSERT INTO app_user (id,email,email_normalized,password_hash)
       VALUES ($1,'pg@example.invalid','pg@example.invalid','x') ON CONFLICT (id) DO NOTHING`, [USER]);
    await superPool.query(
      `INSERT INTO organization (id,name,slug,owner_user_id)
       VALUES ($1,'PG Org','pg-org',$2) ON CONFLICT (id) DO NOTHING`, [ORG, USER]);
    // threshold/window defaults; status active so list_active_brand_ids() returns it.
    await superPool.query(
      `INSERT INTO brand (id,organization_id,display_name,currency_code,status)
       VALUES ($1,$2,'PG Brand','INR','active') ON CONFLICT (id) DO NOTHING`, [BRAND, ORG]);
    // An EXPIRED suppression (suppressed_until in the past, epoch-ms) with zero live IDENTIFIES edges
    // (count 0 ≤ threshold) → the job must un-suppress it.
    const s = driver.session();
    try {
      await s.run(
        `MERGE (u:SharedUtility {brand_id:$b, identifier_type:'phone', identifier_value:$h})
         SET u.suppressed_until = $past, u.profile_count = 50, u.reason = 'flagged'`,
        { b: BRAND, h: PHONE_HASH, past: Date.now() - 86_400_000 },
      );
    } finally {
      await s.close();
    }
    available = true;
  } catch {
    available = false;
  }
});

afterAll(async () => {
  if (available) {
    await cleanupPg();
    await cleanupNeo4j();
  }
  if (superPool) await superPool.end();
  if (driver) await driver.close();
});

describe('phone-guard-reeval enumerates under brain_app + re-evaluates Neo4j SharedUtility', () => {
  it('SKIP_IF_NO_DEPS', () => {
    if (!available) console.warn('[phone-guard-reeval] Postgres/Neo4j unavailable — PENDING.');
    expect(true).toBe(true);
  });

  it('un-suppresses an expired suppression with zero live links (was a no-op before the fix)', async () => {
    if (!available) return;
    const { runPhoneGuardReeval } = await import('../jobs/phone-guard-reeval.js');
    await runPhoneGuardReeval();

    const s = driver.session();
    let row: { suppressed_until: unknown; reason: string | null } | undefined;
    try {
      const res = await s.run(
        `MATCH (u:SharedUtility {brand_id:$b, identifier_type:'phone', identifier_value:$h})
         RETURN u.suppressed_until AS suppressed_until, u.reason AS reason`,
        { b: BRAND, h: PHONE_HASH },
      );
      const rec = res.records[0];
      row = rec ? { suppressed_until: rec.get('suppressed_until'), reason: rec.get('reason') } : undefined;
    } finally {
      await s.close();
    }
    expect(row?.suppressed_until).toBeNull(); // un-suppressed (proves the brand WAS enumerated)
    expect(row?.reason).toBe('reeval_count_below_threshold');
  });
});
