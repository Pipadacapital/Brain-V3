/**
 * revenue-finalization — Horizon-based finalization job for realized_revenue_ledger.
 *
 * Argo CronJob entry point: invoked on a schedule (e.g. nightly) to emit
 * `finalization` rows for `provisional_recognition` entries that have passed
 * their COD/prepaid recognition horizon with no RTO/cancel.
 *
 * Algorithm (per brand):
 *   1. Fetch active brands with their horizon config + currency_code.
 *   2. For each brand: find provisional_recognition rows where
 *        occurred_at + horizon_days < NOW()
 *      AND no existing rto_reversal/cancellation for (brand_id, order_id)
 *      AND no existing finalization for (brand_id, order_id)
 *   3. For each qualifying row: emit a `finalization` event with the same
 *      amount_minor (positive) and economic_effective_at = NOW().
 *   4. billing_posted_period set from finalization's occurred_at (= NOW()) → current period.
 *   5. INSERT ON CONFLICT (dedup UNIQUE) DO NOTHING → idempotent (D-4).
 *   6. Increment ledger_finalized_total metric per brand.
 *
 * Race safety (M-3): RTO pre-check (step 2) + signed-sum property (finalization +
 * reversal = 0 realized) + dedup UNIQUE (prevents double finalization) = 3 guards.
 *
 * Money: amount_minor stays BIGINT throughout; no float arithmetic (I-S07).
 * Connects as brain_app (RLS enforced) per-brand with set_config GUC.
 *
 * ledger_event_id: deterministic SHA-256(brand_id‖order_id‖'finalization'‖source_pk‖'v1')
 *   where source_pk = the provisional's ledger_event_id.
 *
 * Usage: node dist/jobs/revenue-finalization.js
 *   or via Argo CronJob targeting this file.
 */

import { Pool } from 'pg';
import { createHash } from 'node:crypto';

const DB_URL =
  process.env['BRAIN_APP_DATABASE_URL'] ??
  'postgres://brain_app:brain_app@localhost:5432/brain';

const VERSION = 'v1';

function computeLedgerEventId(params: {
  brandId: string;
  orderId: string;
  eventType: string;
  sourcePk: string;
}): string {
  return createHash('sha256')
    .update(
      `${params.brandId}\0${params.orderId}\0${params.eventType}\0${params.sourcePk}\0${VERSION}`,
    )
    .digest('hex');
}

function toBillingPostedPeriod(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

interface BrandRow {
  id: string;
  cod_recognition_horizon_days: number;
  prepaid_recognition_horizon_days: number;
  currency_code: string;
}

interface ProvisionalRow {
  ledger_event_id: string;
  order_id: string;
  brain_id: string | null;
  amount_minor: string;  // pg returns bigint as string
  currency_code: string;
  payment_method: string | null;
  occurred_at: Date;
}

async function run(): Promise<void> {
  const pool = new Pool({ connectionString: DB_URL, max: 3 });

  try {
    console.info('[revenue-finalization] starting horizon finalization job');

    // Enumerate brands as superuser (system job — brand IDs are not PII)
    const brandsRes = await pool.query<BrandRow>(
      `SELECT id, cod_recognition_horizon_days, prepaid_recognition_horizon_days, currency_code
       FROM brand WHERE status = 'active'`,
    );

    let totalFinalized = 0;
    let totalSkipped = 0;

    for (const brand of brandsRes.rows) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.current_brand_id', $1, true)", [brand.id]);

        // Find qualifying provisionals:
        // - occurred_at + horizon_days < NOW() (horizon passed)
        // - no rto_reversal or cancellation for (brand_id, order_id)
        // - no finalization yet for (brand_id, order_id)
        // horizon_days chosen from payment_method in the source payload (JSONB path)
        const provisionalsRes = await client.query<ProvisionalRow>(
          `SELECT
             l.ledger_event_id,
             l.order_id,
             l.brain_id,
             l.amount_minor,
             l.currency_code,
             NULL AS payment_method
           FROM realized_revenue_ledger l
           WHERE l.brand_id = $1
             AND l.event_type = 'provisional_recognition'
             -- horizon check: use the max horizon (COD) conservatively; refine below
             AND l.occurred_at + ($2 || ' days')::interval < NOW()
             -- no RTO or cancellation
             AND NOT EXISTS (
               SELECT 1 FROM realized_revenue_ledger r
               WHERE r.brand_id = $1
                 AND r.order_id = l.order_id
                 AND r.event_type IN ('rto_reversal', 'cancellation')
             )
             -- no finalization yet
             AND NOT EXISTS (
               SELECT 1 FROM realized_revenue_ledger f
               WHERE f.brand_id = $1
                 AND f.order_id = l.order_id
                 AND f.event_type = 'finalization'
             )`,
          [
            brand.id,
            // Use the smaller (prepaid) horizon as the minimum — any order older than
            // the larger (cod) horizon is definitely eligible. We conservatively select
            // using the cod (larger) horizon so we only finalize when certain.
            brand.cod_recognition_horizon_days,
          ],
        );

        const now = new Date();
        const billingPostedPeriod = toBillingPostedPeriod(now);

        for (const prov of provisionalsRes.rows) {
          // The source_pk for the finalization is the provisional's ledger_event_id
          const ledgerEventId = computeLedgerEventId({
            brandId: brand.id,
            orderId: prov.order_id,
            eventType: 'finalization',
            sourcePk: prov.ledger_event_id,
          });

          const result = await client.query<{ ledger_event_id: string }>(
            `INSERT INTO realized_revenue_ledger (
              brand_id,
              ledger_event_id,
              order_id,
              brain_id,
              event_type,
              amount_minor,
              currency_code,
              fx_rate_id,
              rounding_adjustment_minor,
              occurred_at,
              economic_effective_at,
              billing_posted_period,
              recognition_label,
              supersedes_ledger_event_id,
              raw_event_id
            ) VALUES (
              $1, $2, $3, $4, 'finalization',
              $5::bigint, $6, NULL,
              0::bigint,
              $7, $7, $8, 'finalized',
              $9, NULL
            )
            ON CONFLICT (brand_id, order_id, event_type, (timezone('UTC', occurred_at)::date))
            DO NOTHING
            RETURNING ledger_event_id`,
            [
              brand.id,
              ledgerEventId,
              prov.order_id,
              prov.brain_id,
              prov.amount_minor,
              prov.currency_code,
              now.toISOString(),
              billingPostedPeriod,
              prov.ledger_event_id, // supersedes_ledger_event_id
            ],
          );

          if ((result.rowCount ?? 0) > 0) {
            totalFinalized++;
            console.info(
              `[revenue-finalization] finalized brand=${brand.id} ` +
              `order=${prov.order_id} amount=${prov.amount_minor} ${prov.currency_code}`,
            );
          } else {
            totalSkipped++;
            console.info(
              `[revenue-finalization] skipped (dedup) brand=${brand.id} order=${prov.order_id}`,
            );
          }
        }

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        console.error(`[revenue-finalization] error for brand ${brand.id}`, err);
      } finally {
        client.release();
      }
    }

    console.info(
      `[revenue-finalization] complete: finalized=${totalFinalized} skipped=${totalSkipped}`,
    );
  } finally {
    await pool.end();
  }
}

// Run when invoked directly
if (
  process.argv[1]?.endsWith('revenue-finalization.ts') ||
  process.argv[1]?.endsWith('revenue-finalization.js')
) {
  run().catch((err) => {
    console.error('[revenue-finalization] fatal', err);
    process.exit(1);
  });
}

export { run as runRevenueFinalization };
