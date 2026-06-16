/**
 * BronzeRepository — writes BronzeRow values to the bronze_events Postgres table.
 *
 * Isolation invariant (D-8, NN-1):
 *   Every INSERT must be preceded by SELECT set_config('app.current_brand_id', brand_id, true)
 *   in the SAME transaction so the RLS policy sees the correct brand_id GUC.
 *   The stream-worker connects as brain_app (NOT brain superuser) so RLS is enforced.
 *
 * Idempotency backstop (I-ST04 / §5):
 *   ON CONFLICT (brand_id, event_id) DO NOTHING — the PK is the second dedup layer.
 *   Returns { inserted: false } when the PK detects a dup; caller treats as dedup-hit.
 *
 * GUC note (architecture-plan §4):
 *   SET LOCAL x = $1 is NOT valid SQL for custom GUCs. Use:
 *     SELECT set_config('app.current_brand_id', $1, true)
 *   The third arg (true) scopes the GUC to the current transaction (equivalent to
 *   SET LOCAL for transaction-block scope).
 */
import { Pool, PoolClient } from 'pg';
import { BronzeRow } from '../../domain/bronze/BronzeRow.js';

export interface WriteResult {
  /** true = row was inserted; false = PK conflict (dup, treat as dedup-hit) */
  inserted: boolean;
}

export class BronzeRepository {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    // Connect as brain_app (connection string must use brain_app credentials).
    // brain superuser bypasses RLS — never use it for data-plane writes (F-4 trap).
    this.pool = new Pool({
      connectionString,
      max: 5,
      idleTimeoutMillis: 30_000,
      statement_timeout: 10_000,
    });
  }

  /**
   * Write a BronzeRow to bronze_events.
   *
   * Transaction ordering (D-8 + D-7):
   *   1. BEGIN
   *   2. SELECT set_config('app.current_brand_id', brand_id, true) — GUC scoped to txn
   *   3. INSERT INTO bronze_events ... ON CONFLICT DO NOTHING
   *   4. COMMIT
   *   Caller commits Kafka offset ONLY AFTER this method returns successfully (D-7).
   *
   * @throws on any error except PK conflict (conflict → returns { inserted: false }).
   */
  async write(row: BronzeRow): Promise<WriteResult> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Set GUC scoped to this transaction (true = is_local, equivalent to SET LOCAL).
      // This is mandatory before any RLS-filtered query — the policy reads this GUC.
      // Architecture note: SET LOCAL app.current_brand_id = $1 is invalid SQL;
      // set_config('name', value, is_local) is the correct parametric form.
      await client.query(
        "SELECT set_config('app.current_brand_id', $1, true)",
        [row.brand_id],
      );

      const result = await client.query(
        `INSERT INTO bronze_events (
          brand_id, event_id, occurred_at, ingested_at,
          schema_name, schema_version, event_type, correlation_id,
          partition_key, payload, processing_flags, collector_version
        ) VALUES (
          $1, $2, $3::timestamptz, $4::timestamptz,
          $5, $6, $7, $8,
          $9, $10::jsonb, $11::jsonb, $12
        )
        ON CONFLICT (brand_id, event_id) DO NOTHING`,
        [
          row.brand_id,
          row.event_id,
          row.occurred_at,          // ISO-8601 string → timestamptz cast (D-6)
          row.ingested_at,          // ISO-8601 string → timestamptz cast (D-6)
          row.schema_name,
          row.schema_version,
          row.event_type,
          row.correlation_id,
          row.partition_key,
          JSON.stringify(row.payload),
          row.processing_flags != null ? JSON.stringify(row.processing_flags) : null,
          row.collector_version ?? null,
        ],
      );

      await client.query('COMMIT');

      // rowCount = 0 means ON CONFLICT triggered (PK duplicate — dedup-hit)
      const inserted = (result.rowCount ?? 0) > 0;
      return { inserted };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}
