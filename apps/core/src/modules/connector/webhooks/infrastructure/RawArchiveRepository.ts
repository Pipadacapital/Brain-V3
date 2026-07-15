/**
 * RawArchiveRepository — generic raw-webhook archive writer (all 4 providers).
 *
 * Generalises the Shopify-only archiveRawWebhook() to work for Shopify, Razorpay,
 * Shopflo, and WooCommerce. Writes to connector_webhook_raw_archive (RANGE-partitioned
 * by received_at — migration 0094).
 *
 * SECURITY CONTRACT:
 *   - Writes under the brand GUC (SET LOCAL app.current_brand_id) in a single txn
 *     so FORCE RLS is satisfied (NN-1 / I-S02).
 *   - redactedBody MUST be pre-redacted by the caller (raw PII never reaches this fn).
 *   - ON CONFLICT arbiter = the table's UNIQUE (brand_id, topic, body_sha256, received_at).
 *     connector_webhook_raw_archive is RANGE-partitioned by received_at (0094), and Postgres
 *     REQUIRES a partitioned table's unique constraint to include the partition key — so the
 *     arbiter MUST list received_at (a 3-col ON CONFLICT threw 42P10 "no unique or exclusion
 *     constraint matching the ON CONFLICT specification" on every webhook, 2026-07-16). received_at
 *     = NOW() so this dedups only an exact-timestamp double-insert; genuine content-dedup of a
 *     re-delivery is handled upstream by the Redis C3 dedup + the Bronze MERGE, not here.
 *
 * Fire-and-forget semantics: errors are thrown so the caller can log + suppress.
 */

import { createHash } from 'node:crypto';
import type pg from 'pg';

export interface RawArchiveEntry {
  brandId: string;
  provider: string;
  topic: string;
  rawBody: Buffer;
  redactedBody: unknown;
  correlationId: string;
}

export class RawArchiveRepository {
  constructor(private readonly rawPgPool: pg.Pool) {}

  /**
   * Archive a single webhook event in PII-safe form.
   *
   * @param entry  Archive entry — redactedBody MUST already be PII-scrubbed by the caller.
   */
  async write(entry: RawArchiveEntry): Promise<void> {
    const bodySha256 = createHash('sha256').update(entry.rawBody).digest('hex');
    const client = await this.rawPgPool.connect();
    try {
      await client.query('BEGIN');
      // GUC txn-local: required for connector_webhook_raw_archive FORCE RLS (NN-1 / 0050).
      await client.query(`SELECT set_config('app.current_brand_id', $1, true)`, [entry.brandId]);
      // SCHEMA-QUALIFIED (connectors.*): on the raw pool the pgbouncer session search_path is not
      // guaranteed to include `connectors`, and an unqualified name makes the ON CONFLICT arbiter
      // inference fail even when the constraint exists (same class as the ShopifyWebhookStrategy fix).
      await client.query(
        `INSERT INTO connectors.connector_webhook_raw_archive
           (brand_id, source, topic, body_sha256, received_at, correlation_id, redacted_body)
         VALUES ($1, $2, $3, $4, NOW(), $5, $6)
         ON CONFLICT (brand_id, topic, body_sha256, received_at) DO NOTHING`,
        [
          entry.brandId,
          entry.provider,
          entry.topic,
          bodySha256,
          entry.correlationId,
          JSON.stringify(entry.redactedBody),
        ],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
