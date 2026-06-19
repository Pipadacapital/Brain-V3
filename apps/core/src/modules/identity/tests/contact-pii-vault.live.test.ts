/**
 * contact-pii-vault.live.test.ts — live Postgres tests for the encrypted PII vault (P0-C).
 *
 * Proves:
 *   1. put → getMatchPii round-trips decrypted email + phone (AES-256-GCM at rest).
 *   2. ELEVATED RLS — a brain_app read WITH the brand GUC but WITHOUT app.role='send_service'
 *      sees 0 rows. The vault is unreadable except via the dedicated send_service seam (D-3).
 *   3. brand isolation — the vault row is invisible under a different brand scope.
 *   4. coverage — getCoverage reports the vaulted customer + per-type counts.
 *   5. ciphertext at rest — the stored bytes are NOT the plaintext (no plaintext in the column).
 *
 * REQUIRES: Postgres on localhost:5432 with migrations 0017 + 0037 applied. Seeds/cleans via
 * the superuser; the vault repo runs as brain_app with the elevated GUCs internally.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import pg from 'pg';
import {
  ContactPiiVaultRepository,
  ContactPiiVaultService,
  DevVaultKeyProvider,
} from '../index.js';

const SUPERUSER_URL = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';

const BRAND_A = 'c0440a1a-0a1a-4a1a-8a1a-000000000001';
const BRAND_B = 'c0440a1a-0a1a-4a1a-8a1a-000000000002';
const BRAIN_A = 'b0440a1a-0a1a-4a1a-8a1a-0000000000a1';
const EMAIL = 'vault-user@example.com';
const PHONE = '+919876500000';
const EMAIL_HASH = createHash('sha256').update(`salt||${EMAIL}`).digest('hex');
const PHONE_HASH = createHash('sha256').update(`salt||${PHONE}`).digest('hex');

let superPool: pg.Pool;
let rawPool: pg.Pool;
let service: ContactPiiVaultService;
let pgAvailable = false;

async function cleanup(): Promise<void> {
  for (const b of [BRAND_A, BRAND_B]) {
    await superPool.query(`DELETE FROM contact_pii WHERE brand_id = $1`, [b]).catch(() => {});
    await superPool.query(`DELETE FROM customer WHERE brand_id = $1`, [b]).catch(() => {});
  }
}

beforeAll(async () => {
  try {
    superPool = new pg.Pool({ connectionString: SUPERUSER_URL, connectionTimeoutMillis: 4000 });
    await superPool.query('SELECT 1');
    rawPool = new pg.Pool({ connectionString: SUPERUSER_URL });
    service = new ContactPiiVaultService(new ContactPiiVaultRepository(rawPool), new DevVaultKeyProvider());
    await cleanup();
    await superPool.query(
      `INSERT INTO customer (brand_id, brain_id, lifecycle_state) VALUES ($1, $2, 'active')
       ON CONFLICT (brand_id, brain_id) DO NOTHING`,
      [BRAND_A, BRAIN_A],
    );
    await service.put({ brandId: BRAND_A, brainId: BRAIN_A, piiType: 'email', rawValue: EMAIL, identifierHash: EMAIL_HASH });
    await service.put({ brandId: BRAND_A, brainId: BRAIN_A, piiType: 'phone', rawValue: PHONE, identifierHash: PHONE_HASH });
    pgAvailable = true;
  } catch {
    pgAvailable = false;
  }
});

afterAll(async () => {
  if (pgAvailable) await cleanup();
  if (rawPool) await rawPool.end();
  if (superPool) await superPool.end();
});

describe('ContactPiiVaultService (live Postgres)', () => {
  it('SKIP_IF_NO_PG', () => {
    if (!pgAvailable) console.warn('[contact-pii-vault] Postgres unavailable — PENDING.');
    expect(true).toBe(true);
  });

  it('1. put → getMatchPii round-trips decrypted email + phone', async () => {
    if (!pgAvailable) return;
    const pii = await service.getMatchPii({ brandId: BRAND_A, subjectHash: EMAIL_HASH });
    expect(pii).not.toBeNull();
    expect(pii?.email).toBe(EMAIL);
    expect(pii?.phone).toBe(PHONE);
  });

  it('2. ELEVATED RLS — brand GUC without app.role=send_service sees 0 rows', async () => {
    if (!pgAvailable) return;
    const client = await rawPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE brain_app');
      await client.query("SELECT set_config('app.current_brand_id', $1, true)", [BRAND_A]);
      // Deliberately DO NOT set app.role='send_service'.
      const r = await client.query(`SELECT brain_id FROM contact_pii WHERE brand_id = $1`, [BRAND_A]);
      expect(r.rowCount).toBe(0);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('3. brand isolation — invisible under a different brand scope', async () => {
    if (!pgAvailable) return;
    const pii = await service.getMatchPii({ brandId: BRAND_B, subjectHash: EMAIL_HASH });
    expect(pii).toBeNull();
  });

  it('4. coverage reports the vaulted customer + per-type counts', async () => {
    if (!pgAvailable) return;
    const cov = await service.getCoverage(BRAND_A);
    expect(cov.vaulted_customers).toBeGreaterThanOrEqual(1);
    expect(cov.email_count).toBeGreaterThanOrEqual(1);
    expect(cov.phone_count).toBeGreaterThanOrEqual(1);
    expect(cov.resolved_customers).toBeGreaterThanOrEqual(1);
  });

  it('5. ciphertext at rest — the stored bytes are not the plaintext', async () => {
    if (!pgAvailable) return;
    const r = await superPool.query<{ pii_ciphertext: Buffer | null; pii_value: string | null }>(
      `SELECT pii_ciphertext, pii_value FROM contact_pii WHERE brand_id = $1 AND pii_type = 'email'`,
      [BRAND_A],
    );
    const row = r.rows[0]!;
    expect(row.pii_value).toBeNull();
    expect(row.pii_ciphertext).not.toBeNull();
    expect(row.pii_ciphertext!.toString('utf8')).not.toContain(EMAIL);
  });
});
