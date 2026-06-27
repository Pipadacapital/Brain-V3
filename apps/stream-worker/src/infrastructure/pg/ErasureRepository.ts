/**
 * ErasureRepository — PostgreSQL operations for the DPDP/PDPL crypto-shred erasure
 * orchestration pipeline (migration 0114 + 0115).
 *
 * ALL writes run as brain_app (RLS FORCE enforced). pii_erasure_log has a FORCE RLS policy
 * keyed on app.current_brand_id, so every INSERT/UPDATE on that table uses a transaction
 * with the GUC set. The two SECURITY DEFINER functions (shred_subject_keyring, 0115; and
 * erase_contact_pii_for_customer, 0100) are owner-run and bypass FORCE RLS — no GUC needed.
 *
 * IDEMPOTENCY (D-4): every write is safe to replay.
 *   - initErasureLog: ON CONFLICT (brand_id, brain_id) DO NOTHING → first write wins.
 *   - shredSubjectKeyring: UPDATE WHERE is_active=TRUE → no-op if already shredded.
 *   - recordSurrogate: UPDATE WHERE surrogate_brain_id IS NULL → no-op if already set.
 *   - eraseContactPii: DELETE ... → idempotent (deletes 0 rows on replay).
 *   - completeErasure: UPDATE SET vault_shredded=TRUE ... → idempotent.
 *
 * APPEND-ONLY: pii_erasure_log is INSERT+UPDATE-only (no DELETE); the record must survive for
 * compliance audit purposes (GDPR/DPDP erasure evidence).
 *
 * No raw PII: only hashed identifiers (subjectHash) and UUID brain_ids flow through here.
 */
import { Pool, type PoolClient } from 'pg';

export interface IErasureRepository {
  /**
   * Idempotent INSERT of a pii_erasure_log row (the erasure audit record).
   * ON CONFLICT (brand_id, brain_id) DO NOTHING → replaying the same erasure event is safe.
   */
  initErasureLog(
    brandId: string,
    brainId: string,
    sourceEventId: string,
    requestedAt: string,
  ): Promise<void>;

  /**
   * Deactivate the subject's envelope DEK via the SECURITY DEFINER shred_subject_keyring()
   * function (0115). Returns true if a row was found and deactivated; false if already
   * inactive or not provisioned (both are safe no-ops).
   */
  shredSubjectKeyring(brandId: string, brainId: string): Promise<boolean>;

  /**
   * Record the surrogate brain_id in pii_erasure_log for post-erasure ledger reconciliation.
   * UPDATE WHERE surrogate_brain_id IS NULL → idempotent (first surrogate wins on replay).
   */
  recordSurrogate(brandId: string, brainId: string, surrogateId: string): Promise<void>;

  /**
   * Hard-delete contact_pii rows for the subject via the SECURITY DEFINER
   * erase_contact_pii_for_customer() (0100). Belt-and-suspenders: the primary erasure
   * mechanism is the DEK shred; this is the physical deletion backstop.
   * Returns the count of deleted rows (0 on replay = idempotent).
   */
  eraseContactPii(brandId: string, brainId: string): Promise<number>;

  /**
   * Mark the erasure log row complete: vault_shredded=TRUE, completed_at=NOW().
   * Idempotent: re-setting vault_shredded=TRUE / updating completed_at to a later time
   * is semantically harmless (the erasure is recorded regardless).
   */
  completeErasure(brandId: string, brainId: string): Promise<void>;
}

export class ErasureRepository implements IErasureRepository {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    // brain_app credentials — RLS FORCE enforced on pii_erasure_log.
    this.pool = new Pool({
      connectionString,
      max: 3,
      idleTimeoutMillis: 30_000,
      statement_timeout: 15_000,
    });
  }

  /** Run a brand-GUC-scoped single-client block on pii_erasure_log (FORCE RLS). */
  private async withBrandClient<T>(
    brandId: string,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_brand_id', $1, true)", [brandId]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async initErasureLog(
    brandId: string,
    brainId: string,
    sourceEventId: string,
    requestedAt: string,
  ): Promise<void> {
    await this.withBrandClient(brandId, async (client) => {
      await client.query(
        `INSERT INTO identity.pii_erasure_log
           (brand_id, brain_id, requested_at, vault_shredded, capi_requested)
         VALUES ($1, $2, $3, FALSE, FALSE)
         ON CONFLICT (brand_id, brain_id) DO NOTHING`,
        [brandId, brainId, requestedAt],
      );
      // source_event_id is not a column in 0114 schema — requestedAt and brain_id uniquely
      // identify the erasure request. The sourceEventId is carried only in the log context.
      void sourceEventId;
    });
  }

  async shredSubjectKeyring(brandId: string, brainId: string): Promise<boolean> {
    // SECURITY DEFINER fn (0115) — runs as owner, bypasses FORCE RLS, no GUC needed.
    const result = await this.pool.query<{ shred_subject_keyring: boolean }>(
      'SELECT shred_subject_keyring($1, $2)',
      [brandId, brainId],
    );
    return result.rows[0]?.shred_subject_keyring ?? false;
  }

  async recordSurrogate(brandId: string, brainId: string, surrogateId: string): Promise<void> {
    await this.withBrandClient(brandId, async (client) => {
      await client.query(
        `UPDATE identity.pii_erasure_log
            SET surrogate_brain_id = $3
          WHERE brand_id = $1
            AND brain_id = $2
            AND surrogate_brain_id IS NULL`,
        [brandId, brainId, surrogateId],
      );
    });
  }

  async eraseContactPii(brandId: string, brainId: string): Promise<number> {
    // SECURITY DEFINER fn (0100) — runs as owner, bypasses FORCE RLS, no GUC needed.
    const result = await this.pool.query<{ erase_contact_pii_for_customer: number }>(
      'SELECT erase_contact_pii_for_customer($1, $2)',
      [brandId, brainId],
    );
    return result.rows[0]?.erase_contact_pii_for_customer ?? 0;
  }

  async completeErasure(brandId: string, brainId: string): Promise<void> {
    await this.withBrandClient(brandId, async (client) => {
      await client.query(
        `UPDATE identity.pii_erasure_log
            SET vault_shredded = TRUE,
                completed_at   = NOW()
          WHERE brand_id = $1
            AND brain_id = $2`,
        [brandId, brainId],
      );
    });
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}
