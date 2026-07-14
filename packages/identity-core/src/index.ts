/**
 * @brain/identity-core — Centralized identifier hashing (STACK.md ADR-008, I-S02).
 *
 * All PII identifiers (email, phone, device ID, etc.) are hashed before
 * storage in events, Bronze, StarRocks, or caches.
 *
 * Hash = sha256(per-brand-salt || normalized(value))
 *
 * Per-brand salt ensures cross-brand hashes are uncorrelatable (D-2).
 * Salt MUST be a 32-byte (256-bit) cryptographically random value.
 * HARD CRASH if salt is missing or wrong length — see SaltProvider.
 *
 * INVARIANT: Raw PII MUST NOT be logged, stored in events, or passed to
 * the metric engine. Only the hashed identifier flows downstream (I-S02).
 *
 * C-1: stubSha256 removed. Real SHA-256 via node:crypto only.
 * D-6: E.164 phone normalization with regionCode param.
 */

import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

// ── Identifier types ──────────────────────────────────────────────────────────

export type IdentifierType = 'email' | 'phone' | 'device_id' | 'external_id';

// ── Real SHA-256 (C-1 — replaces stubSha256 entirely) ────────────────────────

/**
 * Compute SHA-256 of the input string and return a 64-char lowercase hex string.
 * This is the ONLY hashing function in this package — stubSha256 is deleted.
 * Stability invariant: the same input always produces the same 64-hex output
 * across runs, replays, and deploys (it's deterministic real SHA-256).
 */
function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

// ── Deterministic per-brand DEV salt (feat-realtime-ingestion-pipeline §3.1) ──
//
// Dev-only: when no IDENTITY_SALT_<brand> env var is seeded, derive a STABLE
// 32-byte (64-hex) salt deterministically from the brand_id, so every brand
// works with zero manual seeding AND the same brand always yields the same salt
// (so re-hashing the same email is stable across runs, replays, and processes).
//
// PARITY: this function lives in @brain/identity-core (imported by BOTH apps/core
// and apps/stream-worker) so the SAME brandId yields the SAME 64-hex value in
// every process — the same email therefore hashes identically core↔worker.
//
// PROD IS NEVER AFFECTED: callers gate this behind NODE_ENV !== 'production'.
// In prod the real KMS/AwsSecretsProvider per-brand salt path + the D-2
// empty/wrong-length hard-crash guards stay EXACTLY as-is; resolveDevSaltHex is
// never reached. This only removes the dev manual-seeding failure mode.
//
// sha256 → 32 bytes → 64 lowercase hex chars, so the output satisfies the
// existing D-2 length guards (64-hex / 32-byte) unchanged.

/** Fixed dev master constant. NOT a prod secret — dev-only salt derivation. */
const DEV_SALT_MASTER = 'brain-dev-identity-salt-v1';

/**
 * Dev-only stable per-brand salt. Same brandId → same 64-hex (32 bytes) forever,
 * in every process. Returns lowercase 64-hex (== 32 bytes), satisfying the D-2
 * length guard. MUST NOT be called when NODE_ENV === 'production' (the caller gates).
 */
export function resolveDevSaltHex(brandId: string): string {
  const normalized = brandId.trim().toLowerCase();
  return sha256Hex(`${DEV_SALT_MASTER}||${normalized}`);
}

/**
 * The ONE salt-resolution order, shared by every salt site in apps/core AND
 * apps/stream-worker (Single-Primitive — collapses the duplicated env-read
 * closures into one branch so core and worker resolve IDENTICALLY).
 *
 * Resolution order (feat-realtime-ingestion-pipeline §3.1):
 *   1. Explicit IDENTITY_SALT_<brand> (exactly 64-hex) → use it. Back-compat /
 *      override path; unchanged from before.
 *   2. Else, DEV ONLY (NODE_ENV !== 'production') → resolveDevSaltHex(brandId):
 *      deterministic, stable, zero-seeding, scales to every brand.
 *   3. PROD (NODE_ENV === 'production') → resolveDevSaltHex is NEVER reached;
 *      returns the (possibly empty) env value so the CALLER'S existing D-2
 *      hard-crash guard fires exactly as before. This function itself does NOT
 *      crash — the D-2 length guard at each call site stays the single, intact
 *      crash point. PROD path is provably untouched.
 *
 * NODE_ENV is read from process.env directly (not a per-app config object) so the
 * resolved value is byte-identical in core and worker with no config threading.
 */
