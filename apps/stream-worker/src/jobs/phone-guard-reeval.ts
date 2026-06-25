/**
 * phone-guard-reeval — Re-evaluation job for the phone-guard SharedUtility state (D-1).
 *
 * MEDALLION REALIGNMENT (Epic 3 / ADR-0004): identity is the Neo4j SoR. The phone-guard SharedUtility
 * nodes + the windowed distinct-brain_id count (over IDENTIFIES edges) live in Neo4j; the per-brand
 * phone-guard CONFIG (threshold / window) is read from the PG brand table (operational state).
 *
 * Algorithm (unchanged): for each brand, find SharedUtility entries whose suppression window has expired,
 * re-count windowed distinct brain_ids for the phone hash, un-suppress if ≤ threshold else extend.
 * Windowed (not lifetime) so a burst-suppressed kiosk phone becomes re-eligible once the window slides.
 *
 * Usage: node dist/jobs/phone-guard-reeval.js
 */

import { Pool } from 'pg';
import neo4j from 'neo4j-driver';
import { loadStreamWorkerConfig } from '@brain/config';
import { log } from '../log.js';

const cfg = loadStreamWorkerConfig();
const DB_URL = cfg.BRAIN_APP_DATABASE_URL;
const NEO4J_URI = cfg.NEO4J_URI;
const NEO4J_USER = cfg.NEO4J_USER;
const NEO4J_PASSWORD = cfg.NEO4J_PASSWORD;

function toNum(v: unknown): number {
  if (v == null) return 0;
  if (neo4j.isInt(v)) return (v as neo4j.Integer).toNumber();
  return Number(v);
}

async function run(): Promise<void> {
  const pool = new Pool({ connectionString: DB_URL, max: 3 });
  const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
  try {
    log.info('starting re-evaluation job');
    const brandsRes = await pool.query<{ id: string }>(`SELECT id FROM list_active_brand_ids()`);
    let totalUnsuppressed = 0;
    let totalExtended = 0;

    // PF-2/SC-1 (b): read every active brand's phone-guard config on ONE pooled connection — the
    // previous per-brand pool.connect()+BEGIN/COMMIT opened a fresh connection per brand (4 PG
    // round-trips × N brands of pure churn). The `brand` table is FORCE ROW LEVEL SECURITY scoped to
    // app.current_brand_id (0004 brand_isolation), so a single bulk SELECT under brain_app would
    // return ZERO rows; a single SECURITY DEFINER fn returning the config could collapse this to one
    // query, but adding one is out of scope here. We instead hoist the connection: acquire it once and
    // set the brand GUC per brand inside one short txn (still RLS-isolated, no per-brand reconnect).
    const cfgByBrand = new Map<string, { threshold: number; windowDays: number }>();
    const cfgClient = await pool.connect();
    try {
      for (const brand of brandsRes.rows) {
        try {
          await cfgClient.query('BEGIN');
          await cfgClient.query("SELECT set_config('app.current_brand_id', $1, true)", [brand.id]);
          const cfg = await cfgClient.query<{ phone_guard_threshold: number; suppression_window_days: number }>(
            `SELECT phone_guard_threshold, suppression_window_days FROM brand WHERE id = $1`,
            [brand.id],
          );
          await cfgClient.query('COMMIT');
          if (cfg.rows[0]) {
            cfgByBrand.set(brand.id, {
              threshold: cfg.rows[0].phone_guard_threshold,
              windowDays: cfg.rows[0].suppression_window_days,
            });
          }
        } catch (err) {
          await cfgClient.query('ROLLBACK').catch(() => {});
          log.error(`config read failed for brand ${brand.id}`, { err });
        }
      }
    } finally {
      cfgClient.release();
    }

    // PF-2/SC-1 (a)+(c): reuse a SINGLE Neo4j session across all brands, and per brand collapse the
    // former 1 (expired) + 2×rows (count + SET) round-trips into TWO: one read that finds the expired
    // rows AND recomputes the windowed distinct-brain_id count per row in a single round-trip, then
    // one UNWIND SET that applies the suppress/extend decision for every expired row at once.
    const session = driver.session();
    try {
      for (const brand of brandsRes.rows) {
        const cfg = cfgByBrand.get(brand.id);
        if (!cfg) continue;
        const { threshold, windowDays } = cfg;
        try {
          const nowMs = Date.now();
          const cutoffMs = nowMs - windowDays * 86_400_000;

          // (a) ONE read: expired SharedUtility rows + their windowed distinct-brain_id count.
          // The per-row count is a correlated subquery (CALL { }) over the IDENTIFIES edges,
          // identical predicate to the prior per-row query (is_active + created_at > cutoff).
          const expired = await session.run(
            `MATCH (s:SharedUtility {brand_id:$b})
             WHERE s.suppressed_until IS NOT NULL AND s.suppressed_until <= $now
             CALL {
               WITH s
               OPTIONAL MATCH (i:Identifier {brand_id:$b, type:s.identifier_type, hash:s.identifier_value})-[r:IDENTIFIES]->(c:Customer)
               WHERE r.is_active = true AND r.created_at > $cutoff
               RETURN count(DISTINCT c.brain_id) AS cnt
             }
             RETURN s.identifier_type AS type, s.identifier_value AS value, cnt`,
            { b: brand.id, now: nowMs, cutoff: cutoffMs },
          );

          // Build the per-row decisions, preserving the exact semantics:
          // count <= threshold → un-suppress; else → extend the window.
          const newUntil = nowMs + windowDays * 86_400_000;
          const decisions: Array<{ type: string; value: string; count: number; until: number | null; reason: string }> = [];
          for (const rec of expired.records) {
            const type = rec.get('type');
            const value = rec.get('value');
            const count = toNum(rec.get('cnt') ?? 0);
            if (count <= threshold) {
              decisions.push({ type, value, count, until: null, reason: 'reeval_count_below_threshold' });
              totalUnsuppressed++;
              log.info(`[phone-guard-reeval] un-suppressed brand=${brand.id} type=${type} count=${count} threshold=${threshold}`);
            } else {
              decisions.push({ type, value, count, until: newUntil, reason: 'reeval_count_still_above_threshold' });
              totalExtended++;
              log.info(`[phone-guard-reeval] extended brand=${brand.id} type=${type} count=${count} threshold=${threshold}`);
            }
          }

          // (a) ONE write: UNWIND the decisions and SET each SharedUtility in a single round-trip.
          // A null `until` un-suppresses; a non-null `until` extends — same fields the per-row SETs wrote.
          if (decisions.length > 0) {
            await session.run(
              `UNWIND $rows AS row
               MATCH (s:SharedUtility {brand_id:$b, identifier_type:row.type, identifier_value:row.value})
               SET s.suppressed_until = row.until, s.profile_count = row.count, s.reason = row.reason`,
              { b: brand.id, rows: decisions },
            );
          }
        } catch (err) {
          log.error(`error for brand ${brand.id}`, { err });
        }
      }
    } finally {
      await session.close();
    }
    log.info(`complete: un-suppressed=${totalUnsuppressed} extended=${totalExtended}`);
  } finally {
    await pool.end();
    await driver.close();
  }
}

if (process.argv[1]?.endsWith('phone-guard-reeval.ts') || process.argv[1]?.endsWith('phone-guard-reeval.js')) {
  run().catch((err) => {
    log.error('fatal', { err });
    process.exit(1);
  });
}

export { run as runPhoneGuardReeval };
