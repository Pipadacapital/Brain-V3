/**
 * ConsentRepository — writes consent_record / consent_tombstone rows to Postgres.
 *
 * Mirrors IdentityRepository discipline (architecture §3):
 *   ONE transaction: BEGIN → set_config('app.current_brand_id', $1, true) → INSERTs
 *   ON CONFLICT DO NOTHING → COMMIT. Connects as brain_app (NEVER superuser brain)
 *   so RLS FORCE is enforced (a missing/wrong GUC → 0 rows; cross-brand write blocked).
 *
 * GUC note: SET LOCAL x=$1 is invalid for custom GUCs.
 *   Use: SELECT set_config('app.current_brand_id', $1, true)  (is_local = txn-scoped).
 *
 * IDEMPOTENCY (D-4): every INSERT is ON CONFLICT DO NOTHING against the
 *   source_event_id dedup unique indexes from 0032. Replay (3× the same collector
 *   event) → exactly one row per (subject, category, event). The repository never
 *   throws on a dedup hit; the consumer commits the offset on a clean return.
 *
 * APPEND-ONLY: brain_app holds INSERT only (no UPDATE/DELETE grant — 0032 Assertion-2).
 *   Corrections are a new row with a later effective_at, never an in-place mutation.
 *
 * No raw PII: subject_hash is a 64-hex identity-core hash; nothing raw is written.
 */
import { Pool } from 'pg';

export type ConsentCategory =
  | 'analytics'
  | 'marketing'
  | 'personalization'
  | 'ai_processing';

export interface ConsentRecordRow {
  brandId: string;
  subjectHash: string;
  category: ConsentCategory;
  state: 'granted' | 'withdrawn';
  source: 'collector' | 'operator' | 'api' | 'import' | 'consent_manager';
  policyVersion: string;
  sourceEventId: string | null;
}

export interface ConsentTombstoneRow {
  brandId: string;
  subjectHash: string;
  category: ConsentCategory | null; // null = all categories
  reason: 'withdrawal' | 'erasure';
  source: 'collector' | 'operator' | 'api' | 'consent_manager';
  sourceEventId: string | null;
}

export class ConsentRepository {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    // brain_app credentials — RLS FORCE enforced on consent_record/consent_tombstone.
    this.pool = new Pool({
      connectionString,
      max: 5,
      idleTimeoutMillis: 30_000,
      statement_timeout: 15_000,
    });
  }

  /**
   * Write a projected consent state in one transaction.
   * GUC-scoped to brandId; all INSERTs idempotent (ON CONFLICT DO NOTHING).
   * Returns { written:true } always — a dedup hit is not an error.
   */
  async writeProjection(
    brandId: string,
    records: ConsentRecordRow[],
    tombstones: ConsentTombstoneRow[],
  ): Promise<{ written: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_brand_id', $1, true)", [brandId]);

      for (const r of records) {
        // Dedup target: the partial unique index on (brand_id, subject_hash, category,
        // source_event_id) WHERE source_event_id IS NOT NULL. When source_event_id is
        // present, a replay is a no-op. When NULL (operator writes), the PK's effective_at
        // (NOW()) makes each a distinct append-only row.
        await client.query(
          `INSERT INTO consent_record
             (brand_id, subject_hash, category, state, source, policy_version, source_event_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (brand_id, subject_hash, category, source_event_id)
             WHERE source_event_id IS NOT NULL
           DO NOTHING`,
          [r.brandId, r.subjectHash, r.category, r.state, r.source, r.policyVersion, r.sourceEventId],
        );
      }

      for (const t of tombstones) {
        await client.query(
          `INSERT INTO consent_tombstone
             (brand_id, subject_hash, category, reason, source, source_event_id)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (brand_id, subject_hash, COALESCE(category, '*'), source_event_id)
             WHERE source_event_id IS NOT NULL
           DO NOTHING`,
          [t.brandId, t.subjectHash, t.category, t.reason, t.source, t.sourceEventId],
        );
      }

      await client.query('COMMIT');
      return { written: true };
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
