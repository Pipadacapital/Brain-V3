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

import { createHash } from 'node:crypto';

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
  const input = `${perBrandSalt}||${normalized}`;
  return sha256Hex(input);
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
