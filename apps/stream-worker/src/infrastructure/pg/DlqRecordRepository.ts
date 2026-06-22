/**
 * DlqRecordRepository — persists Kafka dead-letters into connectors.connector_dlq_record
 * for forensic retention beyond the 30d Kafka DLQ window.
 *
 * IDEMPOTENCY:
 *   dlq_id is a DETERMINISTIC UUID v5 derived from (source_topic, partition, kafka_offset).
 *   created_at is set to date_trunc('day', now()) — day-granular.
 *   Same Kafka address written on the same calendar day:
 *     → same dlq_id + same created_at → same PK → ON CONFLICT (brand_id, dlq_id, created_at)
 *       DO NOTHING. Dedup fires.
 *   Cross-day re-writes (operator runs redrive on a new day):
 *     → same dlq_id but different created_at → a second row in a different partition.
 *     Acceptable for a forensic store (both rows are accurate: message was seen twice).
 *   In normal operations, Kafka consumer groups commit offsets after reading; the same
 *   offset is never re-read in the same session, so same-day dedup is sufficient.
 *
 * RLS: every INSERT is wrapped in a transaction that sets the brand GUC before the write
 * (NN-1 / I-S01 pattern). brain_app is NOBYPASSRLS; the GUC must be set correctly or the
 * RLS policy sees no brand and the INSERT is blocked.
 *
 * Schema: connectors.connector_dlq_record (migration 0094).
 */
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

/** UUID v5 namespace (DNS-like, arbitrary fixed value for DLQ address dedup). */
const DLQ_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'; // UUID v5 DNS namespace

/**
 * Derive a deterministic UUID v5 for a Kafka address triple.
 * Same (sourceTopic, partition, kafkaOffset) → same UUID every time.
 * This is the idempotency key for connector_dlq_record.
 */
export function deriveDlqId(
  sourceTopic: string,
  partition: number,
  kafkaOffset: bigint | number,
): string {
  // UUID v5 = SHA-1 of namespace || name, formatted as UUID.
  const name = `${sourceTopic}:${partition}:${String(kafkaOffset)}`;
  const nsBytes = Buffer.from(DLQ_NAMESPACE.replace(/-/g, ''), 'hex');
  const nameBytes = Buffer.from(name, 'utf8');
  const hash = createHash('sha1')
    .update(nsBytes)
    .update(nameBytes)
    .digest();
  // Set version bits (v5 = 0x50) and variant bits (RFC 4122 = 0x80).
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const h = hash.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export interface DlqRecordInput {
  /** Tenant key — also the RLS GUC value. */
  brandId: string;
  /** Kafka topic the message was DLQ'd from (e.g. 'dev.collector.event.v1.dlq'). */
  sourceTopic: string;
  /** Kafka partition. */
  partition: number;
  /** Kafka offset. */
  kafkaOffset: bigint | number;
  /** Connector provider label (e.g. 'shopify', 'gokwik', 'razorpay', 'unknown'). */
  provider: string;
  /** Message body — caller must sanitise raw PII before passing (pass {} if unknown). */
  payload: Record<string, unknown>;
  /** Short error class / code (e.g. 'ECONNREFUSED', 'max_retry_exceeded'). */
  errorClass: string;
  /** Short human-readable description. NOT a raw stack trace. */
  errorDetail?: string;
}

export interface DlqRecordWriteResult {
  /**
   * true = row was inserted (first time we see this Kafka address today).
   * false = ON CONFLICT triggered — duplicate, already recorded.
   */
  inserted: boolean;
  /** The deterministic dlq_id used for this write. */
  dlqId: string;
}

export class DlqRecordRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Persist a dead-letter to connector_dlq_record.
   *
   * Idempotent within the same calendar day: identical (source_topic, partition, kafka_offset)
   * written on the same day → ON CONFLICT DO NOTHING.
   * Returns { inserted: false } on a dedup hit.
   *
   * @throws on any error except the idempotency conflict.
   */
  async persist(input: DlqRecordInput): Promise<DlqRecordWriteResult> {
    const dlqId = deriveDlqId(input.sourceTopic, input.partition, input.kafkaOffset);
    // Day-granular created_at: same message re-written on the same day → same PK → dedup.
    const createdAt = new Date(
      new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z',
    ).toISOString();

    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // NN-1 / I-S01: GUC scoped to this transaction so the FORCE RLS policy
      // can verify brand_id on the new row.
      await client.query(
        "SELECT set_config('app.current_brand_id', $1, true)",
        [input.brandId],
      );

      const result = await client.query<{ dlq_id: string }>(
        `INSERT INTO connectors.connector_dlq_record
           (dlq_id, brand_id, source_topic, partition, kafka_offset,
            provider, payload, error_class, error_detail, created_at)
         VALUES
           ($1, $2, $3, $4, $5::bigint, $6, $7::jsonb, $8, $9, $10::timestamptz)
         ON CONFLICT (brand_id, dlq_id, created_at) DO NOTHING
         RETURNING dlq_id`,
        [
          dlqId,
          input.brandId,
          input.sourceTopic,
          input.partition,
          String(input.kafkaOffset),    // bigint as string (I-S07)
          input.provider,
          JSON.stringify(input.payload),
          input.errorClass,
          input.errorDetail ?? '',
          createdAt,
        ],
      );

      await client.query('COMMIT');

      const inserted = (result.rowCount ?? 0) > 0;
      return { inserted, dlqId };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Increment redrive_count for a specific dead-letter (called by the dlq-redrive job
   * when a message is successfully republished to its original topic).
   *
   * Idempotent enough: if the message has already been successfully redriven, the row
   * simply gets a higher count (which is accurate: it was redriven again).
   *
   * brand_id is required to satisfy the FORCE RLS policy on the table.
   */
  async incrementRedriveCount(
    brandId: string,
    sourceTopic: string,
    partition: number,
    kafkaOffset: bigint | number,
  ): Promise<void> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT set_config('app.current_brand_id', $1, true)",
        [brandId],
      );
      // Update all rows for this Kafka address (may be >1 if cross-day duplicates exist).
      await client.query(
        `UPDATE connectors.connector_dlq_record
            SET redrive_count = redrive_count + 1
          WHERE brand_id    = $1
            AND source_topic = $2
            AND partition    = $3
            AND kafka_offset = $4::bigint`,
        [brandId, sourceTopic, partition, String(kafkaOffset)],
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
