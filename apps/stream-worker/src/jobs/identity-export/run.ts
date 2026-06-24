/**
 * identity-export — materialize the Neo4j identity graph → StarRocks brain_silver.silver_identity_link.
 *
 * MEDALLION REALIGNMENT (Epic 3 / ADR-0004): Neo4j is the identity SoR, but dbt/StarRocks cannot read
 * Neo4j. silver_order_recognition (gold revenue ledger) + customer marts resolve brain_id from the
 * hashed-identifier→brain_id mapping. This job reads the active IDENTIFIES edges from Neo4j and full-
 * refreshes the StarRocks PRIMARY KEY table the marts read. Runs BEFORE recognition-refresh (cron).
 *
 * Full-refresh (TRUNCATE + batched INSERT) — simple + correct for current scale; an incremental
 * since-watermark export is the documented follow-up if the graph grows large.
 *
 * Invoked by the core/worker job entrypoint: `node dist/jobs/identity-export/run.js`.
 */
import neo4j from 'neo4j-driver';
import mysql from 'mysql2/promise';
import { log } from '../../log.js';

const NEO4J_URI = process.env['NEO4J_URI'] ?? 'bolt://localhost:7687';
const NEO4J_USER = process.env['NEO4J_USER'] ?? 'neo4j';
const NEO4J_PASSWORD = process.env['NEO4J_PASSWORD'] ?? 'neo4j';
const SR_HOST = process.env['STARROCKS_HOST'] ?? '127.0.0.1';
const SR_PORT = Number(process.env['STARROCKS_QUERY_PORT'] ?? process.env['STARROCKS_PORT'] ?? '9030');
const SR_USER = process.env['STARROCKS_ROOT_USER'] ?? 'root';
const SR_PASSWORD = process.env['STARROCKS_ROOT_PASSWORD'] ?? '';

const BATCH = 1000;

/** neo4j epoch-millis (stored as number/Integer) → JS number, or null. */
function toMs(v: unknown): number | null {
  if (v == null) return null;
  if (neo4j.isInt(v)) return (v as neo4j.Integer).toNumber();
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export interface IdentityExportResult {
  edges: number;
  customers: number;
}

interface EdgeRow {
  brand_id: string;
  identifier_type: string;
  identifier_value: string;
  brain_id: string;
  tier: string | null;
  is_active: boolean;
}

export async function runIdentityExport(): Promise<IdentityExportResult> {
  const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
  const sr = mysql.createPool({ host: SR_HOST, port: SR_PORT, user: SR_USER, password: SR_PASSWORD, connectionLimit: 4 });
  try {
    // 1. Read all active IDENTIFIES edges from the identity graph (the SoR).
    const session = driver.session({ defaultAccessMode: neo4j.session.READ });
    let edges: EdgeRow[];
    try {
      const res = await session.run(
        `MATCH (i:Identifier)-[r:IDENTIFIES]->(c:Customer)
         WHERE r.is_active = true AND c.brain_id IS NOT NULL
         RETURN i.brand_id AS brand_id, i.type AS identifier_type, i.hash AS identifier_value,
                c.brain_id AS brain_id, r.tier AS tier, r.is_active AS is_active`,
      );
      edges = res.records.map((rec) => ({
        brand_id: rec.get('brand_id'),
        identifier_type: rec.get('identifier_type'),
        identifier_value: rec.get('identifier_value'),
        brain_id: rec.get('brain_id'),
        tier: rec.get('tier') ?? null,
        is_active: rec.get('is_active') === true,
      }));
    } finally {
      await session.close();
    }

    // 2. Full-refresh the StarRocks projection (TRUNCATE then batched INSERT).
    await sr.query('TRUNCATE TABLE brain_silver.silver_identity_link');
    for (let i = 0; i < edges.length; i += BATCH) {
      const chunk = edges.slice(i, i + BATCH);
      const tuples = chunk.map(() => '(?,?,?,?,?,?,NOW())').join(',');
      const params: unknown[] = [];
      for (const e of chunk) {
        params.push(e.brand_id, e.identifier_type, e.identifier_value, e.brain_id, e.tier, e.is_active ? 1 : 0);
      }
      await sr.query(
        `INSERT INTO brain_silver.silver_identity_link
           (brand_id, identifier_type, identifier_value, brain_id, tier, is_active, updated_at)
         VALUES ${tuples}`,
        params,
      );
    }

    log.info(`[identity-export] materialized ${edges.length} active identity edges → silver_identity_link`);

    // 3. Export the Customer nodes (acquisition/lifecycle attrs the customer marts need).
    const cSession = driver.session({ defaultAccessMode: neo4j.session.READ });
    let customers: Array<{ brand_id: string; brain_id: string; lifecycle_state: string | null; merged_into: string | null; minted_at: number | null; first_identified_at: number | null }>;
    try {
      const cRes = await cSession.run(
        `MATCH (c:Customer) WHERE c.brain_id IS NOT NULL
         RETURN c.brand_id AS brand_id, c.brain_id AS brain_id, c.lifecycle_state AS lifecycle_state,
                c.merged_into AS merged_into, c.created_at AS minted_at, c.first_identified_at AS first_identified_at`,
      );
      customers = cRes.records.map((rec) => ({
        brand_id: rec.get('brand_id'),
        brain_id: rec.get('brain_id'),
        lifecycle_state: rec.get('lifecycle_state') ?? null,
        merged_into: rec.get('merged_into') ?? null,
        minted_at: toMs(rec.get('minted_at')),
        first_identified_at: toMs(rec.get('first_identified_at')),
      }));
    } finally {
      await cSession.close();
    }
    await sr.query('TRUNCATE TABLE brain_silver.silver_customer_identity');
    const dt = (ms: number | null): string | null => (ms == null ? null : new Date(ms).toISOString().slice(0, 19).replace('T', ' '));
    for (let i = 0; i < customers.length; i += BATCH) {
      const chunk = customers.slice(i, i + BATCH);
      const tuples = chunk.map(() => '(?,?,?,?,?,?,NOW())').join(',');
      const params: unknown[] = [];
      for (const c of chunk) params.push(c.brand_id, c.brain_id, c.lifecycle_state, c.merged_into, dt(c.minted_at), dt(c.first_identified_at));
      await sr.query(
        `INSERT INTO brain_silver.silver_customer_identity
           (brand_id, brain_id, lifecycle_state, merged_into, minted_at, first_identified_at, updated_at)
         VALUES ${tuples}`,
        params,
      );
    }
    log.info(`[identity-export] materialized ${customers.length} customers → silver_customer_identity`);
    return { edges: edges.length, customers: customers.length };
  } finally {
    await driver.close();
    await sr.end();
  }
}

if (process.argv[1]?.endsWith('run.ts') || process.argv[1]?.endsWith('run.js')) {
  runIdentityExport()
    .then((r) => { log.info(`[identity-export] done — ${r.edges} edges, ${r.customers} customers`); process.exit(0); })
    .catch((err) => { log.error('[identity-export] fatal', { err }); process.exit(1); });
}
