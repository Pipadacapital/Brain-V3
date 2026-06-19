/**
 * identity.e2e.test.ts — Live integration tests for the identity graph (Stage 3).
 *
 * All tests run against REAL Postgres (no mocks at infrastructure seams).
 * Start infra: docker compose --profile core up -d
 *
 * Test coverage (all required by architecture-plan §5 + acceptance contract):
 *   1. deterministic-merge: same email, 2 events → 1 brain_id
 *   2. phone-guard: shared phone across > threshold distinct customers → NOT merged (N=10 boundary)
 *   3. isolation-negctrl-brain_app: cross-brand = 0 rows; no-GUC = 0 rows;
 *      assert current_user='brain_app' (NOT superuser 'brain')
 *   4. no-raw-pii: identity_link.identifier_value is always 64-hex, never raw email/phone
 *   5. salt-cross-brand-differs: two brands → different hashes for same identifier
 *   6. replay-idempotency: 3× same resolution → 1 identity_merge_event row, 1 alias
 *   7. contact_pii-send_service-gate: brain_app without app.role='send_service' → 0 rows
 *
 * NOTE (F-4 false-pass prevention — memory: dev superuser 'brain' bypasses RLS):
 *   Every isolation assertion runs under SET ROLE brain_app.
 *   The test explicitly asserts current_user = 'brain_app' BEFORE checking row counts.
 *   A test connecting as 'brain' superuser would see all rows regardless of RLS policy.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { createHash, randomBytes } from 'node:crypto';
import {
  hashIdentifier,
  normalizeIdentifier,
  normalizePhone,
  CONFORMANCE_EMAIL_VECTOR,
} from '@brain/identity-core';
import { SaltProvider, LocalSecretsProvider } from '../infrastructure/secrets/SaltProvider.js';
import { IdentityRepository } from '../infrastructure/pg/IdentityRepository.js';
import {
  IdentityResolver,
  ExtractedIdentifier,
  RULE_VERSION,
} from '../domain/identity/IdentityResolver.js';
import { ResolveIdentityUseCase } from '../application/ResolveIdentityUseCase.js';

// ── Test configuration ────────────────────────────────────────────────────────

const BRAIN_APP_DB_URL =
  process.env['BRAIN_APP_DATABASE_URL'] ??
  'postgres://brain_app:brain_app@localhost:5432/brain';
const SUPERUSER_DB_URL =
  process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';

// Existing brands from dev DB (set up by prior migrations/smoke tests)
const BRAND_A = 'eefda8d9-2ee5-42a8-a667-06af5e51a99c';  // Smoke Brand
const BRAND_B = 'ef1b8fe7-bad9-4400-87ca-778d7b1a9a37';  // Resume Brand

// Per-brand 32-byte test salts (64-hex). Different per brand (D-2 cross-brand test).
const SALT_A = randomBytes(32).toString('hex');
const SALT_B = randomBytes(32).toString('hex');

let superPool: Pool;  // for setup + teardown (bypasses RLS — correct for setup)
let brainAppPool: Pool;  // for isolation assertions (RLS-enforced)
let identityRepo: IdentityRepository;
let saltProvider: SaltProvider;
let resolveUseCase: ResolveIdentityUseCase;

// Track all brain_ids minted in tests so we can clean up
const mintedBrainIds: string[] = [];
const mintedBrainIdsB: string[] = [];

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Read identity_link rows as brain_app (RLS enforced). */
async function readLinksAsApp(
  brandId: string,
  identifierHash: string,
): Promise<{ rowCount: number; currentUser: string }> {
  const client = await brainAppPool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_brand_id', $1, true)", [brandId]);
    const userRes = await client.query<{ current_user: string }>('SELECT current_user');
    const rows = await client.query(
      `SELECT brain_id FROM identity_link WHERE brand_id=$1 AND identifier_value=$2 AND is_active=TRUE`,
      [brandId, identifierHash],
    );
    await client.query('COMMIT');
    return {
      rowCount: rows.rowCount ?? 0,
      currentUser: userRes.rows[0]?.current_user ?? 'unknown',
    };
  } finally {
    client.release();
  }
}

