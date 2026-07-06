// SPEC: A.1.3
/**
 * @brain/identity-normalization — THE shared normalization + hash package (Wave A, WA-06).
 *
 * One normalization, two hash spaces (AMD-01 — BINDING dual-convention):
 *
 *   INTEROP space  — `interopHash*` = plain unsalted sha256(normalized) → 64-hex.
 *     Used by the pixel (client-side, salting impossible) and by connector DUAL-WRITES so
 *     pixel identify hashes become joinable with connector identities. Carried under
 *     `pre_hashed_*` identifier types (AMD-02).
 *
 *   INTERNAL space — `internalHash*` = the EXISTING identity-core wire convention
 *     sha256( salt ‖ '||' ‖ normalized ) → 64-hex, per-brand salted (cross-brand
 *     uncorrelatability is a tested invariant). NOT reimplemented here: this package
 *     delegates to @brain/identity-core `saltedIdentifierSha256Hex` — ONE source of truth.
 *
 * Normalization (SPEC §A.1.3):
 *   Email — trim, lowercase, NFC-normalize. Gmail dots/plus-tags are NOT stripped
 *     (decision recorded in knowledge-base/amendments/ADR-normalization-gmail.md).
 *     Empty after trim → null (no identifier). No format validation (matches identity-core).
 *   Phone — E.164 via libphonenumber (`libphonenumber-js/max` — full metadata so
 *     `isValid()` is precise, matching Python `phonenumbers`) with the BRAND DEFAULT
 *     COUNTRY (IN / AE / SA / QA / BH / KW / OM). Unparseable OR invalid → null
 *     (no identifier — never a "cleaned digits" fallback). Output includes the '+'.
 *
 * CROSS-LANGUAGE TWIN: db/iceberg/spark/_identity_normalization.py mirrors this module
 * byte-for-byte. Any change here MUST land in the twin, and the A.5.2 property test
 * (src/a52-cross-language-property.test.ts — 10k+ generated identifiers, 0 mismatches)
 * MUST pass. Hash drift silently destroys stitch rates.
 *
 * TRIM NOTE: JS `String.prototype.trim` and Python `str.strip()` disagree on the
 * whitespace set (e.g. U+FEFF is trimmed by JS but not Python; U+0085 the reverse).
 * Both twins therefore strip an EXPLICIT shared edge-whitespace set (see EDGE_WS below).
 */

import { createHash } from 'node:crypto';
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/max';
import { saltedIdentifierSha256Hex } from '@brain/identity-core';

// ── Brand default countries (SPEC A.1.3) ─────────────────────────────────────

/** Supported brand default countries for phone E.164 parsing (IN + GCC markets). */
export const BRAND_DEFAULT_COUNTRIES = ['IN', 'AE', 'SA', 'QA', 'BH', 'KW', 'OM'] as const;
export type BrandDefaultCountry = (typeof BRAND_DEFAULT_COUNTRIES)[number];

// ── Explicit shared edge-whitespace strip (kept in lockstep with the Python twin) ──

// U+0009–U+000D, SPACE, NBSP, OGHAM SPACE, U+2000–U+200A, LS, PS, NNBSP, MMSP,
// IDEOGRAPHIC SPACE, ZWNBSP/BOM. Deliberately EXCLUDES U+0085 (NEL — Python-only)
// so both languages strip the identical set.
const EDGE_WS_CLASS =
  '\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff';
const EDGE_WS_RE = new RegExp(`^[${EDGE_WS_CLASS}]+|[${EDGE_WS_CLASS}]+$`, 'gu');

/** Strip the shared explicit edge-whitespace set (NOT `String.trim` — see module header). */
export function stripEdgeWhitespace(value: string): string {
  return value.replace(EDGE_WS_RE, '');
}

// ── Normalization (SPEC A.1.3) ────────────────────────────────────────────────

/**
 * Email: strip edge whitespace → lowercase → NFC. Empty → null (no identifier).
 * Gmail dots/plus-tags NOT stripped (ADR-normalization-gmail.md).
 */
export function normalizeEmail(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const normalized = stripEdgeWhitespace(raw).toLowerCase().normalize('NFC');
  return normalized.length === 0 ? null : normalized;
}

/**
 * Phone: E.164 via libphonenumber with the brand default country.
 * Unparseable or invalid → null (no identifier). A raw '+…' international
 * number overrides the default country (standard libphonenumber behavior).
 * Returned E.164 includes the leading '+'.
 */
export function normalizePhone(
  raw: string | null | undefined,
  defaultCountry: BrandDefaultCountry | string,
): string | null {
  if (raw == null) return null;
  const stripped = stripEdgeWhitespace(raw);
  if (stripped.length === 0) return null;
  const parsed = parsePhoneNumberFromString(stripped, defaultCountry as CountryCode);
  if (!parsed || !parsed.isValid()) return null;
  return parsed.number; // E.164 including '+'
}

// ── Hashing — AMD-01 dual convention ─────────────────────────────────────────

/**
 * INTEROP space: plain unsalted sha256(normalizedValue) → 64-char lowercase hex.
 * Callers pass an ALREADY-NORMALIZED value (use the convenience wrappers below
 * for raw input). This is the pixel/client-side + connector dual-write space.
 */
export function interopHash(normalizedValue: string): string {
  return createHash('sha256').update(normalizedValue, 'utf8').digest('hex');
}

/**
 * INTERNAL space: sha256( salt ‖ '||' ‖ normalizedValue ) → 64-hex — the EXISTING
 * identity-core per-brand-salted wire convention, delegated (never duplicated).
 * `saltHex` is the SaltProvider-validated per-brand salt.
 */
export function internalHash(normalizedValue: string, saltHex: string): string {
  return saltedIdentifierSha256Hex(saltHex, normalizedValue);
}

/** Re-export: the ONE salted-hash primitive lives in @brain/identity-core. */
export { saltedIdentifierSha256Hex } from '@brain/identity-core';

// ── Convenience: normalize + hash in one call (null-safe end-to-end) ─────────

/** normalizeEmail → interopHash. null when no identifier. */
export function emailInteropHash(raw: string | null | undefined): string | null {
  const normalized = normalizeEmail(raw);
  return normalized === null ? null : interopHash(normalized);
}

/** normalizePhone → interopHash of the E.164 (incl '+'). null when no identifier. */
export function phoneInteropHash(
  raw: string | null | undefined,
  defaultCountry: BrandDefaultCountry | string,
): string | null {
  const normalized = normalizePhone(raw, defaultCountry);
  return normalized === null ? null : interopHash(normalized);
}

/** normalizeEmail → internalHash (per-brand salted). null when no identifier. */
export function emailInternalHash(
  raw: string | null | undefined,
  saltHex: string,
): string | null {
  const normalized = normalizeEmail(raw);
  return normalized === null ? null : internalHash(normalized, saltHex);
}

/** normalizePhone → internalHash of the E.164 (per-brand salted). null when no identifier. */
export function phoneInternalHash(
  raw: string | null | undefined,
  defaultCountry: BrandDefaultCountry | string,
  saltHex: string,
): string | null {
  const normalized = normalizePhone(raw, defaultCountry);
  return normalized === null ? null : internalHash(normalized, saltHex);
}
