/**
 * consent-suppressor.e2e.test.ts — Live integration tests for the consent SoR
 * projection (feat-d13-consent-cancontact, Track A / @data-engineer).
 *
 * Runs against REAL Postgres (no mocks at the infrastructure seam).
 * Start infra: docker compose --profile core up -d
 *
 * Coverage (architecture §3 + acceptance contract):
 *   1. projection: a consent_flags event → 4 consent_record rows (granted/withdrawn)
 *   2. tombstone-on-withdrawal: marketing=false → a consent_tombstone for 'marketing'
 *   3. suppression-derivation (the read seam logic): no row => suppressed (fail-closed);
 *      granted => not suppressed; tombstone => suppressed
 *   4. replay-idempotency: 3× the same event → exactly the same rows (ON CONFLICT DO NOTHING)
 *   5. isolation NON-INERT under brain_app: BRAND_B sees 0 of BRAND_A's consent rows;
 *      the test asserts current_user='brain_app' (NOT superuser 'brain') BEFORE counting
 *   6. no-raw-PII: subject_hash is 64-hex; never the raw email/phone
 *   7. append-only-by-GRANT: brain_app has no UPDATE/DELETE on either consent table
 *
 * F-4 (MEMORY: dev superuser 'brain' bypasses RLS): every isolation assertion runs
 *   under brain_app and asserts current_user='brain_app' first — a 'brain' connection
 *   would see all rows and the test would false-pass.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { hashIdentifier } from '@brain/identity-core';
import { SaltProvider, LocalSecretsProvider } from '../infrastructure/secrets/SaltProvider.js';
import { ConsentRepository } from '../infrastructure/pg/ConsentRepository.js';
import { ProjectConsentUseCase } from '../application/ProjectConsentUseCase.js';

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
let consentRepo: ConsentRepository;
let saltProvider: SaltProvider;
let useCase: ProjectConsentUseCase;

const subjectHashesA: string[] = [];
const subjectHashesB: string[] = [];

function makeConsentEvent(args: {
  brandId: string;
  email: string;
  eventId?: string;
  flags: { analytics: boolean; marketing: boolean; personalization: boolean; ai_processing: boolean };
}): Buffer {
  return Buffer.from(
    JSON.stringify({
      brand_id: args.brandId,
      event_id: args.eventId ?? randomUUID(),
      region_code: 'IN',
      consent_flags: args.flags,
      payload: { properties: { email: args.email } },
    }),
  );
}

/**
 * The suppression-derivation query — exactly what the can_contact() SuppressionQuery
 * read seam computes in apps/core: latest consent_record state OR tombstone existence.
 * Run under brain_app + brand GUC (RLS FORCE enforced).
 */
async function isSuppressed(
  brandId: string,
  subjectHash: string,
  category: string,
): Promise<{ suppressed: boolean; reason: string | null; currentUser: string }> {
  const client = await brainAppPool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_brand_id', $1, true)", [brandId]);
    const userRes = await client.query<{ current_user: string }>('SELECT current_user');

    // tombstone wins (sticky withdrawal): category-specific OR all-categories (NULL).
    const tomb = await client.query(
      `SELECT 1 FROM consent_tombstone
       WHERE brand_id=$1 AND subject_hash=$2 AND (category=$3 OR category IS NULL)
       LIMIT 1`,
      [brandId, subjectHash, category],
    );
    if ((tomb.rowCount ?? 0) > 0) {
      await client.query('COMMIT');
      return { suppressed: true, reason: 'tombstoned', currentUser: userRes.rows[0]?.current_user ?? '?' };
    }

    // latest consent_record state for the category.
    const rec = await client.query<{ state: string }>(
      `SELECT state FROM consent_record
       WHERE brand_id=$1 AND subject_hash=$2 AND category=$3
       ORDER BY effective_at DESC LIMIT 1`,
      [brandId, subjectHash, category],
    );
    await client.query('COMMIT');

    if ((rec.rowCount ?? 0) === 0) {
      return { suppressed: true, reason: 'no_consent', currentUser: userRes.rows[0]?.current_user ?? '?' };
    }
    if (rec.rows[0]?.state !== 'granted') {
      return { suppressed: true, reason: 'withdrawn', currentUser: userRes.rows[0]?.current_user ?? '?' };
    }
    return { suppressed: false, reason: null, currentUser: userRes.rows[0]?.current_user ?? '?' };
  } finally {
    client.release();
  }
}