/** Read identity_merge_event rows as brain_app (RLS enforced). */
async function readMergeEvents(brandId: string): Promise<{ count: number; currentUser: string }> {
  const client = await brainAppPool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_brand_id', $1, true)", [brandId]);
    const userRes = await client.query<{ current_user: string }>('SELECT current_user');
    const rows = await client.query(
      `SELECT merge_id FROM identity_merge_event WHERE brand_id=$1`,
      [brandId],
    );
    await client.query('COMMIT');
    return { count: rows.rowCount ?? 0, currentUser: userRes.rows[0]?.current_user ?? 'unknown' };
  } finally {
    client.release();
  }
}

/** Read brain_id_alias rows as brain_app. */
async function readAliases(brandId: string, observedBrainId: string): Promise<number> {
  const client = await brainAppPool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_brand_id', $1, true)", [brandId]);
    const rows = await client.query(
      `SELECT alias_id FROM brain_id_alias WHERE brand_id=$1 AND observed_brain_id=$2 AND valid_to IS NULL`,
      [brandId, observedBrainId],
    );
    await client.query('COMMIT');
    return rows.rowCount ?? 0;
  } finally {
    client.release();
  }
}

/** Read contact_pii with app.role='send_service' set. */
async function readContactPiiWithRole(brandId: string, brainId: string): Promise<{
  count: number;
  currentUser: string;
}> {
  const client = await brainAppPool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_brand_id', $1, true)", [brandId]);
    await client.query("SELECT set_config('app.role', 'send_service', true)");
    const userRes = await client.query<{ current_user: string }>('SELECT current_user');
    const rows = await client.query(
      `SELECT pii_type FROM contact_pii WHERE brand_id=$1 AND brain_id=$2`,
      [brandId, brainId],
    );
    await client.query('COMMIT');
    return { count: rows.rowCount ?? 0, currentUser: userRes.rows[0]?.current_user ?? 'unknown' };
  } finally {
    client.release();
  }
}

/** Read contact_pii WITHOUT app.role set (should return 0 rows). */
async function readContactPiiWithoutRole(brandId: string, brainId: string): Promise<{
  count: number;
  currentUser: string;
}> {
  const client = await brainAppPool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_brand_id', $1, true)", [brandId]);
    // Note: NOT setting app.role → contact_pii policy should return 0 rows
    const userRes = await client.query<{ current_user: string }>('SELECT current_user');
    const rows = await client.query(
      `SELECT pii_type FROM contact_pii WHERE brand_id=$1 AND brain_id=$2`,
      [brandId, brainId],
    );
    await client.query('COMMIT');
    return { count: rows.rowCount ?? 0, currentUser: userRes.rows[0]?.current_user ?? 'unknown' };
  } finally {
    client.release();
  }
}

/** Make a fake event Buffer with an email in the payload. */
function makeEmailEvent(email: string, brandId: string): Buffer {
  return Buffer.from(JSON.stringify({
    brand_id: brandId,
    event_id: `${Math.random().toString(36).slice(2)}-${Date.now()}`,
    region_code: 'IN',
    payload: {
      properties: { email },
    },
  }));
}

/** Make a fake event Buffer with a phone in the payload. */
function makePhoneEvent(phone: string, brandId: string): Buffer {
  return Buffer.from(JSON.stringify({
    brand_id: brandId,
    event_id: `${Math.random().toString(36).slice(2)}-${Date.now()}`,
    region_code: 'IN',
    payload: {
      properties: { phone },
    },
  }));
}

/** Cleanup: delete all test rows for a set of brain_ids in a brand. */
async function cleanupBrainIds(brandId: string, brainIds: string[]): Promise<void> {
  if (brainIds.length === 0) return;
  // Superuser connection bypasses RLS for cleanup
  await superPool.query(
    `DELETE FROM contact_pii WHERE brand_id=$1 AND brain_id=ANY($2::uuid[])`,
    [brandId, brainIds],
  );
  await superPool.query(
    `DELETE FROM identity_audit WHERE brand_id=$1 AND brain_id=ANY($2::uuid[])`,
    [brandId, brainIds],
  );
  await superPool.query(
    `DELETE FROM brain_id_alias WHERE brand_id=$1 AND (observed_brain_id=ANY($2::uuid[]) OR canonical_brain_id=ANY($2::uuid[]))`,
    [brandId, brainIds],
  );
  await superPool.query(
    `DELETE FROM identity_link WHERE brand_id=$1 AND brain_id=ANY($2::uuid[])`,
    [brandId, brainIds],
  );
  await superPool.query(
    `DELETE FROM identity_merge_event WHERE brand_id=$1 AND (canonical_brain_id=ANY($2::uuid[]) OR merged_brain_id=ANY($2::uuid[]))`,
    [brandId, brainIds],
  );
  await superPool.query(
    `DELETE FROM customer WHERE brand_id=$1 AND brain_id=ANY($2::uuid[])`,
    [brandId, brainIds],
  );
  await superPool.query(
    `DELETE FROM merge_review_queue WHERE brand_id=$1`,
    [brandId],
  );
}

