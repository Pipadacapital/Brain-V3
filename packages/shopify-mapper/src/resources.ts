/**
 * @brain/shopify-mapper/resources — pure mappers for the ADDITIONAL Shopify resources onboarded
 * onto the ingestion framework (products, customers, refunds, fulfillments).
 *
 * Each mapper projects a raw Shopify REST record into the framework's `FetchedRecord` shape:
 *   - `providerId` (or `compositeValues`) — the dedup identity (the driver derives the event_id).
 *   - `events` — one or more `CanonicalEventDraft` (event WITHOUT event_id; the driver stamps it).
 *
 * INVARIANTS (mirror the order mapper):
 *   - I-S07 money: decimal price strings → BIGINT minor units, integer arithmetic only.
 *   - I-S02 / D-10 PII: raw email/phone consumed at this boundary and DROPPED; only hashed
 *     identifiers leave (customers mapper). Pre-hashed identifiers go on the canonical event's
 *     pre_hashed_identifiers slot so the identity resolver keeps hash continuity.
 *   - Provenance: brand_id + source travel on every draft; the deterministic event_id is added by
 *     the driver via the manifest's dedupKeyStrategy (so id derivation lives in exactly one place).
 *
 * These mappers are PURE (no Kafka/pg/clock-randomness) so they are trivially unit-testable and the
 * same code maps a backfill page and a live webhook.
 */

import type { CanonicalEventDraft } from '@brain/connector-core';
import { hashIdentifier, normalizePhone } from '@brain/identity-core';
import { tryDecimalToMinor } from './index.js';

// ── Canonical event names for the new resources ───────────────────────────────
// Sourced from the leaf ./event-names.ts (cycle-safe). Imported for local use in
// the mappers below AND re-exported so existing importers of this module are unchanged.
import {
  PRODUCT_UPSERT_V1_EVENT_NAME,
  CUSTOMER_UPSERT_V1_EVENT_NAME,
  REFUND_RECORDED_V1_EVENT_NAME,
  FULFILLMENT_RECORDED_V1_EVENT_NAME,
  INVENTORY_LEVEL_V1_EVENT_NAME,
} from './event-names.js';
export {
  PRODUCT_UPSERT_V1_EVENT_NAME,
  CUSTOMER_UPSERT_V1_EVENT_NAME,
  REFUND_RECORDED_V1_EVENT_NAME,
  FULFILLMENT_RECORDED_V1_EVENT_NAME,
  INVENTORY_LEVEL_V1_EVENT_NAME,
};

/** What the framework driver needs to emit one raw record: dedup identity + canonical draft(s). */
export interface MappedResourceRecord {
  /** The upstream-immutable id used for provider_id / provider_id+kind dedup. */
  readonly providerId: string;
  /** The canonical event draft(s) this record maps to (no event_id — the driver stamps it). */
  readonly events: readonly CanonicalEventDraft[];
  /** The record's economic occurred_at (drives the backfill reachedAt checkpoint). */
  readonly occurredAt: Date;
}

function isoOrThrow(value: string | null | undefined, fallback: string): string {
  const raw = (value ?? '').trim() || fallback;
  return new Date(raw).toISOString();
}

