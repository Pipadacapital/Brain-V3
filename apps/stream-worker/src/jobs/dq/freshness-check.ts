/**
 * dq/freshness-check.ts — the LIVE freshness-SLA monitor (Phase 7 acceptance).
 *
 * Measures the age of the latest row on each freshness target vs its max_age_minutes
 * SLA, grades it (frozen lookup), and returns one DqCheckRow per target. Targets:
 *   • bronze_events           — MAX(ingested_at)   (Postgres, brand-scoped under GUC)
 *   • connector_sync_status   — MAX(last_sync_at)   (Postgres, brand-scoped under GUC)
 *   • silver.order_state      — MAX(updated_at)     (StarRocks, brand-scoped at the seam)
 *
 * A target with NO rows for the brand is graded D (untrusted) with observed='no_data'
 * — honest-empty, never a false A+ (a brand with no data is NOT fresh, it is unknown).
 *
 * Deterministic given the same data + a fixed `now`: the grade is a frozen lookup over
 * the measured age. (The e2e test injects a fixed `now` to assert determinism.)
 */

import type { Pool } from 'pg';
import { gradeFreshness } from './grade.js';
import type { DqCheckRow } from './writer.js';
import { BRAND_PREDICATE, BRONZE_COLLECTOR_PREDICATE, ICEBERG_BRONZE, type SilverReader } from './silver-reader.js';
import { log } from "../../log.js";

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** Freshness SLA per target (max age in minutes). Frozen config — no model. */
export const FRESHNESS_SLA_MINUTES: Readonly<Record<string, number>> = {
  bronze_events: 60,
  connector_sync_status: 1440, // 24h — connectors sync on a slower cadence
  'silver.order_state': 120,
} as const;

function ageMinutes(latest: Date | null, now: Date): number | null {
  if (latest === null) return null;
  return (now.getTime() - latest.getTime()) / 60_000;
}

function toRow(
  brandId: string,
  target: string,
  latest: Date | null,
  now: Date,
): DqCheckRow {
  const sla = FRESHNESS_SLA_MINUTES[target] ?? 60;
  const age = ageMinutes(latest, now);
  if (age === null) {
    // No data → untrusted (D), honest-empty. NOT graded as "fresh".
    return {
      brandId,
      category: 'freshness',
      target,
      grade: 'D',
      score: null,
      observed: 'no_data',
      threshold: String(sla),
      passing: false,
    };
  }
  const outcome = gradeFreshness(age, sla);
  return {
    brandId,
    category: 'freshness',
    target,
    grade: outcome.grade,
    score: outcome.score,
    observed: Math.round(age).toString(),
    threshold: String(sla),
    passing: outcome.passing,
  };
}

/**
 * Run the freshness check for one brand. Reads under the brand GUC (Postgres) and
 * the brand-scoped Silver seam (StarRocks). `now` is injectable for deterministic tests.
 */
export async function freshnessCheck(
  pool: Pool,
  silver: SilverReader | null,
  brandId: string,
  now: Date = new Date(),
): Promise<DqCheckRow[]> {
  const rows: DqCheckRow[] = [];

  // ── Postgres targets (brand-scoped under GUC, inside a txn so is_local GUC holds) ──
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.current_brand_id', $1, true),
              set_config('app.current_user_id', $2, true),
              set_config('app.current_workspace_id', $2, true)`,
      [brandId, NIL_UUID],
    );

    // bronze_events freshness moved to the Iceberg Bronze SoR (read via StarRocks below). Only the
    // operational connector_sync_status remains a PG freshness target.
    const sync = await client.query<{ latest: Date | null }>(
      `SELECT MAX(last_sync_at) AS latest FROM connector_sync_status WHERE brand_id = $1`,
      [brandId],
    );
    rows.push(toRow(brandId, 'connector_sync_status', sync.rows[0]?.latest ?? null, now));
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  // ── Lakehouse targets (StarRocks: Iceberg Bronze + Silver, brand-scoped at the seam) ──
  // bronze_events freshness now reads the Iceberg Bronze SoR (collector_events), NOT PG.
  if (silver !== null) {
    // Bronze (Iceberg) freshness.
    try {
      const br = await silver.scopedQuery<{ latest: string | null }>(
        brandId,
        `SELECT MAX(ingested_at) AS latest FROM ${ICEBERG_BRONZE} WHERE ${BRONZE_COLLECTOR_PREDICATE} AND ${BRAND_PREDICATE}`,
      );
      const raw = br[0]?.latest ?? null;
      rows.push(toRow(brandId, 'bronze_events', raw ? new Date(raw) : null, now));
    } catch (err) {
      log.error(`iceberg bronze freshness read failed brand=${brandId}`, { err: err });
      rows.push({
        brandId, category: 'freshness', target: 'bronze_events', grade: 'D', score: null,
        observed: 'unreachable', threshold: String(FRESHNESS_SLA_MINUTES['bronze_events'] ?? 60), passing: false,
      });
    }
    // Silver freshness.
    try {
      const sr = await silver.scopedQuery<{ latest: string | null }>(
        brandId,
        `SELECT MAX(updated_at) AS latest FROM brain_serving.mv_silver_order_state WHERE ${BRONZE_COLLECTOR_PREDICATE} AND ${BRAND_PREDICATE}`,
      );
      const raw = sr[0]?.latest ?? null;
      // raw is a JS Date (mysql2 parses DATETIME) built using the pool's UTC timezone (see
      // silver-reader createPool timezone:'Z') so the absolute instant is correct on any worker tz.
      rows.push(toRow(brandId, 'silver.order_state', raw ? new Date(raw) : null, now));
    } catch (err) {
      // Silver unreachable → honest D row, never a silent skip (the surface must show it).
      log.error(`silver read failed brand=${brandId}`, { err: err });
      rows.push({
        brandId,
        category: 'freshness',
        target: 'silver.order_state',
        grade: 'D',
        score: null,
        observed: 'unreachable',
        threshold: String(FRESHNESS_SLA_MINUTES['silver.order_state'] ?? 120),
        passing: false,
      });
    }
  } else {
    // No StarRocks wired → bronze_events (now lakehouse-only) is unknown → honest D (never a false A+).
    // silver.order_state is skipped (not emitted) when Silver is disabled — matching prior behavior.
    rows.push({
      brandId, category: 'freshness', target: 'bronze_events', grade: 'D', score: null,
      observed: 'unreachable', threshold: String(FRESHNESS_SLA_MINUTES['bronze_events'] ?? 60), passing: false,
    });
  }

  return rows;
}