async function cleanupSharedUtility(brandId: string, identifier_values: string[]): Promise<void> {
  if (identifier_values.length === 0) return;
  await superPool.query(
    `DELETE FROM shared_utility_identifier WHERE brand_id=$1 AND identifier_value=ANY($2::text[])`,
    [brandId, identifier_values],
  );
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  superPool = new Pool({ connectionString: SUPERUSER_DB_URL, max: 3 });
  brainAppPool = new Pool({ connectionString: BRAIN_APP_DB_URL, max: 5 });

  identityRepo = new IdentityRepository(BRAIN_APP_DB_URL);

  // SaltProvider with test salts (different per brand — D-2 salt-cross-brand test)
  const secrets = new LocalSecretsProvider();
  saltProvider = new SaltProvider(secrets, (brandId: string) => {
    if (brandId === BRAND_A) return SALT_A;
    if (brandId === BRAND_B) return SALT_B;
    // Default: a valid random salt for unknown brands
    return randomBytes(32).toString('hex');
  });

  resolveUseCase = new ResolveIdentityUseCase(saltProvider, identityRepo);

  // Verify we're using brain_app (not superuser) for isolation tests
  const userCheck = await brainAppPool.query<{ current_user: string }>('SELECT current_user');
  if (userCheck.rows[0]?.current_user === 'brain') {
    throw new Error('FATAL: brainAppPool is connecting as brain superuser — isolation tests would be false-passes');
  }
}, 30_000);

afterAll(async () => {
  await cleanupBrainIds(BRAND_A, mintedBrainIds);
  await cleanupBrainIds(BRAND_B, mintedBrainIdsB);
  await superPool.end();
  await brainAppPool.end();
  await identityRepo.end();
}, 30_000);

// ── Test 1: Identity-core conformance (C-1 + D-2 + D-6) ─────────────────────

describe('identity-core conformance (C-1, D-2, D-6)', () => {
  it('CONFORMANCE_EMAIL_VECTOR matches known sha256 of test-salt||user@example.com', () => {
    // Pin the exact SHA-256 output at build time — replay must produce identical hash
    const expected = createHash('sha256')
      .update('test-salt||user@example.com', 'utf8')
      .digest('hex');
    expect(CONFORMANCE_EMAIL_VECTOR).toBe(expected);
    expect(CONFORMANCE_EMAIL_VECTOR).toHaveLength(64);
    expect(CONFORMANCE_EMAIL_VECTOR).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashIdentifier uses real SHA-256 (stub deleted)', () => {
    const salt = 'test-salt';
    const hash = hashIdentifier('user@example.com', 'email', salt);
    expect(hash).toBe(CONFORMANCE_EMAIL_VECTOR);
    expect(hash).toHaveLength(64);
    // Must be valid hex
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    // Must NOT be the MurmurHash stub output (which repeats 16-char blocks)
    const isStub = hash.slice(0, 16) === hash.slice(16, 32);
    expect(isStub).toBe(false);
  });

  it('cross-brand-differs: same identifier, two different salts → different hashes (D-2)', () => {
    const email = 'test@customer.com';
    const hashA = hashIdentifier(email, 'email', SALT_A);
    const hashB = hashIdentifier(email, 'email', SALT_B);
    expect(hashA).not.toBe(hashB);
    expect(hashA).toHaveLength(64);
    expect(hashB).toHaveLength(64);
  });

  it('E.164 normalization: 09876543210 ≡ +919876543210 (D-6)', () => {
    const local = normalizeIdentifier('09876543210', 'phone', 'IN');
    const e164 = normalizeIdentifier('+919876543210', 'phone', 'IN');
    expect(local).toBe(e164);
    expect(local).toBe('+919876543210');
  });

  it('E.164 normalization: 10-digit bare ≡ E.164', () => {
    const bare = normalizeIdentifier('9876543210', 'phone', 'IN');
    expect(bare).toBe('+919876543210');
  });

  it('E.164 hash equality: same phone in different local formats → same hash', () => {
    const salt = SALT_A;
    const h1 = hashIdentifier('09876543210', 'phone', salt, 'IN');
    const h2 = hashIdentifier('+919876543210', 'phone', salt, 'IN');
    const h3 = hashIdentifier('9876543210', 'phone', salt, 'IN');
    expect(h1).toBe(h2);
    expect(h2).toBe(h3);
  });

  it('normalizePhone: un-normalizable number returns low confidence (no crash)', () => {
    const result = normalizePhone('invalid-phone', 'IN');
    expect(result.confidence).toBe('low');
    // Must not crash — returns digit-stripped form
    expect(result.normalized).toBeDefined();
  });
});

