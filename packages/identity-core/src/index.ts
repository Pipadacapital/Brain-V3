/**
 * @brain/identity-core — Centralized identifier hashing (STACK.md ADR-008, I-S02).
 *
 * All PII identifiers (email, phone, device ID, etc.) are hashed before
 * storage in events, Bronze, StarRocks, or caches.
 *
 * Hash = sha256(per-brand-salt || normalized(value))
 *
 * Per-brand salt ensures cross-brand hashes are uncorrelatable.
 *
 * Sprint-0: stub implementation. The real implementation uses Node.js
 * crypto.createHash('sha256') + a salt fetched from brand_keyring via KMS.
 * This stub uses a deterministic algorithm sufficient for unit tests.
 *
 * INVARIANT: Raw PII MUST NOT be logged, stored in events, or passed to
 * the metric engine. Only the hashed identifier flows downstream (I-S02).
 */

// ── Identifier types ──────────────────────────────────────────────────────────

export type IdentifierType = 'email' | 'phone' | 'device_id' | 'external_id';

// ── Normalization ─────────────────────────────────────────────────────────────

/**
 * Normalize a raw identifier before hashing.
 * Normalization ensures that "User@Example.COM" and "user@example.com"
 * hash to the same value (consistent cross-event stitching).
 */
export function normalizeIdentifier(value: string, type: IdentifierType): string {
  switch (type) {
    case 'email':
      return value.trim().toLowerCase();
    case 'phone':
      // Strip non-digit characters; keep leading +
      return value.trim().replace(/[^\d+]/g, '');
    case 'device_id':
    case 'external_id':
      return value.trim();
  }
}

// ── Hashing ───────────────────────────────────────────────────────────────────

/**
 * Hash a raw identifier with a per-brand salt.
 *
 * Sprint-0 stub: uses a simple deterministic hash.
 * M1 replacement: sha256(perBrandSalt || normalizedValue) via Node.js crypto.
 *
 * @param value - Raw identifier (e.g. email address, phone number).
 * @param type - Type of identifier (for normalization).
 * @param perBrandSalt - A brand-specific salt from the KMS DEK derivation.
 * @returns Hex-encoded hash string.
 */
export function hashIdentifier(
  value: string,
  type: IdentifierType,
  perBrandSalt: string,
): string {
  const normalized = normalizeIdentifier(value, type);
  const input = `${perBrandSalt}||${normalized}`;
  return stubSha256(input);
}

/**
 * Hash all identifier types for a single contact and return a map.
 * Use this when stitching multiple identifier types for the same contact.
 */
export function hashAllIdentifiers(
  identifiers: Partial<Record<IdentifierType, string>>,
  perBrandSalt: string,
): Partial<Record<IdentifierType, string>> {
  const result: Partial<Record<IdentifierType, string>> = {};
  for (const [type, value] of Object.entries(identifiers) as [IdentifierType, string][]) {
    if (value) {
      result[type] = hashIdentifier(value, type, perBrandSalt);
    }
  }
  return result;
}

// ── Stub sha256 (Sprint-0 — replaced with real crypto in M1) ─────────────────

/**
 * Stub sha256: deterministic but NOT cryptographic.
 * Produces a 64-char hex string for unit test consistency.
 * M1 replaces with: crypto.createHash('sha256').update(input).digest('hex')
 */
function stubSha256(input: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const r = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  // Pad to 64 chars to resemble a sha256 output length.
  return r.toString(16).padStart(16, '0').repeat(4).slice(0, 64);
}

// ── PII vault reference helper ────────────────────────────────────────────────

/**
 * Build a PII vault reference string.
 * This is stored instead of raw PII in events and caches.
 * The real PII lives in contact_pii (KMS-encrypted, send_service role only).
 */
export function piiVaultRef(brandId: string, hashedId: string): string {
  return `vault:${brandId}:${hashedId}`;
}
