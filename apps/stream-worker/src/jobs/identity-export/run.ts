/**
 * identity-export — materialize the Neo4j identity graph → StarRocks brain_silver.silver_identity_link
 * + silver_customer_identity.
 *
 * MEDALLION REALIGNMENT (Epic 3 / ADR-0004): Neo4j is the identity SoR, but dbt/StarRocks cannot read
 * Neo4j. silver_order_recognition (gold revenue ledger) + customer marts resolve brain_id from the
 * hashed-identifier→brain_id mapping. This job reads the IDENTIFIES edges + Customer nodes from Neo4j and
 * UPSERTs them into the StarRocks PRIMARY KEY tables the marts read. Runs BEFORE recognition-refresh (cron).
 *
 * INCREMENTAL by default (SC-1): a TRUNCATE + full reload every run is O(graph) regardless of churn and
 * won't scale. So each run exports only what changed since a persisted high-watermark, in two parts:
 *
 *   (a) CREATE stream — Customer nodes / IDENTIFIES edges with created_at > last-exported high-watermark.
 *       These are the actual high-churn rows (new customers + new identifier attachments). UPSERTed into
 *       the PRIMARY KEY tables (INSERT == upsert by PK), then the watermark is advanced to the new MAX.
 *
 *   (b) tombstone/lifecycle sweep — the Neo4j writers do NOT bump a timestamp when they mutate an existing
 *       row (`SET r.is_active=false` on GDPR erase; `SET c.lifecycle_state='merged'|'split'|'erased'` +
 *       merged_into on merge/unmerge — see core neo4j-identity-reader.ts). A pure created_at watermark
 *       would therefore MISS those mutations and leave stale is_active=true / lifecycle rows. So we ALWAYS
 *       re-pull the BOUNDED set of mutated rows (inactive edges; non-'active' customers) — erasures/merges
 *       are a small minority of the graph — and UPSERT them so deactivations/merges propagate. This keeps
 *       correctness equal to the old TRUNCATE+reload without re-reading the whole graph.
 *
 * Full-refresh fallback: set IDENTITY_EXPORT_FULL=1 to TRUNCATE both tables and reload the entire active
 * projection + reset the watermark to 0 (recovery / schema change / first build). Same result as before.
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

/** Force a full TRUNCATE + reload of both projections (recovery / first build). */
const FULL_REFRESH = process.env['IDENTITY_EXPORT_FULL'] === '1';

const BATCH = 1000;

const SCOPE_LINK = 'identity_link';
const SCOPE_CUSTOMER = 'customer_identity';

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
  mode: 'full' | 'incremental';
}

interface EdgeRow {
  brand_id: string;
  identifier_type: string;
  identifier_value: string;
  brain_id: string;
  tier: string | null;
  is_active: boolean;
  created_at: number | null;
}

interface CustomerRow {
  brand_id: string;
  brain_id: string;
  lifecycle_state: string | null;
  merged_into: string | null;
  minted_at: number | null;
  first_identified_at: number | null;
}

/** Read the persisted high-watermark (MAX created_at exported) for a scope; 0 if never run / full mode. */
async function readWatermark(sr: mysql.Pool, scope: string): Promise<number> {
  if (FULL_REFRESH) return 0;
  const [rows] = await sr.query(
    'SELECT last_created_at_ms FROM brain_silver.identity_export_state WHERE scope = ?',
    [scope],
  );
  const r = (rows as Array<{ last_created_at_ms: number | null }>)[0];
  return r?.last_created_at_ms != null ? Number(r.last_created_at_ms) : 0;
}

/** Persist the advanced high-watermark for a scope (PK upsert — single row per scope). */
async function writeWatermark(sr: mysql.Pool, scope: string, ms: number): Promise<void> {
  await sr.query(
    `INSERT INTO brain_silver.identity_export_state (scope, last_created_at_ms, updated_at)
     VALUES (?,?,NOW())`,
    [scope, ms],
  );
}

const dt = (ms: number | null): string | null =>
  ms == null ? null : new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

/** Batched UPSERT into the silver_identity_link PRIMARY KEY table (INSERT == upsert by PK). */
async function upsertEdges(sr: mysql.Pool, edges: EdgeRow[]): Promise<void> {
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
}

/** Batched UPSERT into the silver_customer_identity PRIMARY KEY table (INSERT == upsert by PK). */
async function upsertCustomers(sr: mysql.Pool, customers: CustomerRow[]): Promise<void> {
  for (let i = 0; i < customers.length; i += BATCH) {
    const chunk = customers.slice(i, i + BATCH);
    const tuples = chunk.map(() => '(?,?,?,?,?,?,NOW())').join(',');
    const params: unknown[] = [];
    for (const c of chunk) {
      params.push(c.brand_id, c.brain_id, c.lifecycle_state, c.merged_into, dt(c.minted_at), dt(c.first_identified_at));
    }
    await sr.query(
      `INSERT INTO brain_silver.silver_customer_identity
         (brand_id, brain_id, lifecycle_state, merged_into, minted_at, first_identified_at, updated_at)
       VALUES ${tuples}`,
      params,
    );
  }
}

function mapEdge(rec: neo4j.Record): EdgeRow {
  return {
    brand_id: rec.get('brand_id'),
    identifier_type: rec.get('identifier_type'),
    identifier_value: rec.get('identifier_value'),
    brain_id: rec.get('brain_id'),
    tier: rec.get('tier') ?? null,
    is_active: rec.get('is_active') === true,
    created_at: toMs(rec.get('created_at')),
  };
}

