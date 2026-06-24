/**
 * identity-backfill-neo4j — ONE-TIME backfill of the existing PostgreSQL identity into the Neo4j SoR.
 *
 * MEDALLION REALIGNMENT (Epic 3 / ADR-0004): the resolver writes Neo4j going forward, but the historical
 * identity (customers, hashed identifier→brain_id links, merge aliases) lives in the PG identity schema.
 * This job copies it into the graph so the existing brain_ids (already stamped on orders / the gold
 * ledger) are preserved when PG identity is dropped. Reads PG as the superuser (cross-brand ETL,
 * RLS-bypass) and MERGEs into Neo4j (idempotent — safe to re-run).
 *
 * Run ONCE before dropping the PG identity tables: `node dist/jobs/identity-backfill-neo4j/run.js`.
 */
import neo4j from 'neo4j-driver';
import pg from 'pg';
import { log } from '../../log.js';

const PG_URL = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const NEO4J_URI = process.env['NEO4J_URI'] ?? 'bolt://localhost:7687';
const NEO4J_USER = process.env['NEO4J_USER'] ?? 'neo4j';
const NEO4J_PASSWORD = process.env['NEO4J_PASSWORD'] ?? 'neo4j';
const BATCH = 1000;

export interface BackfillResult {
  customers: number;
  links: number;
  aliases: number;
}

export async function runIdentityBackfill(): Promise<BackfillResult> {
  const pgPool = new pg.Pool({ connectionString: PG_URL, max: 4 });
  const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
  try {
    // ── Customers ──
    const customers = (
      await pgPool.query<{ brand_id: string; brain_id: string; lifecycle_state: string; merged_into: string | null; fia_ms: string | null }>(
        `SELECT brand_id::text, brain_id::text, lifecycle_state,
                merged_into::text AS merged_into,
                (EXTRACT(EPOCH FROM first_identified_at) * 1000)::bigint::text AS fia_ms
           FROM identity.customer`,
      )
    ).rows;

    // ── Active identity links ──
    const links = (
      await pgPool.query<{ brand_id: string; brain_id: string; identifier_type: string; identifier_value: string; tier: string; is_active: boolean; created_ms: string }>(
        `SELECT brand_id::text, brain_id::text, identifier_type, identifier_value, tier, is_active,
                (EXTRACT(EPOCH FROM created_at) * 1000)::bigint::text AS created_ms
           FROM identity.identity_link`,
      )
    ).rows;

    // ── Live merge aliases ──
    const aliases = (
      await pgPool.query<{ brand_id: string; observed_brain_id: string; canonical_brain_id: string; merge_id: string }>(
        `SELECT brand_id::text, observed_brain_id::text, canonical_brain_id::text, merge_id
           FROM brain_id_alias WHERE valid_to IS NULL`,
      )
    ).rows;

    const session = driver.session();
    try {
      // Constraints (idempotent).
      await session.run('CREATE CONSTRAINT identity_identifier_key IF NOT EXISTS FOR (i:Identifier) REQUIRE (i.brand_id, i.type, i.hash) IS UNIQUE');
      await session.run('CREATE CONSTRAINT identity_customer_key IF NOT EXISTS FOR (c:Customer) REQUIRE (c.brand_id, c.brain_id) IS UNIQUE');

      for (let i = 0; i < customers.length; i += BATCH) {
        const rows = customers.slice(i, i + BATCH).map((c) => ({
          brand_id: c.brand_id, brain_id: c.brain_id, lifecycle_state: c.lifecycle_state,
          merged_into: c.merged_into, fia: c.fia_ms == null ? null : Number(c.fia_ms),
        }));
        await session.executeWrite((tx) =>
          tx.run(
            `UNWIND $rows AS r
             MERGE (c:Customer {brand_id:r.brand_id, brain_id:r.brain_id})
             SET c.lifecycle_state=r.lifecycle_state, c.merged_into=r.merged_into, c.first_identified_at=r.fia`,
            { rows },
          ),
        );
      }

      for (let i = 0; i < links.length; i += BATCH) {
        const rows = links.slice(i, i + BATCH).map((l) => ({
          brand_id: l.brand_id, brain_id: l.brain_id, type: l.identifier_type, hash: l.identifier_value,
          tier: l.tier, is_active: l.is_active, created_at: Number(l.created_ms),
        }));
        await session.executeWrite((tx) =>
          tx.run(
            `UNWIND $rows AS r
             MERGE (i:Identifier {brand_id:r.brand_id, type:r.type, hash:r.hash})
             MERGE (c:Customer {brand_id:r.brand_id, brain_id:r.brain_id})
             MERGE (i)-[e:IDENTIFIES]->(c)
             SET e.tier=r.tier, e.is_active=r.is_active, e.created_at=r.created_at`,
            { rows },
          ),
        );
      }

      for (let i = 0; i < aliases.length; i += BATCH) {
        const rows = aliases.slice(i, i + BATCH);
        await session.executeWrite((tx) =>
          tx.run(
            `UNWIND $rows AS r
             MERGE (o:Customer {brand_id:r.brand_id, brain_id:r.observed_brain_id})
             MERGE (can:Customer {brand_id:r.brand_id, brain_id:r.canonical_brain_id})
             MERGE (o)-[a:ALIAS_OF]->(can)
             SET a.merge_id=r.merge_id, a.rule_version='v1-deterministic', a.valid_to=null`,
            { rows },
          ),
        );
      }
    } finally {
      await session.close();
    }

    log.info(`[identity-backfill] ${customers.length} customers, ${links.length} links, ${aliases.length} aliases → Neo4j`);
    return { customers: customers.length, links: links.length, aliases: aliases.length };
  } finally {
    await pgPool.end();
    await driver.close();
  }
}

if (process.argv[1]?.endsWith('run.ts') || process.argv[1]?.endsWith('run.js')) {
  runIdentityBackfill()
    .then((r) => { log.info(`[identity-backfill] done — ${r.customers} customers, ${r.links} links, ${r.aliases} aliases`); process.exit(0); })
    .catch((err) => { log.error('[identity-backfill] fatal', { err }); process.exit(1); });
}