export function resolveSaltHex(brandId: string): string {
  const envKey = `IDENTITY_SALT_${brandId.replace(/-/g, '').toUpperCase()}`;
  const fromEnv = process.env[envKey];
  if (fromEnv && fromEnv.length === 64) {
    return fromEnv; // (1) explicit env override — back-compat
  }
  if (process.env['NODE_ENV'] !== 'production') {
    return resolveDevSaltHex(brandId); // (2) dev-only deterministic salt
  }
  return fromEnv ?? ''; // (3) prod: untouched — caller's D-2 guard decides
}

// ── E.164 phone normalization helpers (D-6) ──────────────────────────────────

/**
 * Country-code prefix map for supported regions.
 * Extend as new markets are onboarded (non-IN brands pass their regionCode).
 */
const REGION_PREFIX: Record<string, string> = {
  IN: '+91',  // India — 10-digit local numbers
  // US: '+1', GB: '+44', etc. — add when onboarded
};

/**
 * Normalize a phone number to E.164 form for a given region.
 *
 * Rules (India / IN):
 *   +919876543210 → +919876543210 (already E.164)
 *   09876543210   → +919876543210 (leading-0 India local)
 *   9876543210    → +919876543210 (10-digit bare)
 *   +1XXXXXXXXXX  → kept as-is (different region)
 *   anything else → digit-stripped + kept (low-confidence, no crash — D-6)
 *
 * @param raw         Raw phone string (may contain spaces, dashes, parens).
 * @param regionCode  Brand's region code (e.g. 'IN'). Drives the CC prefix.
 * @returns           { normalized: string; confidence: 'high' | 'low' }
 */
export function normalizePhone(
  raw: string,
  regionCode: string,
): { normalized: string; confidence: 'high' | 'low' } {
  // Strip everything except digits and leading +
  const stripped = raw.trim().replace(/[^\d+]/g, '');

  const prefix = REGION_PREFIX[regionCode.toUpperCase()];

  if (!prefix) {
    // Unknown region — return digit-stripped form, low confidence
    return { normalized: stripped, confidence: 'low' };
  }

  // Already full E.164 (starts with + and at least the country code)
  if (stripped.startsWith('+')) {
    // If it matches the expected region prefix + 10 digits — high confidence
    if (stripped.startsWith(prefix) && stripped.length === prefix.length + 10) {
      return { normalized: stripped, confidence: 'high' };
    }
    // Different country code or unknown length — keep as-is, low confidence
    return { normalized: stripped, confidence: 'low' };
  }

  // India-specific local forms
  if (regionCode.toUpperCase() === 'IN') {
    // 10-digit bare (no leading 0)
    if (/^\d{10}$/.test(stripped)) {
      return { normalized: `${prefix}${stripped}`, confidence: 'high' };
    }
    // 11-digit leading-0 (STD trunk prefix)
    if (/^0\d{10}$/.test(stripped)) {
      return { normalized: `${prefix}${stripped.slice(1)}`, confidence: 'high' };
    }
  }

  // Cannot normalize — return digit-stripped form, low confidence (no crash — D-6)
  return { normalized: stripped, confidence: 'low' };
}

// ── Normalization ─────────────────────────────────────────────────────────────

/**
 * Normalize a raw identifier before hashing.
 * Normalization ensures that "User@Example.COM" and "user@example.com"
 * hash to the same value (consistent cross-event stitching).
 *
 * @param value       Raw identifier value.
 * @param type        Identifier type.
 * @param regionCode  Required for 'phone' type — drives E.164 normalization.
 *                    Pass the brand's region_code (e.g. 'IN').
 *                    Ignored for non-phone types.
 * @returns           Normalized string for hashing.
 */
export function normalizeIdentifier(
  value: string,
  type: IdentifierType,
  regionCode = 'IN',
): string {
  switch (type) {
    case 'email':
      return value.trim().toLowerCase();
    case 'phone': {
      // E.164 normalization — callers may also call normalizePhone() directly
      // to get the confidence flag. normalizeIdentifier always returns the
      // normalized form (low or high confidence); the caller decides whether to
      // record the confidence on identity_link.
      const { normalized } = normalizePhone(value, regionCode);
      return normalized;
    }
    case 'device_id':
    case 'external_id':
      return value.trim();
  }
}

// ── Hashing ───────────────────────────────────────────────────────────────────

