/**
 * extract-identifiers — the ONE pure identifier-extraction path for a Bronze event.
 *
 * Single logical extraction primitive (no-drift): the OPERATOR replay path
 * (jobs/identity/replay-identity) builds ExtractedIdentifier[] from a Bronze payload through THIS
 * module so it hashes IDENTICALLY to the live resolve path. The logic mirrors the inline extraction
 * in ResolveIdentityUseCase byte-for-byte (same field names, same precedence, same 64-hex
 * validation) — the live use-case should adopt these helpers in a follow-up so the duplication
 * collapses to one source (kept separate here only to avoid colliding with concurrent edits to the
 * live use-case). Replay-through-the-same-extractor is what makes the rebuild faithful: the
 * pre-hashed-identity continuity bug class (two extraction paths producing different hashes for the
 * same customer) is avoided by construction. Pure + synchronous: no IO, no salt fetch here (the
 * caller fetches the per-brand salt and passes the hex in). Hash-only downstream (I-S02): rawValue
 * is carried ONLY for the contact_pii vault write and never leaves the resolver.
 *
 * The extraction is split in two so the live caller keeps its "skip the salt fetch when the event
 * has NO identifiers" optimization:
 *   1. extractRawIdentifierFields(parsed) — pure, salt-free read of the candidate raw values +
 *      regionCode + a hasAny flag (decide no_identifiers BEFORE fetching the salt).
 *   2. buildIdentifiers(fields, saltHex, regionCode) — normalize + hash each present field into the
 *      ExtractedIdentifier[] the resolver consumes (identical to the former inline logic).
 */
import { normalizeIdentifier, hashIdentifier, normalizePhone } from '@brain/identity-core';
import type { ExtractedIdentifier } from './IdentityResolver.js';

/** Pre-hashed identifiers MUST be exactly 64 lowercase hex chars — anything else is ignored (fail-safe). */
const PRE_HASHED_REGEX = /^[0-9a-f]{64}$/;

/** The raw (un-hashed, salt-free) identifier candidates read off a Bronze event payload. */
export interface RawIdentifierFields {
  rawEmail: string | null;
  rawPhone: string | null;
  storefrontCustomerId: string | null;
  rawDeviceId: string | null;
  rawAnonId: string | null;
  /** Already-final 64-hex hashes supplied by an upstream connector (NEVER re-hashed). */
  preHashedEmail: string | null;
  preHashedPhone: string | null;
}

export interface ExtractedRawIdentifiers {
  fields: RawIdentifierFields;
  /** Region code from the envelope (drives E.164 phone normalization, D-6). Defaults to 'IN'. */
  regionCode: string;
  /** True iff at least one identifier candidate is present (else the event is no_identifiers). */
  hasAny: boolean;
}

/**
 * Pure, salt-free read of every identifier candidate from a parsed Bronze event.
 *
 * Mirrors the legacy inline extraction in ResolveIdentityUseCase exactly: same field names,
 * same precedence (canonical `pre_hashed_identifiers` map wins over the legacy property names),
 * same 64-hex validation. No IO; safe to call before the per-brand salt is fetched.
 */
export function extractRawIdentifierFields(parsed: Record<string, unknown>): ExtractedRawIdentifiers {
  const regionCode = typeof parsed['region_code'] === 'string' ? (parsed['region_code'] as string) : 'IN';

  const payload = ((parsed['payload'] as Record<string, unknown>) ?? parsed) as Record<string, unknown>;
  const props = ((payload['properties'] as Record<string, unknown>) ?? {}) as Record<string, unknown>;

  const rawEmail =
    typeof props['email'] === 'string' ? (props['email'] as string)
    : typeof props['$email'] === 'string' ? (props['$email'] as string)
    : null;
  const rawPhone =
    typeof props['phone'] === 'string' ? (props['phone'] as string)
    : typeof props['phone_number'] === 'string' ? (props['phone_number'] as string)
    : typeof props['$phone'] === 'string' ? (props['$phone'] as string)
    : null;
  const storefrontCustomerId =
    typeof props['customer_id'] === 'string' ? (props['customer_id'] as string)
    : typeof props['storefront_customer_id'] === 'string' ? (props['storefront_customer_id'] as string)
    : null;

  const rawDeviceId =
    typeof props['device_id'] === 'string' ? (props['device_id'] as string)
    : typeof props['$device_id'] === 'string' ? (props['$device_id'] as string)
    : null;
  const rawAnonId =
    typeof props['brain_anon_id'] === 'string' ? (props['brain_anon_id'] as string)
    : typeof props['anon_id'] === 'string' ? (props['anon_id'] as string)
    : null;

  // Legacy property-name pre-hashed reads.
  const propPreHashedEmail = firstHex(props, ['hashed_customer_email', 'customer_email_hash']);
  const propPreHashedPhone = firstHex(props, ['hashed_customer_phone', 'customer_phone_hash']);

  // Canonical `pre_hashed_identifiers` map (preferred path for new mappers) — wins over legacy.
  const canonicalPreHashed = (payload['pre_hashed_identifiers'] as Record<string, unknown>) ?? null;
  const canonicalPreHashedEmail = canonicalPreHashed ? firstHex(canonicalPreHashed, ['hashed_customer_email']) : null;
  const canonicalPreHashedPhone = canonicalPreHashed ? firstHex(canonicalPreHashed, ['hashed_customer_phone']) : null;

  const preHashedEmail = canonicalPreHashedEmail ?? propPreHashedEmail;
  const preHashedPhone = canonicalPreHashedPhone ?? propPreHashedPhone;

  const fields: RawIdentifierFields = {
    rawEmail,
    rawPhone,
    storefrontCustomerId,
    rawDeviceId,
    rawAnonId,
    preHashedEmail,
    preHashedPhone,
  };

  const hasAny =
    !!rawEmail || !!rawPhone || !!storefrontCustomerId || !!rawDeviceId || !!rawAnonId ||
    !!preHashedEmail || !!preHashedPhone;

  return { fields, regionCode, hasAny };
}

