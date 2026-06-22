/**
 * IMapper<TRaw, TCanonical> — the unified mapper contract.
 *
 * Every per-source mapper package (shopify / woocommerce / razorpay / shiprocket / shopflo /
 * gokwik / ad-spend) structurally conforms to this interface: it takes a raw provider record
 * and projects it into a canonical Brain event (or a typed canonical projection). This is the
 * Single-Primitive Rule applied to mapping — ONE mapper contract, every source implements it.
 *
 * The mapper is where the two ingestion invariants are enforced at the boundary:
 *   - I-S07: decimal/raw money → integer minor units + currency_code.
 *   - I-S02 / D-10: raw email/phone consumed and DROPPED; only hashes appear in the output.
 *
 * `TCanonical` defaults to CanonicalEvent but is left generic so a mapper that legitimately
 * emits a richer typed projection (e.g. a settlement projection) can narrow the return type
 * while still satisfying "raw in, canonical out".
 */
import type { CanonicalEvent } from './CanonicalEvent.js';

export interface MapContext {
  /** Tenant key — the brand the raw record belongs to. */
  readonly brandId: string;
  /** Per-brand 64-char hex salt for PII hashing (I-S02). */
  readonly saltHex: string;
  /** Brand region code (e.g. 'IN') — drives phone normalization + hashing. */
  readonly regionCode: string;
}

export interface IMapper<TRaw, TCanonical = CanonicalEvent> {
  /**
   * Project a raw provider record into canonical Brain output.
   *
   * @param raw  the raw provider payload (untyped at the provider edge, typed per source)
   * @param ctx  tenant + hashing context (brand, salt, region)
   * @returns    the canonical event (PII hashed, money in minor units)
   */
  map(raw: TRaw, ctx: MapContext): TCanonical;
}
