/**
 * capi-deletion.e2e.test.ts — Live integration tests for the CAPI retroactive-deletion
 * path (feat-capi-conversion-feedback, Track A / @data-engineer). Architecture §5.
 *
 * Runs against REAL Postgres (no mocks at the infrastructure seam).
 * Start infra: docker compose --profile core up -d
 * Requires migration 0034_capi_passback_log.sql applied.
 *
 * Coverage (architecture §5 + the Track-A acceptance contract):
 *   1. fires-on-withdrawal: an 'advertising' withdrawal event → a capi_deletion_log row
 *      with status='would_delete_dev' (dev: NOTHING sent to Meta — never faked).
 *   2. ≤15min latency: requested_at − tombstoned_at is within the 15-minute SLA.
 *   3. idempotent (replay → same state): 3× the same withdrawal event → exactly ONE
 *      deletion request row (ON CONFLICT DO NOTHING).
 *   4. not-a-withdrawal: an advertising=true (granted) event → NO deletion row.
 *   5. deletion scope: prior 'would_send_dev' passbacks for the subject are counted into
 *      event_count under the SAME brand GUC (RLS-enforced count).
 *   6. isolation NON-INERT under brain_app: BRAND_B sees 0 of BRAND_A's deletion rows;
 *      the test asserts current_user='brain_app' (NOT superuser 'brain') BEFORE counting.
 *   7. no-raw-PII: subject_hash is 64-hex; never the raw email/phone.
 *   8. append-only-by-GRANT: brain_app has no UPDATE/DELETE on either CAPI log.
 *
 * F-4 (MEMORY: dev superuser 'brain' bypasses RLS): every isolation assertion runs under
 *   brain_app and asserts current_user='brain_app' first — a 'brain' connection would see
 *   all rows and the test would false-pass.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { hashIdentifier } from '@brain/identity-core';
import { SaltProvider, LocalSecretsProvider } from '../infrastructure/secrets/SaltProvider.js';
import { CapiDeletionRepository } from '../infrastructure/pg/CapiDeletionRepository.js';
import { RequestCapiDeletionUseCase } from '../application/RequestCapiDeletionUseCase.js';

const BRAIN_APP_DB_URL =
  process.env['BRAIN_APP_DATABASE_URL'] ??
  'postgres://brain_app:brain_app@localhost:5432/brain';
const SUPERUSER_DB_URL =
  process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';

const BRAND_A = 'eefda8d9-2ee5-42a8-a667-06af5e51a99c';
const BRAND_B = 'ef1b8fe7-bad9-4400-87ca-778d7b1a9a37';

const SALT_A = randomBytes(32).toString('hex');
const SALT_B = randomBytes(32).toString('hex');

let superPool: Pool;
let brainAppPool: Pool;
let deletionRepo: CapiDeletionRepository;
let saltProvider: SaltProvider;
let useCase: RequestCapiDeletionUseCase;

const subjectHashesA: string[] = [];
const subjectHashesB: string[] = [];

function makeWithdrawalEvent(args: {
  brandId: string;
  email: string;
  eventId?: string;
  occurredAt?: string;
  advertising: boolean;
}): Buffer {
  return Buffer.from(
    JSON.stringify({
      brand_id: args.brandId,
      event_id: args.eventId ?? randomUUID(),
      region_code: 'IN',
      occurred_at: args.occurredAt ?? new Date().toISOString(),
      // advertising=false is the explicit withdrawal signal; the other 4 are present
      // (require-all on the suppressor side; this use-case only reads advertising).
      consent_flags: {
        analytics: true,
        marketing: true,
        personalization: true,
        ai_processing: true,
        advertising: args.advertising,
      },
      payload: { properties: { email: args.email } },
    }),
  );
}

async function cleanup(brandId: string, hashes: string[]): Promise<void> {
  if (hashes.length === 0) return;
  await superPool.query(
    `DELETE FROM capi_deletion_log WHERE brand_id=$1 AND subject_hash=ANY($2::text[])`,
    [brandId, hashes],
  );
  await superPool.query(
    `DELETE FROM capi_passback_log WHERE brand_id=$1 AND subject_hash=ANY($2::text[])`,
    [brandId, hashes],
  );
}

beforeAll(async () => {
  superPool = new Pool({ connectionString: SUPERUSER_DB_URL, max: 3 });
  brainAppPool = new Pool({ connectionString: BRAIN_APP_DB_URL, max: 5 });
  deletionRepo = new CapiDeletionRepository(BRAIN_APP_DB_URL);

  const secrets = new LocalSecretsProvider();
  saltProvider = new SaltProvider(secrets, (brandId: string) => {
    if (brandId === BRAND_A) return SALT_A;
    if (brandId === BRAND_B) return SALT_B;
    return randomBytes(32).toString('hex');
  });
  // hasMetaCreds=false (dev) → status='would_delete_dev'; NOTHING is sent to Meta.
  useCase = new RequestCapiDeletionUseCase(saltProvider, deletionRepo, false);

  const userCheck = await brainAppPool.query<{ current_user: string }>('SELECT current_user');
  if (userCheck.rows[0]?.current_user === 'brain') {
    throw new Error('FATAL: brainAppPool connecting as brain superuser — isolation tests would false-pass');
  }
}, 30_000);

afterAll(async () => {
  await cleanup(BRAND_A, subjectHashesA);
  await cleanup(BRAND_B, subjectHashesB);
  await superPool.end();
  await brainAppPool.end();
  await deletionRepo.end();
}, 30_000);

// ── Test 1+2: fires on an advertising withdrawal, within ≤15min ───────────────
describe('fires-on-withdrawal + ≤15min latency (the acceptance gate)', () => {
  it('advertising=false → would_delete_dev row, requested within 15 min of tombstone', async () => {
    const email = `capi-del-${Date.now()}@example.com`;
    const tombstonedAt = new Date().toISOString();
    const event = makeWithdrawalEvent({ brandId: BRAND_A, email, occurredAt: tombstonedAt, advertising: false });

    const r = await useCase.execute(event, new Date().toISOString());
    expect(r.outcome).toBe('deletion_requested');
    expect(r.status).toBe('would_delete_dev'); // dev: never faked as 'deleted'
    expect(r.subjectHash).toMatch(/^[0-9a-f]{64}$/);
    if (r.subjectHash) subjectHashesA.push(r.subjectHash);

    const rows = await superPool.query<{ status: string; tombstoned_at: Date; requested_at: Date }>(
      `SELECT status, tombstoned_at, requested_at
         FROM capi_deletion_log WHERE brand_id=$1 AND subject_hash=$2`,
      [BRAND_A, r.subjectHash],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]!.status).toBe('would_delete_dev');

    // ≤15min: requested_at − tombstoned_at < 15 minutes.
    const latencyMs =
      rows.rows[0]!.requested_at.getTime() - rows.rows[0]!.tombstoned_at.getTime();
    expect(latencyMs).toBeGreaterThanOrEqual(0);
    expect(latencyMs).toBeLessThan(15 * 60 * 1000);
  }, 30_000);
});

// ── Test 3: idempotent replay → exactly one deletion request ──────────────────
describe('idempotent (replay → same state)', () => {
  it('3× the same withdrawal event → exactly ONE deletion row (ON CONFLICT DO NOTHING)', async () => {
    const email = `capi-del-replay-${Date.now()}@example.com`;
    const eventId = randomUUID();

    let subjectHash = '';
    for (let i = 0; i < 3; i++) {
      const event = makeWithdrawalEvent({ brandId: BRAND_A, email, eventId, advertising: false });
      const r = await useCase.execute(event, new Date().toISOString());
      expect(r.outcome).toBe('deletion_requested');
      subjectHash = r.subjectHash!;
    }
    subjectHashesA.push(subjectHash);

    const count = await superPool.query<{ n: string }>(
      `SELECT COUNT(*)::text n FROM capi_deletion_log WHERE brand_id=$1 AND subject_hash=$2`,
      [BRAND_A, subjectHash],
    );
    expect(parseInt(count.rows[0]!.n, 10)).toBe(1); // replay does NOT multiply
  }, 30_000);
});

// ── Test 4: a granted advertising event is NOT a withdrawal → no deletion ──────
describe('not-a-withdrawal (default: do not over-delete)', () => {
  it('advertising=true (granted) → no deletion request', async () => {
    const email = `capi-del-grant-${Date.now()}@example.com`;
    const event = makeWithdrawalEvent({ brandId: BRAND_A, email, advertising: true });
    const r = await useCase.execute(event, new Date().toISOString());
    expect(r.outcome).toBe('not_a_withdrawal');
    expect(r.status).toBeUndefined();
  }, 20_000);
});

// ── Test 5: deletion scope counts prior passbacks under the brand GUC ─────────
describe('deletion scope (event_count from prior passbacks, RLS-enforced)', () => {
  it('counts the subject prior would_send_dev passbacks into event_count', async () => {
    const email = `capi-del-scope-${Date.now()}@example.com`;
    const subjectHash = hashIdentifier(
      email, 'email', await saltProvider.saltHexForBrand(BRAND_A), 'IN',
    );
    subjectHashesA.push(subjectHash);

    // Seed two prior passback rows for this subject under BRAND_A (via brain_app + GUC).
    const client = await brainAppPool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_brand_id', $1, true)", [BRAND_A]);
      for (let i = 0; i < 2; i++) {
        await client.query(
          `INSERT INTO capi_passback_log
             (brand_id, event_id, order_id, subject_hash, ledger_event_id, status,
              match_key_count, value_minor, currency_code, occurred_at)
           VALUES ($1, $2, $3, $4, $5, 'would_send_dev', 1, 49900, 'INR', NOW())
           ON CONFLICT DO NOTHING`,
          [BRAND_A, `evt-${randomUUID()}`, `ord-${i}`, subjectHash, `led-${i}`],
        );
      }
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const event = makeWithdrawalEvent({ brandId: BRAND_A, email, advertising: false });
    const r = await useCase.execute(event, new Date().toISOString());
    expect(r.outcome).toBe('deletion_requested');
    expect(r.eventCount).toBe(2); // both prior passbacks counted as deletion scope
  }, 30_000);
});

// ── Test 6: isolation NON-INERT under brain_app ───────────────────────────────
describe('isolation NON-INERT under brain_app (RLS FORCE / F-4)', () => {
  let hashUnderA = '';
  it('write a deletion row under BRAND_A', async () => {
    const email = `capi-del-iso-${Date.now()}@example.com`;
    const event = makeWithdrawalEvent({ brandId: BRAND_A, email, advertising: false });
    const r = await useCase.execute(event, new Date().toISOString());
    hashUnderA = r.subjectHash!;
    subjectHashesA.push(hashUnderA);
    expect(hashUnderA).toMatch(/^[0-9a-f]{64}$/);
  }, 20_000);

  it('BRAND_B GUC sees 0 of BRAND_A capi_deletion_log rows (cross-brand → 0)', async () => {
    const client = await brainAppPool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_brand_id', $1, true)", [BRAND_B]);
      const userRes = await client.query<{ current_user: string }>('SELECT current_user');
      const rows = await client.query(
        `SELECT subject_hash FROM capi_deletion_log WHERE brand_id=$1 AND subject_hash=$2`,
        [BRAND_A, hashUnderA], // BRAND_A rows queried under BRAND_B GUC
      );
      await client.query('COMMIT');
      expect(userRes.rows[0]?.current_user).toBe('brain_app');
      expect(userRes.rows[0]?.current_user).not.toBe('brain'); // F-4: not superuser
      expect(rows.rowCount).toBe(0); // NEGATIVE CONTROL: cross-brand → 0 rows
    } finally {
      client.release();
    }
  }, 20_000);

  it('no-GUC fail-closed: brain_app without GUC → 0 rows', async () => {
    const client = await brainAppPool.connect();
    try {
      await client.query('BEGIN');
      const userRes = await client.query<{ current_user: string }>('SELECT current_user');
      expect(userRes.rows[0]?.current_user).toBe('brain_app');
      let rowCount = 0;
      try {
        const rows = await client.query(
          `SELECT subject_hash FROM capi_deletion_log WHERE brand_id=$1 AND subject_hash=$2`,
          [BRAND_A, hashUnderA],
        );
        rowCount = rows.rowCount ?? 0;
      } catch {
        rowCount = 0; // a cast error on the NULL GUC is also fail-closed
      }
      await client.query('COMMIT');
      expect(rowCount).toBe(0);
    } finally {
      client.release();
    }
  }, 20_000);
});

// ── Test 7: no raw PII in the deletion log ────────────────────────────────────
describe('no raw PII in capi_deletion_log (I-S02)', () => {
  it('subject_hash is 64-hex SHA-256, never the raw email', async () => {
    const email = `capi-del-pii-${Date.now()}@example.com`;
    const event = makeWithdrawalEvent({ brandId: BRAND_A, email, advertising: false });
    const r = await useCase.execute(event, new Date().toISOString());
    if (r.subjectHash) subjectHashesA.push(r.subjectHash);

    const rows = await superPool.query<{ subject_hash: string }>(
      `SELECT subject_hash FROM capi_deletion_log WHERE brand_id=$1 AND subject_hash=$2`,
      [BRAND_A, r.subjectHash],
    );
    expect(rows.rowCount).toBeGreaterThan(0);
    for (const row of rows.rows) {
      expect(row.subject_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.subject_hash).not.toContain('@');
      expect(row.subject_hash).not.toBe(email);
    }
  }, 30_000);
});

// ── Test 8: append-only by GRANT (no UPDATE/DELETE) ───────────────────────────
describe('append-only by GRANT (0034 Assertion-2)', () => {
  it('brain_app holds no UPDATE/DELETE on capi_passback_log or capi_deletion_log', async () => {
    const rows = await superPool.query<{ table_name: string; privilege_type: string }>(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants
       WHERE grantee='brain_app'
         AND table_name IN ('capi_passback_log','capi_deletion_log')
         AND privilege_type IN ('UPDATE','DELETE')`,
    );
    expect(rows.rowCount).toBe(0); // append-only: no mutating grant exists
  });
});