/**
 * Hash a raw identifier with a per-brand salt using real SHA-256 (C-1).
 *
 * Output: 64-char lowercase hex string (SHA-256 digest of salt‖normalized_value).
 *
 * INVARIANT: the salt MUST be a 32-byte (64-hex or base64-decoded 32-byte) value
 * obtained from SaltProvider, which hard-crashes on fetch failure (D-2). This
 * function trusts that the caller validated the salt length.
 *
 * @param value        Raw identifier (e.g. email address, phone number).
 * @param type         Type of identifier (for normalization routing).
 * @param perBrandSalt Per-brand salt string (hex or base64 of 32 bytes from KMS).
 * @param regionCode   For phone normalization (default 'IN').
 * @returns            64-char hex SHA-256 digest. NEVER raw PII.
 */
export function hashIdentifier(
  value: string,
  type: IdentifierType,
  perBrandSalt: string,
  regionCode = 'IN',
): string {
  const normalized = normalizeIdentifier(value, type, regionCode);
  // Canonical input: salt ‖ '||' ‖ normalized (preserves existing wire format)
  return saltedIdentifierSha256Hex(perBrandSalt, normalized);
}

// SPEC: A.1.3 (WA-06 — AMD-01 internal salted space; primitive extracted for reuse)
/**
 * The ONE salted-identifier hash primitive: sha256( salt ‖ '||' ‖ normalizedValue ) → 64-hex.
 *
 * This IS the existing identity-core wire convention (AMD-01's "internal space") — extracted
 * ADDITIVELY so @brain/identity-normalization can wrap it without duplicating the convention
 * (one source of truth). hashIdentifier above now delegates here; byte output for every
 * existing caller is unchanged.
 *
 * Callers pass an ALREADY-NORMALIZED value (hashIdentifier normalizes via normalizeIdentifier;
 * identity-normalization normalizes per SPEC A.1.3 — NFC email, libphonenumber E.164 phone)
 * and a SaltProvider-validated per-brand salt.
 */
export function saltedIdentifierSha256Hex(perBrandSalt: string, normalizedValue: string): string {
  return sha256Hex(`${perBrandSalt}||${normalizedValue}`);
}

/**
 * Hash all identifier types for a single contact and return a map.
 * Use this when stitching multiple identifier types for the same contact.
 */
export function hashAllIdentifiers(
  identifiers: Partial<Record<IdentifierType, string>>,
  perBrandSalt: string,
  regionCode = 'IN',
): Partial<Record<IdentifierType, string>> {
  const result: Partial<Record<IdentifierType, string>> = {};
  for (const [type, value] of Object.entries(identifiers) as [IdentifierType, string][]) {
    if (value) {
      result[type] = hashIdentifier(value, type, perBrandSalt, regionCode);
    }
  }
  return result;
}

// ── Meta CAPI match hash (UNSALTED — the Meta-mandated match format) ──────────

/**
 * Compute the Meta CAPI advanced-matching hash for an identifier (Phase 6).
 *
 * Meta's Conversions API matches `em`/`ph` user-data by `sha256(normalized_value)`
 * with NO secret salt — Meta hashes their own copy of the value identically, so a
 * salted hash would never match (0% match quality). This is the ONE place in the
 * system an UNSALTED hash leaves the boundary, and it is the format Meta requires.
 *
 * This is NOT a second hasher: it reuses `normalizeIdentifier()` (the SAME
 * normalization used everywhere) and the SAME `sha256Hex`. Only the per-brand salt
 * is omitted, exactly as the Meta match spec mandates.
 *
 * INVARIANT: the raw `value` is read transiently at the wire boundary (from the
 * contact_pii vault, send_service role) and discarded immediately. Only the returned
 * 64-hex digest ever travels — the raw PII is NEVER stored or logged (I-S02).
 *
 * @param value       Raw identifier (email / phone). Normalized then hashed.
 * @param type        'email' | 'phone' (drives normalization; E.164 for phone).
 * @param regionCode  For phone normalization (default 'IN').
 * @returns           64-char lowercase hex SHA-256 of the normalized value. NEVER raw PII.
 */
export function metaMatchHash(
  value: string,
  type: Extract<IdentifierType, 'email' | 'phone'>,
  regionCode = 'IN',
): string {
  const normalized = normalizeIdentifier(value, type, regionCode);
  // NO salt — Meta's match spec is sha256 of the normalized value alone.
  return sha256Hex(normalized);
}

// ── PII vault reference helper ────────────────────────────────────────────────

/**
 * Build a PII vault reference string.
 * This is stored instead of raw PII in events and caches.
 * The real PII lives in contact_pii (KMS-encrypted in prod, send_service role only).
 */
export function piiVaultRef(brandId: string, hashedId: string): string {
  return `vault:${brandId}:${hashedId}`;
}

