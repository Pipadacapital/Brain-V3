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
}