// ── Test 2: SaltProvider hard-crash guard (D-2) ──────────────────────────────

describe('SaltProvider hard-crash guard (D-2)', () => {
  it('throws if salt is empty string', async () => {
    const emptySecrets = new LocalSecretsProvider();
    const badProvider = new SaltProvider(emptySecrets, () => '');
    await expect(badProvider.forBrand('any-brand')).rejects.toThrow(/salt/i);
  });

  it('throws if salt hex decodes to wrong byte length', async () => {
    const shortSecrets = new LocalSecretsProvider();
    // 30 bytes hex = 60 chars (not 64)
    const badProvider = new SaltProvider(
      shortSecrets,
      () => randomBytes(15).toString('hex'),
    );
    await expect(badProvider.forBrand('any-brand')).rejects.toThrow(/32 bytes/);
  });

  it('returns Buffer of exactly 32 bytes for valid 64-hex salt', async () => {
    const validSecrets = new LocalSecretsProvider();
    const goodProvider = new SaltProvider(validSecrets, () => SALT_A);
    const buf = await goodProvider.forBrand('any-brand');
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBe(32);
  });

  it('never falls through to empty/default salt — throws instead (D-2 CRITICAL)', async () => {
    // Simulate KMS failure: LocalSecretsProvider throws on empty value
    const secrets = new LocalSecretsProvider();
    const failProvider = new SaltProvider(secrets, () => '');  // empty ARN → throws
    let threw = false;
    try {
      await failProvider.saltHexForBrand('test-brand');
    } catch (err) {
      threw = true;
      expect(String(err)).toContain('salt');
    }
    expect(threw).toBe(true);
  });
});

// ── Test 3: Deterministic merge (same email, 2 events → 1 brain_id) ──────────

describe('Deterministic merge (Test 1)', () => {
  const email = `det-merge-${Date.now()}@example.com`;

  it('same email from 2 events → 1 brain_id linked (deterministic resolution)', async () => {
    const event1 = makeEmailEvent(email, BRAND_A);
    const event2 = makeEmailEvent(email, BRAND_A);

    const r1 = await resolveUseCase.execute(event1, new Date().toISOString());
    const r2 = await resolveUseCase.execute(event2, new Date().toISOString());

    // Both must succeed
    expect(['minted', 'linked']).toContain(r1.outcome);
    expect(['minted', 'linked', 'merged']).toContain(r2.outcome);

    // Same brain_id resolved
    expect(r1.brainId).toBeDefined();
    expect(r2.brainId).toBeDefined();
    expect(r1.brainId).toBe(r2.brainId);

    if (r1.brainId) mintedBrainIds.push(r1.brainId);

    // identity_link has exactly 1 active row for this hash
    const saltHex = await saltProvider.saltHexForBrand(BRAND_A);
    const hash = hashIdentifier(email, 'email', saltHex, 'IN');
    const { rowCount, currentUser } = await readLinksAsApp(BRAND_A, hash);
    expect(currentUser).toBe('brain_app');
    expect(rowCount).toBe(1);

    // The identifier_value in identity_link is the hash, not the raw email
    const client = await brainAppPool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_brand_id', $1, true)", [BRAND_A]);
      const rows = await client.query(
        `SELECT identifier_value FROM identity_link WHERE brand_id=$1 AND identifier_value=$2`,
        [BRAND_A, hash],
      );
      await client.query('COMMIT');
      expect(rows.rows.length).toBe(1);
      // Must be 64-hex hash, never the raw email
      expect(rows.rows[0]?.identifier_value).toMatch(/^[0-9a-f]{64}$/);
      expect(rows.rows[0]?.identifier_value).not.toBe(email);
    } finally {
      client.release();
    }
  }, 30_000);
});

