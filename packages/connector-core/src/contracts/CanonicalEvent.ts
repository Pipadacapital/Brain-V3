/**
 * CanonicalEvent — the neutral, source-agnostic event shape every connector mapper produces.
 *
 * This is the contract boundary between "raw provider payload" (per-source, untyped, dirty)
 * and "Brain Bronze event" (uniform, hashed, minor-units). Every mapper (IMapper) projects a
 * provider's raw record into one or more CanonicalEvents — the Single-Primitive Rule applied to
 * ingestion: ONE canonical event shape, every source conforms to it.
 *
 * INVARIANTS encoded by this type:
 *   - I-S07 (money): every monetary amount is integer MINOR units carried as a BIGINT-as-string,
 *     paired with an explicit `currency_code`. There is intentionally no `number` money field.
 *   - I-S02 / D-10 (PII): customer identifiers are HASHES only. There is intentionally no raw
 *     `email` / `phone` field — raw PII is consumed at the mapper boundary and dropped.
 *   - Provenance: `brand_id` + `source` + deterministic `event_id` travel on every event so the
 *     event is tenant-scoped, attributable to its origin, and idempotent on replay.
 */

/** A monetary amount in integer minor units (I-S07). String to preserve BIGINT precision. */
export interface CanonicalMoney {
  /** Integer minor units as a string, e.g. "125000" for ₹1250.00 (I-S07). */
  readonly amount_minor: string;
  /** ISO-4217 currency code, e.g. "INR", "USD" (I-S07 — money never travels without it). */
  readonly currency_code: string;
}

/** Provenance metadata stamped on every canonical event. */
export interface CanonicalProvenance {
  /** Tenant key — the brand the event belongs to. Present at every layer (multi-tenancy). */
  readonly brand_id: string;
  /** Origin connector provider id (matches CONNECTOR_CATALOG ids, e.g. 'shopify', 'razorpay'). */
  readonly source: string;
  /**
   * Deterministic event id (I-ST04) — produced via hashToUuidShaped over a stable namespace.
   * Same logical fact → same id → Bronze ON CONFLICT DO NOTHING dedup on replay.
   */
  readonly event_id: string;
}

/**
 * Pre-hashed customer identifiers contributed by a mapper when the upstream provider payload
 * already carries SHA-256 / SHA-256-lowercased-normalised hashes rather than raw PII values.
 *
 * WHY this exists (connector-pre-hashed-identity gap):
 *   Shopify, WooCommerce, and Shopflo order/checkout webhooks often carry an email or phone that
 *   the UPSTREAM PLATFORM already hashed before delivery. If the mapper were to hash these a
 *   second time the resulting 64-hex value would not match the one produced from a first-party
 *   Pixel or storefront event (where the raw value WAS available). This silent mismatch breaks
 *   brain_id continuity — an order event and a checkout event for the SAME customer produce two
 *   different identity_link rows and two different brain_ids (an LTV/CAC attribution hole).
 *
 * CONTRACT for mappers:
 *   When the upstream payload carries a pre-hashed identifier (already a 64-hex SHA-256 of the
 *   lowercased / E.164-normalised value), the mapper MUST place it here rather than in
 *   `properties`. The value MUST be:
 *     - exactly 64 lowercase hex characters ([0-9a-f]{64})
 *     - SHA-256 of the same lowercased / E.164-normalised form that @brain/identity-core's
 *       `hashIdentifier` would produce FROM THE RAW VALUE (without the per-brand salt prefix) if
 *       the raw value were available.  In other words: the hash that already exists in
 *       identity_link for the same customer, produced from a prior storefront or pixel event.
 *
 * STANDARDISED FIELD NAMES a mapper MUST use inside `properties` when contributing pre-hashed ids:
 *   hashed_customer_email  — 64-hex SHA-256 of normalised email (lowercased)
 *   hashed_customer_phone  — 64-hex SHA-256 of normalised phone (E.164)
 *
 * The identity resolver reads these fields with `preHashed: true` and SKIPS re-hashing, so the
 * hash that reaches identity_link is the same one that the storefront/pixel path would write for
 * the same customer. This closes the multi-connector brain_id continuity gap.
 *
 * SECURITY NOTE: these are NOT salted hashes (the salt cannot be applied upstream by the
 * platform provider). The resolver marks them `tier: 'strong'` but stores them in a separate
 * namespace (identifier_type='pre_hashed_email' / 'pre_hashed_phone') so they never collide with
 * salted hashes from the first-party pixel path in identity_link. Cross-brand correlation risk is
 * bounded: the unsalted hash is ALREADY in the network (the provider sent it); Brain is not the
 * hash originator and does not re-publish it.
 */
export interface CanonicalPreHashedIdentifiers {
  /**
   * 64-hex SHA-256 of lowercased email — already hashed by the upstream provider.
   * MUST satisfy /^[0-9a-f]{64}$/ or it is silently ignored by the resolver.
   */
  readonly hashed_customer_email?: string;
  /**
   * 64-hex SHA-256 of E.164-normalised phone — already hashed by the upstream provider.
   * MUST satisfy /^[0-9a-f]{64}$/ or it is silently ignored by the resolver.
   */
  readonly hashed_customer_phone?: string;
}

/**
 * The canonical Brain event. `properties` is the per-source payload (hashed PII, minor-units
 * money) — typed by each mapper's own properties interface, surfaced here as the open record so
 * the kernel stays source-agnostic. Money inside `properties` follows the CanonicalMoney shape.
 */
export interface CanonicalEvent {
  /** Event name, e.g. 'order.live.v1', 'settlement.recorded.v1'. */
  readonly event_name: string;
  /** ISO-8601 occurrence time (the economic time of the fact, not ingest time). */
  readonly occurred_at: string;
  /** Provenance (tenant key + source + deterministic id). */
  readonly provenance: CanonicalProvenance;
  /** Hashed-PII, minor-units payload. Per-source shape; PII is hashes only (I-S02). */
  readonly properties: Readonly<Record<string, unknown>>;
  /**
   * Optional pre-hashed customer identifiers (connector-pre-hashed-identity gap).
   *
   * When a mapper receives identifiers that the upstream platform already hashed, it places them
   * here instead of in `properties`. The identity resolver reads these with `preHashed: true` and
   * SKIPS re-hashing, preserving hash continuity across the storefront and connector paths.
   *
   * See `CanonicalPreHashedIdentifiers` for the full contract and field name standards.
   */
  readonly pre_hashed_identifiers?: CanonicalPreHashedIdentifiers;
}