/** Return the first key whose value is a well-formed 64-hex string, else null. */
function firstHex(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && PRE_HASHED_REGEX.test(v)) return v;
  }
  return null;
}

/**
 * Normalize + hash each present raw field into the ExtractedIdentifier[] the resolver consumes.
 *
 * Identical to the former inline logic in ResolveIdentityUseCase:
 *   - email/phone are STRONG (rawValue carried for the contact_pii vault only).
 *   - storefront_customer_id is strong_on_link (not PII → no rawValue).
 *   - device_id / anon_id are MEDIUM (resolve-only, never a merge key — IdentityResolver §3b).
 *   - pre_hashed_email / pre_hashed_phone are STRONG, accepted AS-IS (preHashed: true → no salt).
 *
 * @param saltHex  per-brand salt hex (validated upstream by SaltProvider; D-2 length guard there).
 */
export function buildIdentifiers(
  fields: RawIdentifierFields,
  saltHex: string,
  regionCode = 'IN',
): ExtractedIdentifier[] {
  const identifiers: ExtractedIdentifier[] = [];

  if (fields.rawEmail) {
    const hash = hashIdentifier(fields.rawEmail, 'email', saltHex, regionCode);
    identifiers.push({ type: 'email', hash, tier: 'strong', confidence: 'high', rawValue: fields.rawEmail });
  }

  if (fields.rawPhone) {
    const { normalized: normPhone, confidence } = normalizePhone(fields.rawPhone, regionCode);
    const hash = hashIdentifier(normPhone, 'phone', saltHex, regionCode);
    identifiers.push({ type: 'phone', hash, tier: 'strong', confidence, rawValue: fields.rawPhone });
  }

  if (fields.storefrontCustomerId) {
    const normalized = normalizeIdentifier(fields.storefrontCustomerId, 'external_id', regionCode);
    const hash = hashIdentifier(normalized, 'external_id', saltHex, regionCode);
    identifiers.push({ type: 'storefront_customer_id', hash, tier: 'strong_on_link', confidence: 'high', rawValue: undefined });
  }

  if (fields.rawDeviceId) {
    const hash = hashIdentifier(fields.rawDeviceId, 'device_id', saltHex, regionCode);
    identifiers.push({ type: 'device_id', hash, tier: 'medium', confidence: 'low', rawValue: undefined });
  }

  if (fields.rawAnonId) {
    const normalized = normalizeIdentifier(fields.rawAnonId, 'external_id', regionCode);
    const hash = hashIdentifier(normalized, 'external_id', saltHex, regionCode);
    identifiers.push({ type: 'anon_id', hash, tier: 'medium', confidence: 'low', rawValue: undefined });
  }

  if (fields.preHashedEmail) {
    identifiers.push({ type: 'pre_hashed_email', hash: fields.preHashedEmail, tier: 'strong', confidence: 'high', rawValue: undefined, preHashed: true });
  }

  if (fields.preHashedPhone) {
    identifiers.push({ type: 'pre_hashed_phone', hash: fields.preHashedPhone, tier: 'strong', confidence: 'high', rawValue: undefined, preHashed: true });
  }

  return identifiers;
}