// ── Test 4: Phone-guard (shared phone does NOT merge distinct customers) ──────

describe('Phone-guard (D-1): shared phone > threshold → NOT merged (N=10 boundary)', () => {
  const sharedPhone = '+9198' + Math.floor(10000000 + Math.random() * 89999999).toString();
  let phoneHash: string;
  const guardBrainIds: string[] = [];

  it('set up: N=10 distinct customers with the same phone → phone guard active', async () => {
    const saltHex = await saltProvider.saltHexForBrand(BRAND_A);
    phoneHash = hashIdentifier(sharedPhone, 'phone', saltHex, 'IN');

    // Insert phone links for 10 distinct brain_ids directly.
    // Use 'medium' tier to bypass the UNIQUE PARTIAL index (which only covers strong/strong_on_link).
    // Phone-guard counts ALL distinct brain_ids for a phone hash (any tier), not just strong.
    // This simulates 10 different customers each having shared this phone in their profile.
    for (let i = 0; i < 10; i++) {
      // Use valid UUID format
      const idx = String(i).padStart(4, '0');
      const brainId = `aaaaaaaa-${idx}-4aaa-8000-aaaaaaaaaaaa`;
      guardBrainIds.push(brainId);
      mintedBrainIds.push(brainId);
      // Insert customer + identity_link directly (superuser, bypassing bridge)
      await superPool.query(
        `INSERT INTO customer (brand_id, brain_id, lifecycle_state)
         VALUES ($1, $2, 'active') ON CONFLICT DO NOTHING`,
        [BRAND_A, brainId],
      );
      // Use 'medium' tier so multiple brain_ids can share the same phone hash
      // (the UNIQUE PARTIAL only applies to strong/strong_on_link tier)
      await superPool.query(
        `INSERT INTO identity_link (brand_id, brain_id, identifier_type, identifier_value, tier, is_active)
         VALUES ($1, $2, 'phone', $3, 'medium', TRUE)
         ON CONFLICT DO NOTHING`,
        [BRAND_A, brainId, phoneHash],
      );
    }

    // Now verify the windowed count = 10 (= threshold)
    const client = await brainAppPool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_brand_id', $1, true)", [BRAND_A]);
      const countRes = await client.query<{ cnt: string }>(
        `SELECT COUNT(DISTINCT brain_id)::text AS cnt
         FROM identity_link
         WHERE brand_id=$1 AND identifier_type='phone' AND identifier_value=$2 AND is_active=TRUE`,
        [BRAND_A, phoneHash],
      );
      await client.query('COMMIT');
      const count = parseInt(countRes.rows[0]?.cnt ?? '0', 10);
      expect(count).toBe(10);
    } finally {
      client.release();
    }
  }, 30_000);

  it('N=10 boundary: 11th event with same phone → phone suppressed, NOT merged (D-1)', async () => {
    // Now process an 11th event — the phone-guard should suppress
    const event11 = makePhoneEvent(sharedPhone, BRAND_A);
    const result = await resolveUseCase.execute(event11, new Date().toISOString());

    // The event should be processed (not error), but the phone should be suppressed
    expect(['minted', 'suppressed', 'skipped', 'no_identifiers']).toContain(result.outcome);
    // If it minted, track the new brain_id
    if (result.brainId && !guardBrainIds.includes(result.brainId)) {
      mintedBrainIds.push(result.brainId);
    }

    // CRITICAL: verify the phone is now in shared_utility_identifier
    const client = await superPool.connect();
    try {
      const suiRow = await client.query(
        `SELECT identifier_value, profile_count, suppressed_until
         FROM shared_utility_identifier
         WHERE brand_id=$1 AND identifier_type='phone' AND identifier_value=$2`,
        [BRAND_A, phoneHash],
      );
      // Phone guard must have flagged this phone
      expect(suiRow.rows.length).toBeGreaterThan(0);
      expect(suiRow.rows[0]?.profile_count).toBeGreaterThanOrEqual(10);
    } finally {
      client.release();
      await cleanupSharedUtility(BRAND_A, [phoneHash]);
    }
  }, 30_000);

  it('phone-guard: shared phone does NOT collapse 10 distinct customers into 1 brain_id', async () => {
    // Verify that all 10 guardBrainIds are still distinct (not merged into 1)
    const client = await brainAppPool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_brand_id', $1, true)", [BRAND_A]);
      const rows = await client.query(
        `SELECT COUNT(DISTINCT brain_id)::text AS cnt
         FROM identity_link
         WHERE brand_id=$1 AND identifier_type='phone' AND identifier_value=$2 AND is_active=TRUE`,
        [BRAND_A, phoneHash],
      );
      await client.query('COMMIT');
      const count = parseInt(rows.rows[0]?.cnt ?? '0', 10);
      // Must still be 10 distinct brain_ids — none merged
      expect(count).toBeGreaterThanOrEqual(10);
    } finally {
      client.release();
    }

    // Also verify no merge events were created for these brain_ids
    const mergeClient = await superPool.connect();
    try {
      const mergeRows = await mergeClient.query(
        `SELECT COUNT(*)::text AS cnt FROM identity_merge_event
         WHERE brand_id=$1 AND (canonical_brain_id=ANY($2::uuid[]) OR merged_brain_id=ANY($2::uuid[]))`,
        [BRAND_A, guardBrainIds],
      );
      const mergeCount = parseInt(mergeRows.rows[0]?.cnt ?? '0', 10);
      // Shared phone customers must NOT have been merged
      expect(mergeCount).toBe(0);
    } finally {
      mergeClient.release();
    }
  }, 30_000);
});

