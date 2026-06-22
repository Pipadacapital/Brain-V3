/**
 * dq/bronze-ledger-provenance-check.ts — P2.4: EXECUTABLE proof that "Bronze is source of truth"
 * for the Gold revenue ledger.
 *
 * The medallion invariant is that every Gold ledger row is REBUILDABLE by replaying Bronze. The
 * architecture upholds it by construction — every connector repull (Meta/Google spend, Razorpay
 * settlement, GoKwik AWB) and every live/backfill order emits to the live topic, which
 * CollectorEventConsumer writes to bronze_events BEFORE the ledger-bridge consumers read the same
 * events. But that guarantee lived only in comments and an architecture trace; nothing MEASURED it.
 *
 * This check measures it: for a brand, an `order_id` present in realized_revenue_ledger but with NO
 * corresponding `order.*` event in bronze_events is an ORPHAN — a ledger row Bronze cannot rebuild,
 * i.e. a direct "Bronze is source of truth" violation. Zero orphans → A+.
 *
 * TOLERANCE (why not strict zero): Bronze (group brain.stream-worker.live) and the ledger bridges
 * (live-ledger-bridge etc.) are INDEPENDENT consumer groups on the same topic, so a ledger row can
 * momentarily precede its Bronze write. Those transient orphans self-heal as the Bronze group
 * catches up, so we grade |orphans| against a small tolerance (mirrors the Bronze↔Silver
 * reconciliation check). A SUSTAINED / large orphan count is a genuine rebuildability breach and
 * grades D — surfaced on the data-quality page and alertable.
 *
 * Reuses category 'reconciliation' (it IS a cross-tier reconciliation) with a distinct target so it
 * needs no new Dq category / migration; the DQ UI renders it alongside Bronze↔Silver.
 */
import type { Pool } from 'pg';
import { gradeReconciliation } from './grade.js';
import type { DqCheckRow } from './writer.js';
import { BRAND_PREDICATE, ICEBERG_BRONZE, type SilverReader } from './silver-reader.js';
import { log } from '../../log.js';

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** Max tolerated transient orphans (ledger order_ids not yet in Bronze) before grading degrades. */
export const MAX_PROVENANCE_ORPHANS = 50;

export const PROVENANCE_TARGET = 'bronze_vs_gold.realized_revenue';

/**
 * DB-AUDIT C4: Bronze is now the Iceberg SoR (StarRocks), while the ledger stays in PG — so this is a
 * cross-store check. We fetch DISTINCT ledger order_ids (PG, brand-scoped GUC) and DISTINCT Bronze
 * order_ids (StarRocks, brand-scoped seam) and compute the orphan set in app code (per-brand order
 * cardinality is bounded). An orphan = a ledger order_id with NO order.* event in Bronze → a "Bronze
 * is source of truth" violation.
 */
export async function bronzeLedgerProvenanceCheck(
  pool: Pool,
  silver: SilverReader | null,
  brandId: string,
): Promise<DqCheckRow[]> {
  if (silver === null) {
    return [{ brandId, category: 'reconciliation', target: PROVENANCE_TARGET, grade: 'D', score: null,
      observed: 'bronze_unreachable', threshold: String(MAX_PROVENANCE_ORPHANS), passing: false }];
  }

  // ── Ledger order_ids (PG, brand-scoped under GUC) ──────────────────────────
  const ledgerOrderIds: string[] = [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.current_brand_id', $1, true),
              set_config('app.current_user_id', $2, true),
              set_config('app.current_workspace_id', $2, true)`,
      [brandId, NIL_UUID],
    );
    const r = await client.query<{ order_id: string | null }>(
      `SELECT DISTINCT order_id FROM realized_revenue_ledger WHERE brand_id = $1`,
      [brandId],
    );
    for (const row of r.rows) if (row.order_id != null) ledgerOrderIds.push(row.order_id);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  // ── Bronze order_ids (Iceberg SoR via StarRocks, brand-scoped at the seam) ──
  const bronzeOrderIds = new Set<string>();
  try {
    const br = await silver.scopedQuery<{ order_id: string | null }>(
      brandId,
      `SELECT DISTINCT COALESCE(get_json_string(payload, '$.properties.order_id'), get_json_string(payload, '$.order_id')) AS order_id
         FROM ${ICEBERG_BRONZE}
        WHERE ${BRAND_PREDICATE}
          AND event_type LIKE 'order.%'`,
    );
    for (const row of br) if (row.order_id != null) bronzeOrderIds.add(row.order_id);
  } catch (err) {
    log.error(`iceberg bronze provenance read failed brand=${brandId}`, { err: err });
    return [{ brandId, category: 'reconciliation', target: PROVENANCE_TARGET, grade: 'D', score: null,
      observed: 'bronze_unreachable', threshold: String(MAX_PROVENANCE_ORPHANS), passing: false }];
  }

  const orphans = ledgerOrderIds.filter((id) => !bronzeOrderIds.has(id)).length;
  const ledgerOrders = ledgerOrderIds.length;
  const outcome = gradeReconciliation(orphans, MAX_PROVENANCE_ORPHANS);

  return [
    {
      brandId,
      category: 'reconciliation',
      target: PROVENANCE_TARGET,
      grade: outcome.grade,
      score: outcome.score,
      // observed encodes both the orphan count and the ledger population it was measured against.
      observed: `orphans=${orphans} of ${ledgerOrders} ledger_orders`,
      threshold: String(MAX_PROVENANCE_ORPHANS),
      passing: outcome.passing,
    },
  ];
}
