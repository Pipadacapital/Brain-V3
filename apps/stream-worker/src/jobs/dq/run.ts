/**
 * dq/run.ts — the DQ check orchestrator + interval loop (Phase 7 / Track A).
 *
 * NOT a new deployable / topic / envelope. An interval loop wired into the already-
 * running apps/stream-worker/src/main.ts (mirrors startSyncRequestClaimer). Each tick:
 *   1. Enumerate active brands via list_active_brand_ids() (the SECURITY DEFINER fn —
 *      the SAME cross-tenant enumeration the revenue-finalization job uses; no GUC at
 *      this step, then scope per-brand).
 *   2. For each brand, run all 4 deterministic DQ executors (freshness, completeness,
 *      schema_validity, reconciliation), each connecting as brain_app under the brand GUC.
 *   3. Append one dq_check_result row per (brand, category, target) — frozen grade.
 *
 * The freshness check is the LIVE freshness-SLA monitor (acceptance). Per-brand errors
 * are isolated (one bad brand never stalls the tick). Tier-0 deterministic: no model.
 */

import { Pool } from 'pg';
import { freshnessCheck } from './freshness-check.js';
import { completenessCheck } from './completeness-check.js';
import { schemaValidityCheck } from './schema-validity-check.js';
import { reconciliationCheck } from './reconciliation-check.js';
import { writeDqResult, type DqCheckRow } from './writer.js';
import { createSilverReader, type SilverReader, type SilverReaderConfig } from './silver-reader.js';

interface BrandRow {
  id: string;
}

/**
 * Enumerate active brands via the SECURITY DEFINER fn (no GUC — discovering WHICH
 * brands to work for; the fn runs as the definer and bypasses the caller's RLS for
 * the id list only, no PII). Same pattern as revenue-finalization.
 */
async function enumerateActiveBrands(pool: Pool): Promise<string[]> {
  const r = await pool.query<BrandRow>(`SELECT id FROM list_active_brand_ids()`);
  return r.rows.map((row) => row.id);
}

/**
 * Run all 4 DQ checks for one brand and append the result rows. Returns the rows
 * written (for tests / observability). Each executor is independently try/caught so a
 * single failing check still records the others.
 */
export async function runDqChecksForBrand(
  pool: Pool,
  silver: SilverReader | null,
  brandId: string,
  now: Date = new Date(),
): Promise<DqCheckRow[]> {
  const written: DqCheckRow[] = [];

  const executors: Array<() => Promise<DqCheckRow[]>> = [
    () => freshnessCheck(pool, silver, brandId, now),
    () => completenessCheck(pool, brandId),
    () => schemaValidityCheck(pool, brandId),
    () => reconciliationCheck(pool, silver, brandId),
  ];

  for (const exec of executors) {
    let rows: DqCheckRow[] = [];
    try {
      rows = await exec();
    } catch (err) {
      console.error(`[dq] executor failed brand=${brandId}`, err);
      continue;
    }
    for (const row of rows) {
      try {
        await writeDqResult(pool, row);
        written.push(row);
      } catch (err) {
        console.error(
          `[dq] write failed brand=${brandId} category=${row.category} target=${row.target}`,
          err,
        );
      }
    }
  }

  return written;
}

/** One full tick: enumerate brands, run all checks for each. Returns rows written. */
export async function tick(pool: Pool, silver: SilverReader | null): Promise<number> {
  let total = 0;
  const brands = await enumerateActiveBrands(pool);
  for (const brandId of brands) {
    try {
      const rows = await runDqChecksForBrand(pool, silver, brandId);
      total += rows.length;
    } catch (err) {
      console.error(`[dq] brand tick failed brand=${brandId}`, err);
    }
  }
  return total;
}

export interface DqChecker {
  stop(): Promise<void>;
}

export interface StartDqChecksOptions {
  /** StarRocks (Silver) config for freshness + reconciliation. If absent, Silver checks emit honest D. */
  readonly silver?: SilverReaderConfig;
  readonly intervalMs?: number;
}

/**
 * Start the DQ interval checker. Returns a handle with stop() for graceful shutdown.
 * The pool MUST be a brain_app pool (RLS enforced) — never superuser 'brain'.
 * Mirrors startSyncRequestClaimer (single-flight, interval, graceful stop).
 */
export function startDqChecks(pool: Pool, opts: StartDqChecksOptions = {}): DqChecker {
  const intervalMs = opts.intervalMs ?? 300_000; // 5 min default (bounded indexed aggregate reads)
  const silver = opts.silver ? createSilverReader(opts.silver) : null;
  let running = true;
  let inFlight = false;

  const loop = async (): Promise<void> => {
    while (running) {
      if (!inFlight) {
        inFlight = true;
        try {
          const n = await tick(pool, silver);
          console.info(`[dq] tick complete — ${n} check rows written`);
        } catch (err) {
          console.error('[dq] tick error', err);
        } finally {
          inFlight = false;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  };

  void loop();

  return {
    stop: async (): Promise<void> => {
      running = false;
      if (silver) await silver.end().catch(() => undefined);
    },
  };
}