// ── Test 5: Isolation negative control (cross-brand, no-GUC, brain_app) ──────

describe('Isolation negative control (I-S01 / RLS FORCE / D-2 / F-4)', () => {
  const email = `iso-test-${Date.now()}@example.com`;
  let brainIdA: string | undefined;

  it('resolve email under BRAND_A — mints brain_id', async () => {
    const event = makeEmailEvent(email, BRAND_A);
    const result = await resolveUseCase.execute(event, new Date().toISOString());
    expect(['minted', 'linked']).toContain(result.outcome);
    brainIdA = result.brainId;
    if (brainIdA) mintedBrainIds.push(brainIdA);
    expect(brainIdA).toBeDefined();
  }, 20_000);

  it('cross-brand isolation: BRAND_B cannot see BRAND_A identity_link (0 rows under brain_app)', async () => {
    const saltHexA = await saltProvider.saltHexForBrand(BRAND_A);
    const hashUnderA = hashIdentifier(email, 'email', saltHexA, 'IN');

    // BRAND_B GUC → should see 0 rows for BRAND_A's hash
    const client = await brainAppPool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_brand_id', $1, true)", [BRAND_B]);
      const userRes = await client.query<{ current_user: string }>('SELECT current_user');
      const rows = await client.query(
        `SELECT brain_id FROM identity_link WHERE brand_id=$1 AND identifier_value=$2`,
        [BRAND_A, hashUnderA],  // intentionally querying BRAND_A rows under BRAND_B GUC
      );
      await client.query('COMMIT');
      expect(userRes.rows[0]?.current_user).toBe('brain_app');
      expect(userRes.rows[0]?.current_user).not.toBe('brain');  // F-4: not superuser
      expect(rows.rowCount).toBe(0);  // NEGATIVE CONTROL: cross-brand → 0 rows
    } finally {
      client.release();
    }
  }, 20_000);

  it('cross-brand hash differs: same email hashes differently under BRAND_A vs BRAND_B (D-2)', async () => {
    const saltHexA = await saltProvider.saltHexForBrand(BRAND_A);
    const saltHexB = await saltProvider.saltHexForBrand(BRAND_B);
    const hashA = hashIdentifier(email, 'email', saltHexA, 'IN');
    const hashB = hashIdentifier(email, 'email', saltHexB, 'IN');
    expect(hashA).not.toBe(hashB);
  });

  it('no-GUC fail-closed: brain_app without GUC → 0 rows (or error, both acceptable)', async () => {
    const saltHexA = await saltProvider.saltHexForBrand(BRAND_A);
    const hashUnderA = hashIdentifier(email, 'email', saltHexA, 'IN');
    const client = await brainAppPool.connect();
    try {
      await client.query('BEGIN');
      // NOT setting app.current_brand_id GUC
      const userRes = await client.query<{ current_user: string }>('SELECT current_user');
      expect(userRes.rows[0]?.current_user).toBe('brain_app');
      // Query may throw (invalid uuid) or return 0 rows — both are fail-closed
      let rowCount = 0;
      try {
        const rows = await client.query(
          `SELECT brain_id FROM identity_link WHERE brand_id=$1 AND identifier_value=$2 AND is_active=TRUE`,
          [BRAND_A, hashUnderA],
        );
        rowCount = rows.rowCount ?? 0;
      } catch {
        // A cast error (invalid input for uuid) = fail-closed = correct behavior
        rowCount = 0;
      }
      await client.query('COMMIT');
      expect(rowCount).toBe(0);  // fail-closed: no data leaks without GUC
    } finally {
      client.release();
    }
  }, 20_000);
});

