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
import { log } from '../log.js';

const DB_URL =
  process.env['BRAIN_APP_DATABASE_URL'] ??
  'postgres://brain_app:brain_app@localhost:5432/brain';
const NEO4J_URI = process.env['NEO4J_URI'] ?? 'bolt://localhost:7687';
const NEO4J_USER = process.env['NEO4J_USER'] ?? 'neo4j';
const NEO4J_PASSWORD = process.env['NEO4J_PASSWORD'] ?? 'neo4j';

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

    for (const brand of brandsRes.rows) {
      try {
        // Per-brand phone-guard config — PG (under the brand GUC; RLS allows the single-brand read).
        let threshold: number;
        let windowDays: number;
        const cfgClient = await pool.connect();
        try {
          await cfgClient.query('BEGIN');
          await cfgClient.query("SELECT set_config('app.current_brand_id', $1, true)", [brand.id]);
          const cfg = await cfgClient.query<{ phone_guard_threshold: number; suppression_window_days: number }>(
            `SELECT phone_guard_threshold, suppression_window_days FROM brand WHERE id = $1`,
            [brand.id],
          );
          await cfgClient.query('COMMIT');
          if (!cfg.rows[0]) continue;
          threshold = cfg.rows[0].phone_guard_threshold;
          windowDays = cfg.rows[0].suppression_window_days;
        } finally {
          cfgClient.release();
        }

        const nowMs = Date.now();
        const cutoffMs = nowMs - windowDays * 86_400_000;
        const session = driver.session();
        try {
          const expired = await session.run(
            `MATCH (s:SharedUtility {brand_id:$b})
             WHERE s.suppressed_until IS NOT NULL AND s.suppressed_until <= $now
             RETURN s.identifier_type AS type, s.identifier_value AS value`,
            { b: brand.id, now: nowMs },
          );
          for (const rec of expired.records) {
            const type = rec.get('type');
            const value = rec.get('value');
            const cntRes = await session.run(
              `MATCH (i:Identifier {brand_id:$b, type:$t, hash:$h})-[r:IDENTIFIES]->(c:Customer)
               WHERE r.is_active = true AND r.created_at > $cutoff
               RETURN count(DISTINCT c.brain_id) AS cnt`,
              { b: brand.id, t: type, h: value, cutoff: cutoffMs },
            );
            const count = toNum(cntRes.records[0]?.get('cnt') ?? 0);
            if (count <= threshold) {
              await session.run(
                `MATCH (s:SharedUtility {brand_id:$b, identifier_type:$t, identifier_value:$h})
                 SET s.suppressed_until = null, s.profile_count = $c, s.reason = 'reeval_count_below_threshold'`,
                { b: brand.id, t: type, h: value, c: count },
              );
              totalUnsuppressed++;
              log.info(`[phone-guard-reeval] un-suppressed brand=${brand.id} type=${type} count=${count} threshold=${threshold}`);
            } else {
              const newUntil = nowMs + windowDays * 86_400_000;
              await session.run(
                `MATCH (s:SharedUtility {brand_id:$b, identifier_type:$t, identifier_value:$h})
                 SET s.suppressed_until = $until, s.profile_count = $c, s.reason = 'reeval_count_still_above_threshold'`,
                { b: brand.id, t: type, h: value, c: count, until: newUntil },
              );
              totalExtended++;
              log.info(`[phone-guard-reeval] extended brand=${brand.id} type=${type} count=${count} threshold=${threshold}`);
            }
          }
        } finally {
          await session.close();
        }
      } catch (err) {
        log.error(`error for brand ${brand.id}`, { err });
      }
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