async function cleanup(brandId: string, hashes: string[]): Promise<void> {
  if (hashes.length === 0) return;
  await superPool.query(
    `DELETE FROM consent_tombstone WHERE brand_id=$1 AND subject_hash=ANY($2::text[])`,
    [brandId, hashes],
  );
  await superPool.query(
    `DELETE FROM consent_record WHERE brand_id=$1 AND subject_hash=ANY($2::text[])`,
    [brandId, hashes],
  );
}

beforeAll(async () => {
  superPool = new Pool({ connectionString: SUPERUSER_DB_URL, max: 3 });
  brainAppPool = new Pool({ connectionString: BRAIN_APP_DB_URL, max: 5 });
  consentRepo = new ConsentRepository(BRAIN_APP_DB_URL);

  const secrets = new LocalSecretsProvider();
  saltProvider = new SaltProvider(secrets, (brandId: string) => {
    if (brandId === BRAND_A) return SALT_A;
    if (brandId === BRAND_B) return SALT_B;
    return randomBytes(32).toString('hex');
  });
  useCase = new ProjectConsentUseCase(saltProvider, consentRepo);

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
  await consentRepo.end();
}, 30_000);

// ── Test 1: projection writes 4 consent_record rows ──────────────────────────
describe('projection: consent_flags event → consent_record rows', () => {
  it('all-granted event → 4 granted rows, no tombstone', async () => {
    const email = `consent-grant-${Date.now()}@example.com`;
    const event = makeConsentEvent({
      brandId: BRAND_A,
      email,
      flags: { analytics: true, marketing: true, personalization: true, ai_processing: true },
    });
    const r = await useCase.execute(event, new Date().toISOString());
    expect(r.outcome).toBe('projected');
    expect(r.recordCount).toBe(4);
    expect(r.tombstoneCount).toBe(0);
    expect(r.subjectHash).toMatch(/^[0-9a-f]{64}$/);
    if (r.subjectHash) subjectHashesA.push(r.subjectHash);

    // marketing is granted → NOT suppressed
    const s = await isSuppressed(BRAND_A, r.subjectHash!, 'marketing');
    expect(s.currentUser).toBe('brain_app');
    expect(s.suppressed).toBe(false);
    expect(s.reason).toBeNull();
  }, 30_000);
});

// ── Test 2: withdrawal writes a tombstone + suppresses ───────────────────────
describe('tombstone-on-withdrawal: marketing=false → tombstone + suppressed', () => {
  it('marketing=false → withdrawn record + marketing tombstone → suppressed', async () => {
    const email = `consent-withdraw-${Date.now()}@example.com`;
    const event = makeConsentEvent({
      brandId: BRAND_A,
      email,
      flags: { analytics: true, marketing: false, personalization: true, ai_processing: true },
    });
    const r = await useCase.execute(event, new Date().toISOString());
    expect(r.outcome).toBe('projected');
    expect(r.recordCount).toBe(4);
    // marketing is the only withdrawn category → exactly one tombstone
    expect(r.tombstoneCount).toBe(1);
    if (r.subjectHash) subjectHashesA.push(r.subjectHash);

    const s = await isSuppressed(BRAND_A, r.subjectHash!, 'marketing');
    expect(s.currentUser).toBe('brain_app');
    expect(s.suppressed).toBe(true);
    expect(s.reason).toBe('tombstoned');
  }, 30_000);
});

// ── Test 3: fail-closed default (no row => suppressed) ───────────────────────
describe('suppression-derivation fail-closed (DPDP §13.4)', () => {
  it('a never-seen subject => suppressed with reason no_consent (default-closed)', async () => {
    const phantomHash = randomBytes(32).toString('hex');
    const s = await isSuppressed(BRAND_A, phantomHash, 'marketing');
    expect(s.currentUser).toBe('brain_app');
    expect(s.suppressed).toBe(true);
    expect(s.reason).toBe('no_consent');
  }, 20_000);
});