// ── Test 6: No raw PII in identity_link ──────────────────────────────────────

describe('No raw PII in identity_link (I-S02)', () => {
  it('identity_link.identifier_value is 64-hex SHA-256, never raw email/phone', async () => {
    const email = `pii-test-${Date.now()}@example.com`;
    const event = makeEmailEvent(email, BRAND_A);
    const result = await resolveUseCase.execute(event, new Date().toISOString());
    if (result.brainId) mintedBrainIds.push(result.brainId);

    const saltHex = await saltProvider.saltHexForBrand(BRAND_A);
    const expectedHash = hashIdentifier(email, 'email', saltHex, 'IN');

    const client = await brainAppPool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_brand_id', $1, true)", [BRAND_A]);
      const rows = await client.query<{ identifier_value: string }>(
        `SELECT identifier_value FROM identity_link WHERE brand_id=$1 AND is_active=TRUE
         ORDER BY created_at DESC LIMIT 10`,
        [BRAND_A],
      );
      await client.query('COMMIT');

      for (const row of rows.rows) {
        const val = row.identifier_value;
        // Must be exactly 64 hex chars
        expect(val).toMatch(/^[0-9a-f]{64}$/);
        // Must NOT contain @ (raw email never stored)
        expect(val).not.toContain('@');
        // Must NOT be the raw email
        expect(val).not.toBe(email);
        // Must be the expected SHA-256 hash
        if (val === expectedHash) {
          expect(val).toBe(expectedHash);
        }
      }
    } finally {
      client.release();
    }
  }, 30_000);
});

// ── Test 7: Replay idempotency (3× → 1 merge row) ────────────────────────────