function provenance(brandId: string): CanonicalEventDraft['provenance'] {
  return { brand_id: brandId, source: 'shopify' };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Products
// ═══════════════════════════════════════════════════════════════════════════════

export interface ShopifyProductVariant {
  id?: number | string | null;
  sku?: string | null;
  title?: string | null;
  price?: string | null; // decimal string
  inventory_quantity?: number | null;
  // ADDITIVE (mapper widening): the inventory-item join key — inventory_levels/update webhooks are
  // keyed on inventory_item_id (NOT variant_id), so this is the ONLY way to join a stock
  // observation back to a sellable variant. Absent on legacy payloads.
  inventory_item_id?: number | string | null;
  // ADDITIVE (mapper widening): the pre-discount "compare at" price (decimal string) — powers
  // markdown/discount-depth analytics. Absent when the variant has no compare-at price.
  compare_at_price?: string | null;
}

export interface ShopifyProductShape {
  id: number | string;
  title?: string | null;
  handle?: string | null;
  status?: string | null; // active | draft | archived
  product_type?: string | null;
  vendor?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  variants?: ShopifyProductVariant[] | null;
  tags?: string | null;
}

export interface ProductUpsertProperties {
  source: 'shopify';
  shopify_product_id: string;
  product_id: string;
  title: string | null;
  handle: string | null;
  status: string | null;
  product_type: string | null;
  vendor: string | null;
  variants: Array<{
    variant_id: string | null;
    sku: string | null;
    title: string | null;
    price_minor: string | null;
    inventory_quantity: number | null;
    // ADDITIVE (optional): join key for inventory.level.v1 observations; null on legacy payloads.
    inventory_item_id: string | null;
    // ADDITIVE (optional): pre-discount price in minor units; null when unset/malformed.
    compare_at_price_minor: string | null;
  }>;
}

/**
 * Map a raw Shopify product → product.upsert.v1. Dedup is provider_id+kind on (product_id,
 * updated_at) — encoded into the providerId so a catalogue edit lands as a NEW Bronze row while a
 * retry of the same state dedups. (The manifest declares provider_id+kind; the event_name folds in
 * the kind, and the updated_at is folded into providerId here so each state is distinct.)
 */
export function mapProductToDraft(
  product: ShopifyProductShape,
  brandId: string,
): MappedResourceRecord {
  const productId = String(product.id);
  const occurredAt = new Date(isoOrThrow(product.updated_at ?? product.created_at, new Date(0).toISOString()));

  const variants = (product.variants ?? []).map((v) => ({
    variant_id: v.id != null ? String(v.id) : null,
    sku: v.sku ?? null,
    title: v.title ?? null,
    price_minor: v.price != null ? (tryDecimalToMinor(v.price)?.toString() ?? null) : null,
    inventory_quantity: typeof v.inventory_quantity === 'number' ? v.inventory_quantity : null,
    inventory_item_id: v.inventory_item_id != null ? String(v.inventory_item_id) : null,
    compare_at_price_minor:
      v.compare_at_price != null ? (tryDecimalToMinor(v.compare_at_price)?.toString() ?? null) : null,
  }));

  const properties: ProductUpsertProperties = {
    source: 'shopify',
    shopify_product_id: productId,
    product_id: productId,
    title: product.title ?? null,
    handle: product.handle ?? null,
    status: product.status ?? null,
    product_type: product.product_type ?? null,
    vendor: product.vendor ?? null,
    variants,
  };

  // Fold updated_at into the dedup identity so distinct catalogue states are distinct Bronze rows.
  const stateMs = occurredAt.getTime();
  return {
    providerId: `${productId}:${stateMs}`,
    occurredAt,
    events: [
      {
        event_name: PRODUCT_UPSERT_V1_EVENT_NAME,
        occurred_at: occurredAt.toISOString(),
        properties: properties as unknown as Record<string, unknown>,
        provenance: provenance(brandId),
      },
    ],
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Customers (hashed PII only — D-10 / I-S02)
// ═══════════════════════════════════════════════════════════════════════════════

/** Shopify customer default_address block (coarse geo only is projected — see mapper). */
export interface ShopifyCustomerAddress {
  city?: string | null;
  province?: string | null;      // full region name, e.g. 'Maharashtra'
  province_code?: string | null; // e.g. 'MH'
  zip?: string | null;
  country_code?: string | null;  // ISO-3166-1 alpha-2, e.g. 'IN'
  country?: string | null;
}

/** Shopify marketing-consent block (email_marketing_consent / sms_marketing_consent). */
export interface ShopifyMarketingConsent {
  state?: string | null; // subscribed | not_subscribed | unsubscribed | pending | ...
  opt_in_level?: string | null;
  consent_updated_at?: string | null;
}

export interface ShopifyCustomerShape {
  id: number | string;
  email?: string | null;
  phone?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  orders_count?: number | null;
  total_spent?: string | null; // decimal string
  state?: string | null; // enabled | disabled | invited | declined
  tags?: string | null;
  currency?: string | null;
  // ADDITIVE (mapper widening): coarse geo + consent. All optional — absent on legacy payloads.
  default_address?: ShopifyCustomerAddress | null;
  email_marketing_consent?: ShopifyMarketingConsent | null;
  sms_marketing_consent?: ShopifyMarketingConsent | null;
  /** Legacy pre-consent-block boolean (older API versions still send it). */
  accepts_marketing?: boolean | null;
}

export interface CustomerUpsertProperties {
  source: 'shopify';
  shopify_customer_id: string;
  customer_id: string;
  state: string | null;
  orders_count: number | null;
  total_spent_minor: string | null;
  currency_code: string | null;
  hashed_customer_email?: string;
  hashed_customer_phone?: string;
  // ── ADDITIVE (mapper widening): coarse, non-identifying geo from default_address — mirrors the
  // WooCommerce customer mapper's billing_country/region/city precedent (segments, NOT identity).
  // Street lines / names are NEVER projected (PII stays behind the hash boundary, D-10 / I-S02).
  default_address_city?: string;
  default_address_province?: string;
  default_address_zip?: string;
  default_address_country_code?: string;
  // ── ADDITIVE: marketing-consent states (drives suppression/eligibility segments). The modern
  // consent blocks win; `accepts_marketing` is the legacy boolean fallback older stores still send.
  email_marketing_consent_state?: string;
  sms_marketing_consent_state?: string;
  accepts_marketing?: boolean;
}

/**
 * Map a raw Shopify customer → customer.upsert.v1. Raw email/phone are hashed via @brain/identity-core
 * at THIS boundary and DROPPED (D-10 / I-S02); only the salted hashes leave. Identity is the
 * customer id; updated_at folded into the dedup identity for per-state restatement.
 *
 * @param saltHex     per-brand 64-hex PII salt
 * @param regionCode  region for phone normalisation (e.g. 'IN')
 */
export function mapCustomerToDraft(
  customer: ShopifyCustomerShape,
  brandId: string,
  saltHex: string,
  regionCode: string,
): MappedResourceRecord {
  const customerId = String(customer.id);
  const occurredAt = new Date(isoOrThrow(customer.updated_at ?? customer.created_at, new Date(0).toISOString()));

  let hashedEmail: string | undefined;
  let hashedPhone: string | undefined;
  if (customer.email) {
    hashedEmail = hashIdentifier(customer.email, 'email', saltHex, regionCode);
  }
  if (customer.phone) {
    const { normalized } = normalizePhone(customer.phone, regionCode);
    hashedPhone = hashIdentifier(normalized, 'phone', saltHex, regionCode);
  }
  // raw email/phone DROPPED here — never leave this scope (D-10)

  const totalSpentMinor =
    customer.total_spent != null ? (tryDecimalToMinor(customer.total_spent)?.toString() ?? null) : null;

  // Coarse geo from default_address (city/province/zip/country) — segment metadata, never identity.
  // province_code preferred over the free-text province name; empty strings are honest-absent.
  const addr = customer.default_address ?? null;
  const str = (v: string | null | undefined): string | undefined =>
    typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
  const addressCity = str(addr?.city);
  const addressProvince = str(addr?.province_code) ?? str(addr?.province);
  const addressZip = str(addr?.zip);
  const addressCountryCode = str(addr?.country_code);

  // Marketing consent: the modern consent blocks; absent → honest-absent (never fabricated).
  const emailConsentState = str(customer.email_marketing_consent?.state);
  const smsConsentState = str(customer.sms_marketing_consent?.state);

  const properties: CustomerUpsertProperties = {
    source: 'shopify',
    shopify_customer_id: customerId,
    customer_id: customerId,
    state: customer.state ?? null,
    orders_count: typeof customer.orders_count === 'number' ? customer.orders_count : null,
    total_spent_minor: totalSpentMinor,
    currency_code: customer.currency ?? null,
    ...(hashedEmail ? { hashed_customer_email: hashedEmail } : {}),
    ...(hashedPhone ? { hashed_customer_phone: hashedPhone } : {}),
    ...(addressCity ? { default_address_city: addressCity } : {}),
    ...(addressProvince ? { default_address_province: addressProvince } : {}),
    ...(addressZip ? { default_address_zip: addressZip } : {}),
    ...(addressCountryCode ? { default_address_country_code: addressCountryCode } : {}),
    ...(emailConsentState ? { email_marketing_consent_state: emailConsentState } : {}),
    ...(smsConsentState ? { sms_marketing_consent_state: smsConsentState } : {}),
    ...(typeof customer.accepts_marketing === 'boolean'
      ? { accepts_marketing: customer.accepts_marketing }
      : {}),
  };

  const stateMs = occurredAt.getTime();
  return {
    providerId: `${customerId}:${stateMs}`,
    occurredAt,
    events: [
      {
        event_name: CUSTOMER_UPSERT_V1_EVENT_NAME,
        occurred_at: occurredAt.toISOString(),
        properties: properties as unknown as Record<string, unknown>,
        provenance: provenance(brandId),
        // Pre-hash continuity: these salted hashes match identity_link (storefront/pixel path).
      },
    ],
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Refunds (read from an order's refunds[])
// ═══════════════════════════════════════════════════════════════════════════════

export interface ShopifyRefundTxn {
  amount?: string | null;
  kind?: string | null; // refund | sale | ...
  status?: string | null; // success | pending | failure | ...
}

export interface ShopifyRefundShape {
  id?: number | string | null;
  order_id?: number | string | null;
  created_at?: string | null;
  processed_at?: string | null;
  note?: string | null;
  currency?: string | null;
  transactions?: ShopifyRefundTxn[] | null;
}

export interface RefundRecordedProperties {
  source: 'shopify';
  shopify_refund_id: string;
  refund_id: string;
  order_id: string | null;
  amount_minor: string; // settled refund total (I-S07)
  currency_code: string | null;
  reason: string | null;
}

/** Sum the SETTLED refund transactions of one Shopify refund (mirrors projectOrderDepth refunds). */
function settledRefundMinor(refund: ShopifyRefundShape): bigint {
  let amt = 0n;
  for (const tx of refund.transactions ?? []) {
    const kind = (tx.kind ?? '').toLowerCase();
    const status = (tx.status ?? 'success').toLowerCase();
    if (kind !== 'refund' && kind !== 'sale') continue;
    if (status !== 'success' && status !== 'pending') continue;
    amt += tryDecimalToMinor(tx.amount) ?? 0n;
  }
  return amt;
}

/**
 * Map a raw Shopify refund → refund.recorded.v1. A refund id is globally unique, so the manifest
 * uses provider_id dedup (one refund → one stable id). currency_code is honest-null when the
 * refund payload does not carry it (the consumer can resolve from the order).
 */
export function mapRefundToDraft(
  refund: ShopifyRefundShape,
  brandId: string,
  currencyCode: string | null,
): MappedResourceRecord {
  const refundId = String(refund.id ?? '');
  if (!refundId) {
    throw new Error('[shopify-mapper] refund missing id');
  }
  const occurredAt = new Date(
    isoOrThrow(refund.processed_at ?? refund.created_at, new Date(0).toISOString()),
  );

  const properties: RefundRecordedProperties = {
    source: 'shopify',
    shopify_refund_id: refundId,
    refund_id: refundId,
    order_id: refund.order_id != null ? String(refund.order_id) : null,
    amount_minor: settledRefundMinor(refund).toString(),
    currency_code: refund.currency ?? currencyCode ?? null,
    reason: refund.note ?? null,
  };

  return {
    providerId: refundId,
    occurredAt,
    events: [
      {
        event_name: REFUND_RECORDED_V1_EVENT_NAME,
        occurred_at: occurredAt.toISOString(),
        properties: properties as unknown as Record<string, unknown>,
        provenance: provenance(brandId),
      },
    ],
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Fulfillments (read from an order's fulfillments[])
// ═══════════════════════════════════════════════════════════════════════════════

export interface ShopifyFulfillmentShape {
  id?: number | string | null;
  order_id?: number | string | null;
  status?: string | null; // success | cancelled | error | failure | pending | open
  shipment_status?: string | null; // confirmed | in_transit | delivered | ...
  tracking_company?: string | null;
  tracking_number?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface FulfillmentRecordedProperties {
  source: 'shopify';
  shopify_fulfillment_id: string;
  fulfillment_id: string;
  order_id: string | null;
  status: string | null;
  shipment_status: string | null;
  tracking_company: string | null;
  tracking_number: string | null;
}

/**
 * Map a raw Shopify fulfillment → fulfillment.recorded.v1. A fulfillment id is globally unique
 * (provider_id dedup). occurred_at = updated_at ?? created_at so a status change restates.
 */
export function mapFulfillmentToDraft(
  fulfillment: ShopifyFulfillmentShape,
  brandId: string,
): MappedResourceRecord {
  const fulfillmentId = String(fulfillment.id ?? '');
  if (!fulfillmentId) {
    throw new Error('[shopify-mapper] fulfillment missing id');
  }
  const occurredAt = new Date(
    isoOrThrow(fulfillment.updated_at ?? fulfillment.created_at, new Date(0).toISOString()),
  );

  const properties: FulfillmentRecordedProperties = {
    source: 'shopify',
    shopify_fulfillment_id: fulfillmentId,
    fulfillment_id: fulfillmentId,
    order_id: fulfillment.order_id != null ? String(fulfillment.order_id) : null,
    status: fulfillment.status ?? null,
    shipment_status: fulfillment.shipment_status ?? null,
    tracking_company: fulfillment.tracking_company ?? null,
    tracking_number: fulfillment.tracking_number ?? null,
  };

  return {
    providerId: fulfillmentId,
    occurredAt,
    events: [
      {
        event_name: FULFILLMENT_RECORDED_V1_EVENT_NAME,
        occurred_at: occurredAt.toISOString(),
        properties: properties as unknown as Record<string, unknown>,
        provenance: provenance(brandId),
      },
    ],
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Inventory levels (inventory_levels/update webhook — P1 webhook expansion)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Raw Shopify inventory_levels/update webhook body. NOTE: the payload carries NO product_id /
 * variant_id — only the inventory_item_id (joinable to product.upsert.v1 variants[]
 * .inventory_item_id) and the location. `available` may legitimately be null (untracked item)
 * or negative (oversold/backorder) — both pass through honestly.
 */
export interface ShopifyInventoryLevelShape {
  inventory_item_id?: number | string | null;
  location_id?: number | string | null;
  available?: number | null;
  updated_at?: string | null;
}

export interface InventoryLevelProperties {
  source: 'shopify';
  inventory_item_id: string;
  location_id: string | null;
  /** On-hand available units — honest-null when untracked; may be negative (oversold). */
  available: number | null;
}

/**
 * Map a raw inventory_levels/update webhook → inventory.level.v1 (a point-in-time stock
 * observation at the inventory-item×location grain). It deliberately does NOT emit
 * product.upsert.v1: silver_inventory_level requires properties.product_id, which this payload
 * cannot provide — restating the product grain from here would fabricate identity. The webhook's
 * updated_at is folded into the dedup identity (like the product/customer state model) so each
 * stock state is a distinct Bronze row while a Shopify retry of the same state dedups.
 *
 * @throws when inventory_item_id is missing (an unaddressable observation — fail loud, the
 *         webhook strategy skips id-less deliveries before calling this).
 */
export function mapInventoryLevelToDraft(
  level: ShopifyInventoryLevelShape,
  brandId: string,
): MappedResourceRecord {
  const inventoryItemId = String(level.inventory_item_id ?? '');
  if (!inventoryItemId) {
    throw new Error('[shopify-mapper] inventory level missing inventory_item_id');
  }
  const locationId = level.location_id != null ? String(level.location_id) : null;
  const occurredAt = new Date(isoOrThrow(level.updated_at, new Date(0).toISOString()));

  const properties: InventoryLevelProperties = {
    source: 'shopify',
    inventory_item_id: inventoryItemId,
    location_id: locationId,
    available: typeof level.available === 'number' ? level.available : null,
  };

  // Identity = item × location × state-time: distinct states land, same-state retries dedup.
  const stateMs = occurredAt.getTime();
  return {
    providerId: `${inventoryItemId}:${locationId ?? 'null'}:${stateMs}`,
    occurredAt,
    events: [
      {
        event_name: INVENTORY_LEVEL_V1_EVENT_NAME,
        occurred_at: occurredAt.toISOString(),
        properties: properties as unknown as Record<string, unknown>,
        provenance: provenance(brandId),
      },
    ],
  };
}
