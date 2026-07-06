// SPEC: A.1.4
/**
 * IdentityFieldsOptions — the shared, optional mapper knob for the expanded connector
 * identity field set (Wave A, WA-09; AMD-01 dual-convention).
 *
 * Every connector mapper (Shopify / WooCommerce / Shopflo / GoKwik) accepts this as an
 * OPTIONAL trailing argument. It is the projection of the per-brand feature flag
 * `connector.identity_fields` (@brain/platform-flags), resolved by the CALLER (the
 * webhook pipeline / repull job — the mapper itself stays pure and IO-free) and passed in.
 *
 * SEMANTICS (all load-bearing):
 *   ABSENT or emitInteropIdentifiers !== true  →  the mapper output is BYTE-IDENTICAL to
 *   the pre-Wave-A envelope (flag OFF = today's envelope; §0.5 non-negotiable, tested by
 *   the per-mapper a14 flag-off byte-identity tests).
 *
 *   emitInteropIdentifiers === true  →  the mapper ADDITIONALLY emits, alongside the
 *   existing per-brand-salted fields (which are never changed or removed):
 *     email_sha256          — INTEROP-space plain unsalted sha256(normalized email), via
 *                             @brain/identity-normalization emailInteropHash. This is the
 *                             SAME hash the pixel computes client-side, so pixel identify
 *                             events become joinable with connector identities (AMD-01 R1 —
 *                             the anon→known bridge fix).
 *     phone_sha256          — INTEROP-space plain unsalted sha256(E.164 phone), via
 *                             phoneInteropHash (brand default country = regionCode).
 *     checkout_session_id   — GoKwik/Shopflo order + checkout events, where the provider
 *                             payload carries it (the India-COD join key, §A.1.4).
 *
 * NAMING (AMD-02 R1, BINDING): the existing salted names hashed_customer_email /
 * hashed_customer_phone / storefront_customer_id remain the canonical INTERNAL-space
 * names. `platform_customer_id` from the spec text is ALREADY carried as
 * storefront_customer_id — no parallel field is introduced. The interop-space values get
 * the spec's mParticle-style names email_sha256 / phone_sha256 and are consumed downstream
 * under the `pre_hashed_*` identifier types.
 */
export interface IdentityFieldsOptions {
  /**
   * `connector.identity_fields` flag state for the event's brand (DEFAULT false = OFF).
   * true → dual-write the interop-space fields described above.
   */
  readonly emitInteropIdentifiers?: boolean;
}