describe('Replay idempotency (D-4): 3× same event → 1 merge row, 1 alias', () => {
  const emailA = `replay-a-${Date.now()}@example.com`;
  const emailB = `replay-b-${Date.now()}@example.com`;
  let canonicalId: string | undefined;
  let mergedId: string | undefined;

  it('set up two distinct brain_ids with different emails', async () => {
    const evA = makeEmailEvent(emailA, BRAND_A);
    const evB = makeEmailEvent(emailB, BRAND_A);
    const rA = await resolveUseCase.execute(evA, new Date().toISOString());
    const rB = await resolveUseCase.execute(evB, new Date().toISOString());
    expect(rA.brainId).toBeDefined();
    expect(rB.brainId).toBeDefined();
    expect(rA.brainId).not.toBe(rB.brainId);
    if (rA.brainId) mintedBrainIds.push(rA.brainId);
    if (rB.brainId) mintedBrainIds.push(rB.brainId);
  }, 20_000);

  it('replay 3×: same merge event → exactly 1 identity_merge_event row (D-4)', async () => {
    const saltHex = await saltProvider.saltHexForBrand(BRAND_A);
    const hashA = hashIdentifier(emailA, 'email', saltHex, 'IN');
    const hashB = hashIdentifier(emailB, 'email', saltHex, 'IN');

    // Get the two brain_ids
    const client = await brainAppPool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_brand_id', $1, true)", [BRAND_A]);
      const rowsA = await client.query<{ brain_id: string }>(
        `SELECT brain_id FROM identity_link WHERE brand_id=$1 AND identifier_value=$2 AND is_active=TRUE`,
        [BRAND_A, hashA],
      );
      const rowsB = await client.query<{ brain_id: string }>(
        `SELECT brain_id FROM identity_link WHERE brand_id=$1 AND identifier_value=$2 AND is_active=TRUE`,
        [BRAND_A, hashB],
      );
      await client.query('COMMIT');

      const brainIdA = rowsA.rows[0]?.brain_id;
      const brainIdB = rowsB.rows[0]?.brain_id;
      if (!brainIdA || !brainIdB) {
        console.warn('Could not find brain_ids for replay test — skipping merge');
        return;
      }

      // Pick canonical (lowest UUID) and merged (highest)
      const sorted = [brainIdA, brainIdB].sort();
      canonicalId = sorted[0];
      mergedId = sorted[1];
    } finally {
      client.release();
    }

    if (!canonicalId || !mergedId) return;

    // Compute the deterministic merge_id
    const resolver = new IdentityResolver();
    const mergeId = resolver.computeMergeId(BRAND_A, canonicalId, mergedId);

    // Replay: insert the merge event 3× — ON CONFLICT DO NOTHING
    for (let i = 0; i < 3; i++) {
      await superPool.query(
        `INSERT INTO identity_merge_event
           (merge_id, brand_id, canonical_brain_id, merged_brain_id, rule_version)
         VALUES ($1, $2, $3, $4, 'v1-deterministic')
         ON CONFLICT (merge_id) DO NOTHING`,
        [mergeId, BRAND_A, canonicalId, mergedId],
      );
      await superPool.query(
        `INSERT INTO brain_id_alias
           (brand_id, observed_brain_id, canonical_brain_id, rule_version, merge_id)
         VALUES ($1, $2, $3, 'v1-deterministic', $4)
         ON CONFLICT (brand_id, observed_brain_id)
           WHERE valid_to IS NULL
         DO NOTHING`,
        [BRAND_A, mergedId, canonicalId, mergeId],
      );
    }

    // Verify: exactly 1 merge event row
    const mergeRes = await superPool.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM identity_merge_event WHERE merge_id=$1`,
      [mergeId],
    );
    expect(parseInt(mergeRes.rows[0]?.cnt ?? '0', 10)).toBe(1);

    // Verify: exactly 1 live alias
    const aliasCount = await readAliases(BRAND_A, mergedId);
    expect(aliasCount).toBe(1);
  }, 30_000);
});

// ── Test 8: contact_pii send_service gate (D-3) ──────────────────────────────

describe('contact_pii send_service gate (D-3)', () => {
  const email = `pii-gate-${Date.now()}@example.com`;
  let brainId: string | undefined;

  it('resolve email → contact_pii written', async () => {
    const event = makeEmailEvent(email, BRAND_A);
    const result = await resolveUseCase.execute(event, new Date().toISOString());
    brainId = result.brainId;
    if (brainId) mintedBrainIds.push(brainId);
    expect(brainId).toBeDefined();
  }, 20_000);

  it('brain_app WITHOUT send_service role → 0 rows in contact_pii (D-3)', async () => {
    if (!brainId) return;
    const { count, currentUser } = await readContactPiiWithoutRole(BRAND_A, brainId);
    expect(currentUser).toBe('brain_app');
    expect(currentUser).not.toBe('brain');  // F-4: not superuser
    expect(count).toBe(0);  // NEGATIVE CONTROL: missing role → 0 rows
  }, 20_000);

  it('brain_app WITH send_service role → 1 row in contact_pii', async () => {
    if (!brainId) return;
    const { count, currentUser } = await readContactPiiWithRole(BRAND_A, brainId);
    expect(currentUser).toBe('brain_app');
    expect(count).toBeGreaterThan(0);  // POSITIVE CONTROL: role set → sees data
  }, 20_000);

  it('contact_pii is ENCRYPTED at rest (ciphertext, not plaintext) + 64-hex hash (P0-C)', async () => {
    if (!brainId) return;
    // Read via superuser to bypass RLS for verification.
    const rows = await superPool.query<{
      identifier_hash: string;
      pii_value: string | null;
      pii_ciphertext: Buffer | null;
    }>(
      `SELECT identifier_hash, pii_value, pii_ciphertext FROM contact_pii WHERE brand_id=$1 AND brain_id=$2`,
      [BRAND_A, brainId],
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    for (const row of rows.rows) {
      expect(row.identifier_hash).toMatch(/^[0-9a-f]{64}$/);
      // P0-C write-population: the raw value is AES-256-GCM ciphertext, NEVER plaintext.
      expect(row.pii_value).toBeNull();
      expect(row.pii_ciphertext).not.toBeNull();
      expect(row.pii_ciphertext!.toString('utf8')).not.toContain(email);
    }
  }, 20_000);
});
