/**
 * identity/identifier.ts — the Identifier value object (the tenant-scoped, hash-only
 * resolution key) + the shared identity vocabulary (type / tier / rule-version).
 *
 * THE SINGLE SOURCE OF TRUTH for the identifier shape the identity domain resolves on.
 * The pure `IdentityResolver` (apps/stream-worker) emits `ExtractedIdentifier`; this is
 * the persisted/transported value object that mirrors its `type` + `tier` vocabulary so
 * the two cannot drift. Zod is the source of truth; the TS type is `z.infer`-derived.
 *
 * NON-NEGOTIABLE INVARIANTS:
 *  - HASH-ONLY PII (I-S02): an Identifier carries ONLY `identifier_hash` — a 64-hex
 *    SHA-256 digest. There is NO `raw_value`/email/phone field on this contract and there
 *    never may be. Raw PII lives only in the encrypted contact_pii vault, never here.
 *  - TENANT-SCOPED (brand_id-first): every Identifier is stamped with `brand_id`. A hash
 *    is only meaningful within its brand's salt namespace — the same email under two brands
 *    hashes to two different values, so cross-brand identifier reuse is structurally impossible.
 *  - NO MONEY HERE: nothing on this contract is a monetary amount. (Money = bigint minor
 *    units + currency_code, imported from _money — never appears in the identity domain.)
 */
import { z } from 'zod';

/**
 * The identity rule-version this contract set targets. Mirrors `RULE_VERSION` in
 * apps/stream-worker/src/domain/identity/IdentityResolver.ts — kept in lock-step so the
 * deterministic algorithm and the wire contracts agree on the version string that pins
 * every merge_id and ConfidenceVerdict. Deterministic-first (D-5): there is exactly one
 * enabled rule version.
 */
export const IDENTITY_RULE_VERSION = 'v1-deterministic' as const;

/**
 * Identifier type namespace. Mirrors EXACTLY the `ExtractedIdentifier['type']` union in
 * IdentityResolver.ts (repo wins). `pre_hashed_*` occupy a distinct namespace from the
 * salted first-party hashes so an upstream-provided hash never collides with a first-party
 * salted hash in the identity graph.
 *
 * WEAK SIGNALS (cookie_id / ip / device_fingerprint / session_id) are RESOLVE-ONLY,
 * tier='weak' observational identifiers consumed EXCLUSIVELY by the rule-based, review-gated
 * ProbabilisticMatcher (Fellegi–Sunter). They are NEVER strong merge keys and are IGNORED by
 * the deterministic union-find resolver (which only reads `strong`/`strong_on_link` for merges
 * and `medium` for resolve-only adoption) — so the deterministic graph is unaffected by them.
 */
export const IdentifierTypeSchema = z.enum([
  'email',
  'phone',
  'storefront_customer_id',
  'device_id',
  'anon_id',
  'pre_hashed_email',
  'pre_hashed_phone',
  // ── Weak probabilistic signals (tier='weak', resolve-only, never a merge key) ──
  'cookie_id',
  'ip',
  'device_fingerprint',
  'session_id',
]);
export type IdentifierType = z.infer<typeof IdentifierTypeSchema>;

/**
 * Identifier tier — the merge-eligibility class. Mirrors EXACTLY the
 * `ExtractedIdentifier['tier']` union in IdentityResolver.ts (repo wins):
 *  - `strong` / `strong_on_link` — the ONLY merge keys (deterministic union-find).
 *  - `medium` — resolve-only / NEVER-merge (device_id / anon_id): may let an anonymous
 *    event ADOPT a known brain_id but can never fold two distinct people together.
 *  - `weak` — observational only.
 */
export const IdentifierTierSchema = z.enum([
  'strong',
  'strong_on_link',
  'medium',
  'weak',
]);
export type IdentifierTier = z.infer<typeof IdentifierTierSchema>;

/**
 * A 64-character lowercase-hex SHA-256 digest — the ONLY representation of an identifier
 * value that may cross this seam (I-S02). For standard identifiers this is
 * sha256(brand_salt ‖ normalized_value); for `pre_hashed_*` it is the already-final
 * upstream hash. Never a raw email/phone, never a prefix-truncated display value.
 */
export const IdentifierHashSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'identifier_hash must be a 64-char lowercase-hex SHA-256 digest (hash-only, I-S02)');
export type IdentifierHash = z.infer<typeof IdentifierHashSchema>;

/**
 * The Identifier value object: a tenant-scoped, hash-only resolution key.
 *
 * `{ brand_id, identifier_type, identifier_hash, tier }`. Immutable by convention — an
 * Identifier is a value, not an entity; equality is structural over all four fields.
 */
export const IdentifierSchema = z.object({
  /** Tenant key (brand_id-first isolation). The salt namespace the hash belongs to. */
  brand_id: z.string().uuid(),
  /** The identifier-type namespace (see IdentifierTypeSchema). */
  identifier_type: IdentifierTypeSchema,
  /** 64-hex SHA-256 — hash-only, never raw PII (I-S02). */
  identifier_hash: IdentifierHashSchema,
  /** Merge-eligibility class (see IdentifierTierSchema). */
  tier: IdentifierTierSchema,
});
export type Identifier = z.infer<typeof IdentifierSchema>;
