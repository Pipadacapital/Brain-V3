/**
 * ContactPiiVaultRepository — the ONLY data path to the contact_pii vault (P0-C).
 *
 * The vault's RLS policy requires BOTH app.current_brand_id AND app.role='send_service'
 * (0017, D-3). This repository is the single, audited place that sets app.role='send_service'
 * — inside an explicit transaction, under the NOBYPASSRLS brain_app role, with the GUCs
 * transaction-scoped (set_config(..., true)) so they reset on COMMIT/ROLLBACK and never leak.
 *
 * It moves only CIPHERTEXT (BYTEA) + the row's hashes — never plaintext PII. Encryption /
 * decryption happens above it in ContactPiiVaultService.
 *
 * Takes a raw pg.Pool (not @brain/db DbPool) because DbPool's query() does not set the
 * elevated app.role GUC the vault requires.
 */
import type { Pool, PoolClient } from 'pg';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APP_ROLE = 'brain_app';
const SEND_SERVICE = 'send_service';

export type VaultPiiType = 'email' | 'phone' | 'name';

export interface VaultEnvelopeRow {
  piiType: VaultPiiType;
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  keyVersion: number | null;
}

export interface VaultCoverageCounts {
  resolved_customers: number;
  vaulted_customers: number;
  email_count: number;
  phone_count: number;
}

export class ContactPiiVaultRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Run fn inside a transaction with the elevated vault GUCs set. The ONLY place
   * app.role='send_service' is set in the codebase (the audited elevated-read seam).
   */
  private async withSendServiceTxn<T>(
    brandId: string,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    if (!UUID_RE.test(brandId)) {
      throw new Error(`[pii-vault] brandId "${brandId}" is not a valid UUID`);
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
      await client.query("SELECT set_config('app.current_brand_id', $1, true)", [brandId]);
      await client.query("SELECT set_config('app.role', $1, true)", [SEND_SERVICE]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {
        /* preserve original error */
      });
      throw err;
    } finally {
      client.release();
    }
  }

  /** Insert one encrypted PII row. Idempotent (first-write-wins on the PK). */
  async putPii(args: {
    brandId: string;
    brainId: string;
    piiType: VaultPiiType;
    identifierHash: string;
    ciphertext: Buffer;
    iv: Buffer;
    authTag: Buffer;
    keyVersion: number;
  }): Promise<void> {
    await this.withSendServiceTxn(args.brandId, async (client) => {
      await client.query(
        `INSERT INTO contact_pii
           (brand_id, brain_id, pii_type, identifier_hash,
            pii_ciphertext, pii_iv, pii_auth_tag, key_version, pii_value)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL)
         ON CONFLICT (brand_id, brain_id, pii_type) DO NOTHING`,
        [
          args.brandId,
          args.brainId,
          args.piiType,
          args.identifierHash,
          args.ciphertext,
          args.iv,
          args.authTag,
          args.keyVersion,
        ],
      );
    });
  }

  /**
   * Fetch every vaulted PII envelope for the customer that owns `subjectHash`
   * (subjectHash = identity_link.identifier_value = contact_pii.identifier_hash).
   */
  async getEnvelopesBySubjectHash(args: {
    brandId: string;
    subjectHash: string;
  }): Promise<VaultEnvelopeRow[]> {
    return this.withSendServiceTxn(args.brandId, async (client) => {
      const r = await client.query<{
        pii_type: VaultPiiType;
        pii_ciphertext: Buffer;
        pii_iv: Buffer;
        pii_auth_tag: Buffer;
        key_version: number | null;
      }>(
        `SELECT pii_type, pii_ciphertext, pii_iv, pii_auth_tag, key_version
           FROM contact_pii
          WHERE brand_id = $1
            AND brain_id = (
              SELECT brain_id FROM contact_pii
               WHERE brand_id = $1 AND identifier_hash = $2
               LIMIT 1
            )
            AND pii_ciphertext IS NOT NULL`,
        [args.brandId, args.subjectHash],
      );
      return r.rows.map((row) => ({
        piiType: row.pii_type,
        ciphertext: row.pii_ciphertext,
        iv: row.pii_iv,
        authTag: row.pii_auth_tag,
        keyVersion: row.key_version,
      }));
    });
  }

  /** Coverage aggregates (counts only — never raw PII). */
  async countCoverage(brandId: string): Promise<VaultCoverageCounts> {
    return this.withSendServiceTxn(brandId, async (client) => {
      const vault = await client.query<{
        vaulted_customers: string;
        email_count: string;
        phone_count: string;
      }>(
        `SELECT COUNT(DISTINCT brain_id)                       AS vaulted_customers,
                COUNT(*) FILTER (WHERE pii_type = 'email')     AS email_count,
                COUNT(*) FILTER (WHERE pii_type = 'phone')     AS phone_count
           FROM contact_pii
          WHERE brand_id = $1 AND pii_ciphertext IS NOT NULL`,
        [brandId],
      );
      const cust = await client.query<{ resolved_customers: string }>(
        `SELECT COUNT(*) AS resolved_customers
           FROM customer
          WHERE brand_id = $1 AND lifecycle_state = 'active'`,
        [brandId],
      );
      return {
        resolved_customers: Number(cust.rows[0]?.resolved_customers ?? 0),
        vaulted_customers: Number(vault.rows[0]?.vaulted_customers ?? 0),
        email_count: Number(vault.rows[0]?.email_count ?? 0),
        phone_count: Number(vault.rows[0]?.phone_count ?? 0),
      };
    });
  }
}
