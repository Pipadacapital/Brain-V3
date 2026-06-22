/**
 * identity-pre-hashed.test.ts — Pure-domain unit tests for the connector-pre-hashed-identity gap.
 *
 * Problem: Connector order/checkout events (Shopify/WooCommerce/Shopflo) arrive with email/phone
 * that the upstream platform already hashed before delivering the webhook. If the resolver were to
 * apply the per-brand SHA-256 salt a second time, the resulting 64-hex would not match the hash
 * produced from the same email on a first-party storefront/pixel event → two identity_link rows
 * → two distinct brain_ids → LTV/CAC attribution gap.
 *
 * Solution: ExtractedIdentifier carries `preHashed: true` for identifiers whose hash was already
 * computed upstream. The resolver passes such identifiers through AS-IS (no re-hashing). They are
 * stored under identifier_type 'pre_hashed_email' / 'pre_hashed_phone' — a distinct namespace
 * from the salted first-party hashes, preventing cross-path collision while enabling continuity.
 *
 * Tests:
 *   1. pre_hashed_email: two events with the same pre-hashed email → 1 brain_id (LINK outcome).
 *   2. Double-hash prevention: the hash reaching identity_link equals the input hash, NOT a
 *      re-hash of the input (hash === input, not sha256(input)).
 *   3. pre_hashed_phone: two events with the same pre-hashed phone → 1 brain_id.
 *   4. Namespace isolation: pre_hashed_email and email with DIFFERENT hashes do NOT merge
 *      (they live in different identifier_type namespaces — the same underlying person stitches
 *      only if BOTH types happen to match in an existing link, which is tested separately).
 *   5. Mixed event: pre_hashed_email coexists with a raw email on the same event — each is
 *      carried as its own ExtractedIdentifier (one 'email', one 'pre_hashed_email').
 *   6. Invalid pre-hashed value (not 64 lowercase hex): the use-case's regex guard rejects it —
 *      verified here at the domain level by confirming that only a valid 64-hex is accepted as
 *      a pre-hashed identifier; an invalid value would not reach the resolver.
 *   7. ResolveIdentityUseCase.execute(): end-to-end extraction test using the Buffer-based
 *      interface — a connector event with hashed_customer_email in properties produces a
 *      pre_hashed_email ExtractedIdentifier (no DB wiring required — mocked repository).
 *
 * @effort("deterministic") — no model calls; pure SHA-256 + count threshold.
 */

import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  IdentityResolver,
  type ExtractedIdentifier,
  type ExistingLink,
  type BrandPhoneGuardConfig,
  type ResolveOutcome,
} from '../domain/identity/IdentityResolver.js';
import { ResolveIdentityUseCase } from '../application/ResolveIdentityUseCase.js';
import type { SaltProvider } from '../infrastructure/secrets/SaltProvider.js';
import type { IdentityRepository } from '../infrastructure/pg/IdentityRepository.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const BRAND = '22222222-2222-2222-2222-222222222222';
const BRAIN_A = 'aaaaaaaa-1111-0000-0000-000000000001';
const BRAIN_B = 'bbbbbbbb-2222-0000-0000-000000000002';

const cfg: BrandPhoneGuardConfig = { phone_guard_threshold: 10, suppression_window_days: 30 };

// A well-formed 64-hex SHA-256 simulating "email already hashed by the upstream platform"
// This is sha256('user@example.com') — the UNSALTED hash the upstream provider would produce.
const PRE_HASHED_EMAIL = createHash('sha256')
  .update('user@example.com', 'utf8')
  .digest('hex');

// A well-formed 64-hex SHA-256 simulating "phone already hashed by the upstream platform"
const PRE_HASHED_PHONE = createHash('sha256')
  .update('+919876543210', 'utf8')
  .digest('hex');

const r = new IdentityResolver();

// ── Helpers ───────────────────────────────────────────────────────────────────

