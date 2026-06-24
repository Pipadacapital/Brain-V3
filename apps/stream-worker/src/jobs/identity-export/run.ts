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

export interface IdentityExportResult {
  edges: number;
}

interface EdgeRow {
  brand_id: string;
  identifier_type: string;
  identifier_value: string;
  brain_id: string;
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
                c.brain_id AS brain_id, r.is_active AS is_active`,
      );
      edges = res.records.map((rec) => ({
        brand_id: rec.get('brand_id'),
        identifier_type: rec.get('identifier_type'),
        identifier_value: rec.get('identifier_value'),
        brain_id: rec.get('brain_id'),
        is_active: rec.get('is_active') === true,
      }));
    } finally {
      await session.close();
    }

    // 2. Full-refresh the StarRocks projection (TRUNCATE then batched INSERT).
    await sr.query('TRUNCATE TABLE brain_silver.silver_identity_link');
    for (let i = 0; i < edges.length; i += BATCH) {
      const chunk = edges.slice(i, i + BATCH);
      const tuples = chunk.map(() => '(?,?,?,?,?,NOW())').join(',');
      const params: unknown[] = [];
      for (const e of chunk) {
        params.push(e.brand_id, e.identifier_type, e.identifier_value, e.brain_id, e.is_active ? 1 : 0);
      }
      await sr.query(
        `INSERT INTO brain_silver.silver_identity_link
           (brand_id, identifier_type, identifier_value, brain_id, is_active, updated_at)
         VALUES ${tuples}`,
        params,
      );
    }

    log.info(`[identity-export] materialized ${edges.length} active identity edges → silver_identity_link`);
    return { edges: edges.length };
  } finally {
    await driver.close();
    await sr.end();
  }
}

if (process.argv[1]?.endsWith('run.ts') || process.argv[1]?.endsWith('run.js')) {
  runIdentityExport()
    .then((r) => { log.info(`[identity-export] done — ${r.edges} edges`); process.exit(0); })
    .catch((err) => { log.error('[identity-export] fatal', { err }); process.exit(1); });
}