// ── Conformance vector (C-1 + D-2 + D-6) ─────────────────────────────────────
// These are exported so test suites can pin the known SHA-256 output and
// assert replay-stable hashing without re-computing the vector in tests.

/**
 * Compute the conformance hash vector for CI.
 * hashIdentifier('user@example.com', 'email', 'test-salt') must equal this.
 * Pinned at: sha256('test-salt||user@example.com')
 */
export const CONFORMANCE_EMAIL_VECTOR = sha256Hex('test-salt||user@example.com');

/**
 * Conformance vector for the deterministic dev salt (feat-realtime-ingestion-pipeline).
 * resolveDevSaltHex('00000000-0000-0000-0000-000000000001') must equal this in EVERY
 * process — both apps/core and apps/stream-worker pin it to assert cross-process parity
 * (same brandId → same 64-hex everywhere → same email hashes identically core↔worker).
 * Pinned at: sha256('brain-dev-identity-salt-v1||00000000-0000-0000-0000-000000000001')
 */
export const CONFORMANCE_DEV_SALT_VECTOR = resolveDevSaltHex(
  '00000000-0000-0000-0000-000000000001',
);

// ── PII vault envelope encryption (P0-C — AES-256-GCM, I-S05/I-S09) ───────────
//
// The contact_pii vault stores CIPHERTEXT, never plaintext. Each value is encrypted
// with the per-brand DEK (prod: KMS-unwrapped brand_keyring DEK; dev: deriveDevVaultDek)
// using AES-256-GCM with a fresh 96-bit IV. The 128-bit auth tag makes tampering /
// wrong-key decryption FAIL loudly (no silent garbage). Crypto-shredding the brand DEK
// (brand_keyring.is_active=FALSE) renders every row unrecoverable → DPDP erasure (I-S05).

/** AES-256-GCM envelope: ciphertext + 12-byte IV + 16-byte auth tag. */
export interface PiiEnvelope {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

/** Encrypt a PII string with a 32-byte DEK. Fresh random IV per call. */
export function encryptPii(dek: Buffer, plaintext: string): PiiEnvelope {
  if (dek.length !== 32) {
    throw new Error('[pii-vault] DEK must be exactly 32 bytes (AES-256)');
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', dek, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { ciphertext, iv, authTag };
}

/**
 * Decrypt a PII envelope with the 32-byte DEK that encrypted it.
 * Throws if the auth tag fails (tampered ciphertext / IV / tag, or wrong DEK) — fail-closed.
 */
export function decryptPii(dek: Buffer, env: PiiEnvelope): string {
  if (dek.length !== 32) {
    throw new Error('[pii-vault] DEK must be exactly 32 bytes (AES-256)');
  }
  const decipher = createDecipheriv('aes-256-gcm', dek, env.iv);
  decipher.setAuthTag(env.authTag);
  const plaintext = Buffer.concat([decipher.update(env.ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

/** Fixed dev master constant for vault DEK derivation. NOT a prod secret. */
const DEV_VAULT_DEK_MASTER = 'brain-dev-pii-vault-dek-v1';

/**
 * Dev-only deterministic per-brand 32-byte DEK. Same brandId → same key, so a value
 * encrypted in one process decrypts in another. MUST NOT be used when NODE_ENV ===
 * 'production' — prod unwraps the real brand_keyring DEK via KMS (the caller gates this).
 */
export function deriveDevVaultDek(brandId: string): Buffer {
  return createHash('sha256').update(`${DEV_VAULT_DEK_MASTER}||${brandId.trim().toLowerCase()}`).digest();
}

/** Fixed dev master constant for per-subject vault DEK derivation. NOT a prod secret. */
const DEV_SUBJECT_VAULT_DEK_MASTER = 'brain-dev-pii-subject-vault-dek-v1';

/**
 * Dev-only deterministic per-subject 32-byte DEK. Same (brandId, subjectId) → same key across
 * all processes, so a value encrypted in one process decrypts in another. Distinct from the
 * per-brand DEK (different master constant + includes subjectId in the derivation input) so
 * cross-subject DEKs are uncorrelatable. MUST NOT be used when NODE_ENV === 'production' —
 * prod unwraps the real tenancy.subject_keyring DEK via KMS (the caller gates this).
 */
export function deriveDevSubjectVaultDek(brandId: string, subjectId: string): Buffer {
  return createHash('sha256')
    .update(`${DEV_SUBJECT_VAULT_DEK_MASTER}||${brandId.trim().toLowerCase()}||${subjectId.trim().toLowerCase()}`)
    .digest();
}
