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

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** Max tolerated transient orphans (ledger order_ids not yet in Bronze) before grading degrades. */
export const MAX_PROVENANCE_ORPHANS = 50;

export const PROVENANCE_TARGET = 'bronze_vs_gold.realized_revenue';

export async function bronzeLedgerProvenanceCheck(
  pool: Pool,
  brandId: string,
): Promise<DqCheckRow[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // GUC BEFORE the brand-scoped reads (NN-1 / RLS FORCE — brain_app, never superuser).
    await client.query(
      `SELECT set_config('app.current_brand_id', $1, true),
              set_config('app.current_user_id', $2, true),
              set_config('app.current_workspace_id', $2, true)`,
      [brandId, NIL_UUID],
    );

    // Orphans = DISTINCT ledger order_ids with NO matching order.* event in Bronze for this brand.
    // order_id lives at payload->'properties'->>'order_id' on order.* collector events (COALESCE the
    // top-level form for legacy/synthetic payloads — same extraction as the reconciliation check).
    const r = await client.query<{ orphans: string; ledger_orders: string }>(
      `WITH ledger_orders AS (
         SELECT DISTINCT order_id
           FROM realized_revenue_ledger
          WHERE brand_id = $1
       ),
       bronze_orders AS (
         SELECT DISTINCT COALESCE(payload->'properties'->>'order_id', payload->>'order_id') AS order_id
           FROM bronze_events
          WHERE brand_id = $1
            AND event_type LIKE 'order.%'
            AND COALESCE(payload->'properties'->>'order_id', payload->>'order_id') IS NOT NULL
       )
       SELECT
         COUNT(*) FILTER (WHERE b.order_id IS NULL)::text AS orphans,
         COUNT(*)::text                                   AS ledger_orders
       FROM ledger_orders l
       LEFT JOIN bronze_orders b ON b.order_id = l.order_id`,
      [brandId],
    );
    await client.query('COMMIT');

    const orphans = Number(r.rows[0]?.orphans ?? '0');
    const ledgerOrders = Number(r.rows[0]?.ledger_orders ?? '0');
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
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
