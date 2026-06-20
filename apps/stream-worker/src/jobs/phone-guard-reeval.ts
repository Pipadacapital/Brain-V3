/**
 * phone-guard-reeval — Re-evaluation job for shared_utility_identifier (D-1).
 *
 * Argo CronJob entry point: invoked on a schedule (e.g. nightly) to un-suppress
 * phone identifiers whose suppression_window_days has expired and whose windowed
 * distinct brain_id count has dropped below phone_guard_threshold.
 *
 * Why windowed re-evaluation (not lifetime suppression):
 *   A kiosk phone bursts above threshold in one month → suppressed.
 *   After 30 days the window slides: if the phone now has ≤ threshold distinct
 *   customers, it can be re-eligible for merge.
 *   Lifetime suppression would permanently break LTV for legitimate repeat customers
 *   whose phone was caught in a burst event. (CTO FINDING-1, choice B rejected.)
 *
 * Algorithm:
 *   1. For each brand: fetch active suppressions where suppressed_until <= NOW() + buffer.
 *   2. Re-count windowed distinct brain_ids for each (within suppression_window_days).
 *   3. If count <= phone_guard_threshold → set suppressed_until = NULL (un-suppress).
 *   4. If count still > threshold → extend suppressed_until by another window.
 *
 * Connects as brain_app (RLS enforced). One txn per brand.
 * Idempotent: safe to run multiple times (un-suppress on same row = no-op).
 *
 * Usage: node dist/jobs/phone-guard-reeval.js
 *   or via Argo CronJob targeting this file.
 */

import { Pool } from 'pg';
import { log } from "../log.js";

const DB_URL =
  process.env['BRAIN_APP_DATABASE_URL'] ??
  'postgres://brain_app:brain_app@localhost:5432/brain';

async function run(): Promise<void> {
  const pool = new Pool({ connectionString: DB_URL, max: 3 });

  try {
    log.info('starting re-evaluation job');

    // Enumerate active brands via list_active_brand_ids() — a SECURITY DEFINER fn (0019) that
    // bypasses FORCE RLS for the cross-tenant id enumeration (durable rule
    // `system-job-force-rls-enumeration`). A bare `SELECT FROM brand` under brain_app with no
    // app.current_brand_id GUC returns ZERO rows (NN-1 fail-closed) — which silently made this
    // whole job a no-op. The per-brand config (threshold/window) is read INSIDE each brand's GUC
    // scope below, where RLS legitimately allows the single-brand read.
    const brandsRes = await pool.query<{ id: string }>(
      `SELECT id FROM list_active_brand_ids()`,
    );

    let totalUnsuppressed = 0;
    let totalExtended = 0;

    for (const brand of brandsRes.rows) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.current_brand_id', $1, true)", [brand.id]);

        // Per-brand config — read UNDER the brand GUC (RLS allows this single-brand read). These
        // columns are not returned by the enumeration fn (they are identity, not ledger, config).
        const cfgRes = await client.query<{
          phone_guard_threshold: number;
          suppression_window_days: number;
        }>(
          `SELECT phone_guard_threshold, suppression_window_days FROM brand WHERE id = $1`,
          [brand.id],
        );
        const brandCfg = cfgRes.rows[0];
        if (!brandCfg) {
          // Brand vanished between enumeration and read (deleted), or RLS scoped it out — skip.
          await client.query('ROLLBACK').catch(() => undefined);
          continue;
        }

        // Fetch suppressions that have expired or are near expiry
        const suiRes = await client.query<{
          identifier_type: string;
          identifier_value: string;
          suppressed_until: Date;
          window_days: number;
        }>(
          `SELECT identifier_type, identifier_value, suppressed_until, window_days
           FROM shared_utility_identifier
           WHERE brand_id = $1
             AND suppressed_until IS NOT NULL
             AND suppressed_until <= NOW()`,
          [brand.id],
        );

        for (const sui of suiRes.rows) {
          // Re-count windowed distinct brain_ids
          const countRes = await client.query<{ cnt: string }>(
            `SELECT COUNT(DISTINCT brain_id)::text AS cnt
             FROM identity_link
             WHERE brand_id = $1
               AND identifier_type = $2
               AND identifier_value = $3
               AND is_active = TRUE
               AND created_at > NOW() - ($4 || ' days')::interval`,
            [brand.id, sui.identifier_type, sui.identifier_value, brandCfg.suppression_window_days],
          );

          const count = parseInt(countRes.rows[0]?.cnt ?? '0', 10);

          if (count <= brandCfg.phone_guard_threshold) {
            // Below threshold after window → un-suppress
            await client.query(
              `UPDATE shared_utility_identifier
               SET suppressed_until = NULL,
                   profile_count = $4,
                   reason = 'reeval_count_below_threshold'
               WHERE brand_id = $1
                 AND identifier_type = $2
                 AND identifier_value = $3`,
              [brand.id, sui.identifier_type, sui.identifier_value, count],
            );
            totalUnsuppressed++;
            log.info(`[phone-guard-reeval] un-suppressed brand=${brand.id} ` +
                            `type=${sui.identifier_type} count=${count} threshold=${brandCfg.phone_guard_threshold}`);
          } else {
            // Still above threshold → extend suppression window
            const newSuppressedUntil = new Date();
            newSuppressedUntil.setDate(newSuppressedUntil.getDate() + brandCfg.suppression_window_days);
            await client.query(
              `UPDATE shared_utility_identifier
               SET suppressed_until = $5,
                   profile_count = $4,
                   reason = 'reeval_count_still_above_threshold'
               WHERE brand_id = $1
                 AND identifier_type = $2
                 AND identifier_value = $3`,
              [brand.id, sui.identifier_type, sui.identifier_value, count, newSuppressedUntil],
            );
            totalExtended++;
            log.info(`[phone-guard-reeval] extended suppression brand=${brand.id} ` +
                            `type=${sui.identifier_type} count=${count} threshold=${brandCfg.phone_guard_threshold} ` +
                            `new_until=${newSuppressedUntil.toISOString()}`);
          }
        }

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        log.error(`error for brand ${brand.id}`, { err: err });
      } finally {
        client.release();
      }
    }

    log.info(`complete: un-suppressed=${totalUnsuppressed} extended=${totalExtended}`);
  } finally {
    await pool.end();
  }
}

// Run when invoked directly
if (process.argv[1]?.endsWith('phone-guard-reeval.ts') || process.argv[1]?.endsWith('phone-guard-reeval.js')) {
  run().catch((err) => {
    log.error('fatal', { err: err });
    process.exit(1);
  });
}

export { run as runPhoneGuardReeval };