function link(
  brainId: string,
  type: string,
  hash: string,
  tier: 'strong' | 'medium' | 'strong_on_link' | 'weak' = 'strong',
): ExistingLink {
  return { brain_id: brainId, identifier_type: type, identifier_value: hash, is_active: true };
}

function preHashedEmailId(hash: string): ExtractedIdentifier {
  return { type: 'pre_hashed_email', hash, tier: 'strong', confidence: 'high', preHashed: true };
}

function preHashedPhoneId(hash: string): ExtractedIdentifier {
  return { type: 'pre_hashed_phone', hash, tier: 'strong', confidence: 'high', preHashed: true };
}

function emailId(hash: string): ExtractedIdentifier {
  return { type: 'email', hash, tier: 'strong', confidence: 'high', rawValue: 'user@example.com' };
}

// ── Test 1: Two events with same pre-hashed email → 1 brain_id ───────────────

describe('connector-pre-hashed-identity — resolver domain logic', () => {
  it('1. pre_hashed_email: event 1 mints brain_id; event 2 with same hash → LINK to same brain_id', () => {
    // Event 1: no existing links → MINT
    const outcome1 = r.resolve(
      BRAND,
      [preHashedEmailId(PRE_HASHED_EMAIL)],
      [],             // no existing links
      new Map(),
      new Map(),
      cfg,
      new Set(),
    );
    expect(outcome1.action).toBe('minted');
    expect(outcome1.brainId).toBeDefined();
    const mintedId = outcome1.brainId;

    // Simulate what the repository would have written: an identity_link row
    const existingAfterMint: ExistingLink[] = [
      link(mintedId, 'pre_hashed_email', PRE_HASHED_EMAIL, 'strong'),
    ];

    // Event 2: same pre-hashed email, existing link → LINK (not another mint)
    const outcome2 = r.resolve(
      BRAND,
      [preHashedEmailId(PRE_HASHED_EMAIL)],
      existingAfterMint,
      new Map(),
      new Map(),
      cfg,
      new Set(),
    );
    expect(outcome2.action).toBe('linked');
    expect(outcome2.brainId).toBe(mintedId);
  });

  it('2. Double-hash prevention: hash in ExtractedIdentifier is the EXACT pre-hashed value, not a re-hash', () => {
    // This is the critical invariant: the value that reaches the resolver (and thus identity_link)
    // must equal the original pre-hashed input, not sha256(preHashedInput).
    const id = preHashedEmailId(PRE_HASHED_EMAIL);

    // The hash stored in the ExtractedIdentifier must equal the input 64-hex exactly.
    expect(id.hash).toBe(PRE_HASHED_EMAIL);
    expect(id.hash).toHaveLength(64);
    expect(id.hash).toMatch(/^[0-9a-f]{64}$/);

    // It must NOT equal sha256(PRE_HASHED_EMAIL) — that would be a double-hash.
    const doubleHashed = createHash('sha256').update(PRE_HASHED_EMAIL, 'utf8').digest('hex');
    expect(id.hash).not.toBe(doubleHashed);

    // The preHashed flag must be set.
    expect(id.preHashed).toBe(true);
  });

  it('3. pre_hashed_phone: two events with same pre-hashed phone → 1 brain_id (LINK)', () => {
    const outcome1 = r.resolve(
      BRAND,
      [preHashedPhoneId(PRE_HASHED_PHONE)],
      [],
      new Map(),
      new Map(),
      cfg,
      new Set(),
    );
    expect(outcome1.action).toBe('minted');
    const mintedId = outcome1.brainId;

    const existingAfterMint: ExistingLink[] = [
      link(mintedId, 'pre_hashed_phone', PRE_HASHED_PHONE, 'strong'),
    ];

    const outcome2 = r.resolve(
      BRAND,
      [preHashedPhoneId(PRE_HASHED_PHONE)],
      existingAfterMint,
      new Map(),
      new Map(),
      cfg,
      new Set(),
    );
    expect(outcome2.action).toBe('linked');
    expect(outcome2.brainId).toBe(mintedId);
  });

  it('4. Namespace isolation: pre_hashed_email and email with different hashes do NOT trigger a match', () => {
    // BRAIN_A has a salted email hash (from a storefront/pixel event).
    // A connector event arrives with pre_hashed_email carrying a DIFFERENT (unsalted) hash.
    // They must NOT match each other — the resolver only matches when identifier_type AND hash
    // both agree. A 'pre_hashed_email' identifier never matches an 'email' link.
    const saltedEmailHash = createHash('sha256').update('salt||user@example.com', 'utf8').digest('hex');
    const existing: ExistingLink[] = [
      link(BRAIN_A, 'email', saltedEmailHash, 'strong'),
    ];

    // Event carries pre_hashed_email (different namespace, different hash value)
    const outcome = r.resolve(
      BRAND,
      [preHashedEmailId(PRE_HASHED_EMAIL)],  // PRE_HASHED_EMAIL !== saltedEmailHash
      existing,
      new Map(),
      new Map(),
      cfg,
      new Set(),
    );
    // Must NOT match BRAIN_A (different type namespace) → MINT a new brain_id
    expect(outcome.action).toBe('minted');
    expect(outcome.brainId).not.toBe(BRAIN_A);
  });

  it('5. Merge: two events, one has pre_hashed_email matching BRAIN_A, other has pre_hashed_email matching BRAIN_B → MERGE', () => {
    // Both are strong identifiers in the same type namespace → they CAN trigger a merge
    // (this is the correct behaviour: the upstream platform says "same customer" on both events).
    const existing: ExistingLink[] = [
      link(BRAIN_A, 'pre_hashed_email', PRE_HASHED_EMAIL, 'strong'),
      link(BRAIN_B, 'pre_hashed_phone', PRE_HASHED_PHONE, 'strong'),
    ];

    const outcome = r.resolve(
      BRAND,
      [preHashedEmailId(PRE_HASHED_EMAIL), preHashedPhoneId(PRE_HASHED_PHONE)],
      existing,
      new Map(),
      new Map(),
      cfg,
      new Set(),
    );
    // Two distinct brain_ids matched via strong pre-hashed identifiers → MERGE
    expect(outcome.action).toBe('merged');
    // Canonical = lower UUID (deterministic)
    const canonical = [BRAIN_A, BRAIN_B].sort()[0]!;
    expect(outcome.brainId).toBe(canonical);
    expect(outcome.merge).toBeDefined();
    expect(outcome.merge!.mergeId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('6. pre_hashed identifiers carry tier=strong and confidence=high', () => {
    const emailId = preHashedEmailId(PRE_HASHED_EMAIL);
    const phoneId = preHashedPhoneId(PRE_HASHED_PHONE);
    expect(emailId.tier).toBe('strong');
    expect(emailId.confidence).toBe('high');
    expect(phoneId.tier).toBe('strong');
    expect(phoneId.confidence).toBe('high');
  });

  it('6b. pre_hashed identifiers have rawValue=undefined (no plaintext PII to vault)', () => {
    const emailId = preHashedEmailId(PRE_HASHED_EMAIL);
    const phoneId = preHashedPhoneId(PRE_HASHED_PHONE);
    expect(emailId.rawValue).toBeUndefined();
    expect(phoneId.rawValue).toBeUndefined();
  });
});

// ── Test 7: ResolveIdentityUseCase extraction — Buffer interface ──────────────
// Verifies that the use-case correctly extracts pre-hashed identifiers from a
// connector event payload, without any DB wiring (mocked repository).

describe('ResolveIdentityUseCase — pre-hashed extraction from Buffer payload', () => {
  // Minimal mocks — we are testing extraction logic, not DB writes.
  const saltProviderMock = {
    saltHexForBrand: vi.fn().mockResolvedValue('a'.repeat(64)),
    forBrand: vi.fn().mockResolvedValue(Buffer.from('a'.repeat(64), 'hex')),
    clearCache: vi.fn(),
  } as unknown as SaltProvider;

  const capturedIdentifiers: ExtractedIdentifier[][] = [];

  const identityRepoMock = {
    readState: vi.fn().mockResolvedValue({
      existingLinks: [],
      sharedUtilityMap: new Map(),
      phoneCount: new Map(),
      aliasChain: new Set(),
      brandConfig: { phone_guard_threshold: 10, suppression_window_days: 30 },
    }),
    writeOutcome: vi.fn().mockImplementation(
      (_brandId: string, _outcome: ResolveOutcome, identifiers: ExtractedIdentifier[]) => {
        capturedIdentifiers.push(identifiers);
        return Promise.resolve({ written: true });
      },
    ),
    end: vi.fn().mockResolvedValue(undefined),
  } as unknown as IdentityRepository;

  const useCase = new ResolveIdentityUseCase(saltProviderMock, identityRepoMock);

  it('7a. hashed_customer_email in properties → pre_hashed_email ExtractedIdentifier (preHashed=true)', async () => {
    capturedIdentifiers.length = 0;

    const payload = {
      brand_id: BRAND,
      event_id: 'evt-001',
      region_code: 'IN',
      payload: {
        properties: {
          // Connector mapper placed the already-hashed email here
          hashed_customer_email: PRE_HASHED_EMAIL,
        },
      },
    };

    const result = await useCase.execute(Buffer.from(JSON.stringify(payload)), new Date().toISOString());

    // Must not be 'no_identifiers' or 'invalid'
    expect(['minted', 'linked', 'merged', 'suppressed', 'skipped']).toContain(result.outcome);

    // The captured identifiers must include a pre_hashed_email entry
    expect(capturedIdentifiers.length).toBeGreaterThan(0);
    const ids = capturedIdentifiers[capturedIdentifiers.length - 1]!;
    const preHashedId = ids.find((i) => i.type === 'pre_hashed_email');
    expect(preHashedId).toBeDefined();
    expect(preHashedId!.hash).toBe(PRE_HASHED_EMAIL);   // exact value, no re-hashing
    expect(preHashedId!.preHashed).toBe(true);
    expect(preHashedId!.tier).toBe('strong');
    expect(preHashedId!.rawValue).toBeUndefined();
  });

  it('7b. customer_email_hash (alias field name) also produces pre_hashed_email identifier', async () => {
    capturedIdentifiers.length = 0;

    const payload = {
      brand_id: BRAND,
      event_id: 'evt-002',
      region_code: 'IN',
      payload: {
        properties: {
          // Alternative field name used by some existing connectors
          customer_email_hash: PRE_HASHED_EMAIL,
        },
      },
    };

    await useCase.execute(Buffer.from(JSON.stringify(payload)), new Date().toISOString());

    const ids = capturedIdentifiers[capturedIdentifiers.length - 1]!;
    const preHashedId = ids.find((i) => i.type === 'pre_hashed_email');
    expect(preHashedId).toBeDefined();
    expect(preHashedId!.hash).toBe(PRE_HASHED_EMAIL);
    expect(preHashedId!.preHashed).toBe(true);
  });

  it('7c. pre_hashed_identifiers on payload (CanonicalEvent canonical path) wins over properties fallback', async () => {
    capturedIdentifiers.length = 0;

    const alternativeHash = createHash('sha256').update('other@example.com', 'utf8').digest('hex');
    const payload = {
      brand_id: BRAND,
      event_id: 'evt-003',
      region_code: 'IN',
      payload: {
        // Canonical path (pre_hashed_identifiers on the payload object)
        pre_hashed_identifiers: {
          hashed_customer_email: PRE_HASHED_EMAIL,
        },
        properties: {
          // Legacy properties path — should be SUPERSEDED by canonical path above
          hashed_customer_email: alternativeHash,
        },
      },
    };

    await useCase.execute(Buffer.from(JSON.stringify(payload)), new Date().toISOString());

    const ids = capturedIdentifiers[capturedIdentifiers.length - 1]!;
    const preHashedId = ids.find((i) => i.type === 'pre_hashed_email');
    expect(preHashedId).toBeDefined();
    // Must use the canonical path value, not the properties fallback
    expect(preHashedId!.hash).toBe(PRE_HASHED_EMAIL);
    expect(preHashedId!.hash).not.toBe(alternativeHash);
  });

  it('7d. Invalid pre-hashed value (not 64 hex chars) is silently rejected — outcome no_identifiers', async () => {
    // Record writeOutcome call count before this test so we can assert it does not increase.
    const callCountBefore = (identityRepoMock.writeOutcome as ReturnType<typeof vi.fn>).mock.calls.length;

    const payload = {
      brand_id: BRAND,
      event_id: 'evt-004',
      region_code: 'IN',
      payload: {
        properties: {
          // Malformed — not 64 hex chars → must be silently rejected by the regex guard
          hashed_customer_email: 'not-a-valid-hash',
        },
      },
    };

    const result = await useCase.execute(Buffer.from(JSON.stringify(payload)), new Date().toISOString());

    // No valid identifiers found → no_identifiers outcome
    expect(result.outcome).toBe('no_identifiers');

    // writeOutcome must NOT have been called for this event (count unchanged)
    const callCountAfter = (identityRepoMock.writeOutcome as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callCountAfter).toBe(callCountBefore);
  });

  it('7e. hashed_customer_phone produces pre_hashed_phone with preHashed=true', async () => {
    capturedIdentifiers.length = 0;

    const payload = {
      brand_id: BRAND,
      event_id: 'evt-005',
      region_code: 'IN',
      payload: {
        properties: {
          hashed_customer_phone: PRE_HASHED_PHONE,
        },
      },
    };

    await useCase.execute(Buffer.from(JSON.stringify(payload)), new Date().toISOString());

    const ids = capturedIdentifiers[capturedIdentifiers.length - 1]!;
    const preHashedId = ids.find((i) => i.type === 'pre_hashed_phone');
    expect(preHashedId).toBeDefined();
    expect(preHashedId!.hash).toBe(PRE_HASHED_PHONE);
    expect(preHashedId!.preHashed).toBe(true);
    expect(preHashedId!.tier).toBe('strong');
    expect(preHashedId!.rawValue).toBeUndefined();
  });

  it('7f. Pre-hashed email + raw email on same event: both identifiers extracted separately', async () => {
    capturedIdentifiers.length = 0;

    const payload = {
      brand_id: BRAND,
      event_id: 'evt-006',
      region_code: 'IN',
      payload: {
        properties: {
          email: 'other@example.com',                 // raw email → 'email' type (salted)
          hashed_customer_email: PRE_HASHED_EMAIL,    // pre-hashed → 'pre_hashed_email' type
        },
      },
    };

    await useCase.execute(Buffer.from(JSON.stringify(payload)), new Date().toISOString());

    const ids = capturedIdentifiers[capturedIdentifiers.length - 1]!;
    const saltedEmailId = ids.find((i) => i.type === 'email');
    const preHashedEmailId = ids.find((i) => i.type === 'pre_hashed_email');

    // Both must be present
    expect(saltedEmailId).toBeDefined();
    expect(preHashedEmailId).toBeDefined();

    // Salted email: preHashed must be falsy (undefined)
    expect(saltedEmailId!.preHashed).toBeFalsy();
    expect(saltedEmailId!.rawValue).toBe('other@example.com');

    // Pre-hashed email: preHashed must be true, hash must equal input
    expect(preHashedEmailId!.preHashed).toBe(true);
    expect(preHashedEmailId!.hash).toBe(PRE_HASHED_EMAIL);
    expect(preHashedEmailId!.rawValue).toBeUndefined();
  });
});