function mapCustomer(rec: neo4j.Record): CustomerRow {
  return {
    brand_id: rec.get('brand_id'),
    brain_id: rec.get('brain_id'),
    lifecycle_state: rec.get('lifecycle_state') ?? null,
    merged_into: rec.get('merged_into') ?? null,
    minted_at: toMs(rec.get('minted_at')),
    first_identified_at: toMs(rec.get('first_identified_at')),
  };
}

export async function runIdentityExport(): Promise<IdentityExportResult> {
  const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
  const sr = mysql.createPool({ host: SR_HOST, port: SR_PORT, user: SR_USER, password: SR_PASSWORD, connectionLimit: 4 });
  const mode: 'full' | 'incremental' = FULL_REFRESH ? 'full' : 'incremental';
  try {
    // ── 1. IDENTIFIES edges → silver_identity_link ───────────────────────────────────────────────
    const linkWatermark = await readWatermark(sr, SCOPE_LINK);
    if (FULL_REFRESH) {
      await sr.query('TRUNCATE TABLE brain_silver.silver_identity_link');
    }

    const edgeSession = driver.session({ defaultAccessMode: neo4j.session.READ });
    let edges: EdgeRow[];
    try {
      // FULL: every active edge.  INCREMENTAL: edges created since the watermark (new attachments) UNION
      // the bounded set of inactive edges (GDPR/merge tombstones — no created_at signal on the flip).
      const res = FULL_REFRESH
        ? await edgeSession.run(
            `MATCH (i:Identifier)-[r:IDENTIFIES]->(c:Customer)
             WHERE r.is_active = true AND c.brain_id IS NOT NULL
             RETURN i.brand_id AS brand_id, i.type AS identifier_type, i.hash AS identifier_value,
                    c.brain_id AS brain_id, r.tier AS tier, r.is_active AS is_active, r.created_at AS created_at`,
          )
        : await edgeSession.run(
            `MATCH (i:Identifier)-[r:IDENTIFIES]->(c:Customer)
             WHERE c.brain_id IS NOT NULL
               AND ( (r.is_active = true AND coalesce(r.created_at, 0) > $wm) OR r.is_active = false )
             RETURN i.brand_id AS brand_id, i.type AS identifier_type, i.hash AS identifier_value,
                    c.brain_id AS brain_id, r.tier AS tier, r.is_active AS is_active, r.created_at AS created_at`,
            { wm: neo4j.int(linkWatermark) },
          );
      edges = res.records.map(mapEdge);
    } finally {
      await edgeSession.close();
    }

    await upsertEdges(sr, edges);

    // Advance the watermark to the MAX created_at we just exported (never regress).
    const maxEdgeCreated = edges.reduce((m, e) => (e.created_at != null && e.created_at > m ? e.created_at : m), linkWatermark);
    await writeWatermark(sr, SCOPE_LINK, maxEdgeCreated);
    log.info(`[identity-export] ${mode}: upserted ${edges.length} identity edges → silver_identity_link (watermark=${maxEdgeCreated})`);

    // ── 2. Customer nodes → silver_customer_identity ─────────────────────────────────────────────
    const customerWatermark = await readWatermark(sr, SCOPE_CUSTOMER);
    if (FULL_REFRESH) {
      await sr.query('TRUNCATE TABLE brain_silver.silver_customer_identity');
    }

    const cSession = driver.session({ defaultAccessMode: neo4j.session.READ });
    let customers: CustomerRow[];
    try {
      // FULL: every customer.  INCREMENTAL: customers created since the watermark UNION the bounded set of
      // non-'active' customers (merged/split/erased — lifecycle_state/merged_into mutations carry no
      // timestamp, so re-pull them every run to propagate the merge/erase state).
      const cRes = FULL_REFRESH
        ? await cSession.run(
            `MATCH (c:Customer) WHERE c.brain_id IS NOT NULL
             RETURN c.brand_id AS brand_id, c.brain_id AS brain_id, c.lifecycle_state AS lifecycle_state,
                    c.merged_into AS merged_into, c.created_at AS minted_at, c.first_identified_at AS first_identified_at`,
          )
        : await cSession.run(
            `MATCH (c:Customer)
             WHERE c.brain_id IS NOT NULL
               AND ( coalesce(c.created_at, 0) > $wm OR coalesce(c.lifecycle_state, 'active') <> 'active' )
             RETURN c.brand_id AS brand_id, c.brain_id AS brain_id, c.lifecycle_state AS lifecycle_state,
                    c.merged_into AS merged_into, c.created_at AS minted_at, c.first_identified_at AS first_identified_at`,
            { wm: neo4j.int(customerWatermark) },
          );
      customers = cRes.records.map(mapCustomer);
    } finally {
      await cSession.close();
    }

    await upsertCustomers(sr, customers);

    const maxCustomerCreated = customers.reduce((m, c) => (c.minted_at != null && c.minted_at > m ? c.minted_at : m), customerWatermark);
    await writeWatermark(sr, SCOPE_CUSTOMER, maxCustomerCreated);
    log.info(`[identity-export] ${mode}: upserted ${customers.length} customers → silver_customer_identity (watermark=${maxCustomerCreated})`);

    return { edges: edges.length, customers: customers.length, mode };
  } finally {
    await driver.close();
    await sr.end();
  }
}

if (process.argv[1]?.endsWith('run.ts') || process.argv[1]?.endsWith('run.js')) {
  runIdentityExport()
    .then((r) => { log.info(`[identity-export] done (${r.mode}) — ${r.edges} edges, ${r.customers} customers`); process.exit(0); })
    .catch((err) => { log.error('[identity-export] fatal', { err }); process.exit(1); });
}
