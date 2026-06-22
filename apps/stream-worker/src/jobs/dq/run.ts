/**
 * dq/run.ts — the DQ check orchestrator + interval loop (Phase 7 / Track A).
 *
 * NOT a new deployable / topic / envelope. An interval loop wired into the already-
 * running apps/stream-worker/src/main.ts (mirrors startSyncRequestClaimer). Each tick:
 *   1. Enumerate active brands via list_active_brand_ids() (the SECURITY DEFINER fn —
 *      the SAME cross-tenant enumeration the revenue-finalization job uses; no GUC at
 *      this step, then scope per-brand).
 *   2. For each brand, run all 5 deterministic DQ executors (freshness, completeness,
 *      schema_validity, reconciliation ×2: Bronze↔Silver + Bronze→Gold-ledger provenance),
 *      each connecting as brain_app under the brand GUC.
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
import { bronzeLedgerProvenanceCheck } from './bronze-ledger-provenance-check.js';
import { writeDqResult, type DqCheckRow } from './writer.js';
import { createSilverReader, type SilverReader, type SilverReaderConfig } from './silver-reader.js';
import { withTickLeaderLock, LEADER_LOCK_DQ_CHECKS } from '../../infrastructure/pg/LeaderLock.js';
import { log } from "../../log.js";

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
 * Run all 5 DQ checks for one brand and append the result rows. Returns the rows
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
    () => completenessCheck(pool, silver, brandId),
    () => schemaValidityCheck(pool, silver, brandId),
    () => reconciliationCheck(pool, silver, brandId),
    // P2.4: Bronze→Gold rebuildability proof — ledger order_ids must trace to a Bronze order event.
    () => bronzeLedgerProvenanceCheck(pool, silver, brandId),
  ];

  for (const exec of executors) {
    let rows: DqCheckRow[] = [];
    try {
      rows = await exec();
    } catch (err) {
      log.error(`executor failed brand=${brandId}`, { err: err });
      continue;
    }
    for (const row of rows) {
      try {
        await writeDqResult(pool, row);
        written.push(row);
      } catch (err) {
        log.error(`write failed brand=${brandId} category=${row.category} target=${row.target}`, { err: err });
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
      log.error(`brand tick failed brand=${brandId}`, { err: err });
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
          // P1: single-leader across replicas — one DQ pass per interval, not N× duplicate compute.
          const out = await withTickLeaderLock(pool, LEADER_LOCK_DQ_CHECKS, () => tick(pool, silver));
          if (out.ranAsLeader) log.info(`tick complete — ${out.result} check rows written`);
        } catch (err) {
          log.error('tick error', { err: err });
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