// ── Test 4: replay idempotency ───────────────────────────────────────────────
describe('replay idempotency (D-4): 3× same event → same rows', () => {
  it('3× the same consent event → exactly 4 records + 1 tombstone (ON CONFLICT DO NOTHING)', async () => {
    const email = `consent-replay-${Date.now()}@example.com`;
    const eventId = randomUUID();
    const flags = { analytics: true, marketing: false, personalization: false, ai_processing: true };

    let subjectHash = '';
    for (let i = 0; i < 3; i++) {
      const event = makeConsentEvent({ brandId: BRAND_A, email, eventId, flags });
      const r = await useCase.execute(event, new Date().toISOString());
      expect(r.outcome).toBe('projected');
      subjectHash = r.subjectHash!;
    }
    subjectHashesA.push(subjectHash);

    // Count actual rows (superuser, to verify the DB state regardless of RLS).
    const recCount = await superPool.query<{ n: string }>(
      `SELECT COUNT(*)::text n FROM consent_record WHERE brand_id=$1 AND subject_hash=$2`,
      [BRAND_A, subjectHash],
    );
    const tombCount = await superPool.query<{ n: string }>(
      `SELECT COUNT(*)::text n FROM consent_tombstone WHERE brand_id=$1 AND subject_hash=$2`,
      [BRAND_A, subjectHash],
    );
    // 4 categories → 4 records; marketing+personalization withdrawn → 2 tombstones.
    // Idempotent: replay does NOT multiply them.
    expect(parseInt(recCount.rows[0]!.n, 10)).toBe(4);
    expect(parseInt(tombCount.rows[0]!.n, 10)).toBe(2);
  }, 30_000);
});

// ── Test 5: isolation NON-INERT under brain_app ──────────────────────────────
describe('isolation NON-INERT under brain_app (RLS FORCE / F-4)', () => {
  let hashUnderA = '';
  it('project a consent row under BRAND_A', async () => {
    const email = `consent-iso-${Date.now()}@example.com`;
    const event = makeConsentEvent({
      brandId: BRAND_A,
      email,
      flags: { analytics: true, marketing: true, personalization: true, ai_processing: true },
    });
    const r = await useCase.execute(event, new Date().toISOString());
    hashUnderA = r.subjectHash!;
    subjectHashesA.push(hashUnderA);
    expect(hashUnderA).toMatch(/^[0-9a-f]{64}$/);
  }, 20_000);

  it('BRAND_B GUC sees 0 of BRAND_A consent_record rows (cross-brand → 0)', async () => {
    const client = await brainAppPool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_brand_id', $1, true)", [BRAND_B]);
      const userRes = await client.query<{ current_user: string }>('SELECT current_user');
      const rows = await client.query(
        `SELECT subject_hash FROM consent_record WHERE brand_id=$1 AND subject_hash=$2`,
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
          `SELECT subject_hash FROM consent_record WHERE brand_id=$1 AND subject_hash=$2`,
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

  it('same email hashes differently under BRAND_A vs BRAND_B (per-brand salt, D-2)', async () => {
    const email = 'cross-brand@example.com';
    const hA = hashIdentifier(email, 'email', await saltProvider.saltHexForBrand(BRAND_A), 'IN');
    const hB = hashIdentifier(email, 'email', await saltProvider.saltHexForBrand(BRAND_B), 'IN');
    expect(hA).not.toBe(hB);
  });
});

// ── Test 6: no raw PII in consent tables ─────────────────────────────────────
describe('no raw PII in consent_record (I-S02)', () => {
  it('subject_hash is 64-hex SHA-256, never the raw email', async () => {
    const email = `consent-pii-${Date.now()}@example.com`;
    const event = makeConsentEvent({
      brandId: BRAND_A,
      email,
      flags: { analytics: true, marketing: true, personalization: true, ai_processing: true },
    });
    const r = await useCase.execute(event, new Date().toISOString());
    if (r.subjectHash) subjectHashesA.push(r.subjectHash);

    const rows = await superPool.query<{ subject_hash: string }>(
      `SELECT subject_hash FROM consent_record WHERE brand_id=$1 AND subject_hash=$2`,
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

// ── Test 7: append-only by GRANT (no UPDATE/DELETE) ──────────────────────────
describe('append-only by GRANT (0032 Assertion-2)', () => {
  it('brain_app holds no UPDATE/DELETE on consent_record or consent_tombstone', async () => {
    const rows = await superPool.query<{ table_name: string; privilege_type: string }>(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants
       WHERE grantee='brain_app'
         AND table_name IN ('consent_record','consent_tombstone')
         AND privilege_type IN ('UPDATE','DELETE')`,
    );
    expect(rows.rowCount).toBe(0); // append-only: no mutating grant exists
  });
});
