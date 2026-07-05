/**
 * @brain/woocommerce-mapper/resources — pure mappers for the ADDITIONAL WooCommerce resources
 * onboarded onto the ingestion framework (products, customers, coupons, refunds).
 *
 * Mirrors @brain/shopify-mapper/resources: each mapper projects a raw wc/v3 record into the
 * framework's record shape (dedup identity + CanonicalEventDraft[] with NO event_id — the driver
 * stamps it). Pure (no Kafka/pg/clock-randomness) so the SAME code maps a backfill page and a live
 * webhook.
 *
 * INVARIANTS (mirror the order mapper):
 *   - I-S07 money: decimal price strings → BIGINT minor units, CURRENCY-AWARE (per-currency exponent
 *     via @brain/money) — never a hardcoded x100, never an INR default.
 *   - I-S02 / D-10 PII: raw email/phone consumed at THIS boundary and DROPPED (customers mapper);
 *     only salted hashes leave. Coarse geo (country/region/city) is non-identifying and carried.
 *   - Provenance: brand_id + source travel on every draft; the deterministic event_id is added by the
 *     driver via the manifest's dedupKeyStrategy.
 *
 * SHAPE PARITY: product.upsert.v1 / customer.upsert.v1 / refund.recorded.v1 emit the IDENTICAL
 * canonical shape @brain/shopify-mapper produces (source:'woocommerce'), so the EXISTING silver
 * builders (silver_product_variant / silver_inventory_level / silver_refund / customer directory)
 * consume both storefronts with one code path. coupon.upsert.v1 is a NEW grain (no Shopify peer).
 */

import type { CanonicalEventDraft } from '@brain/connector-core';
import { hashIdentifier, normalizePhone } from '@brain/identity-core';
import {
  tryDecimalToMinor,
  mapWooOrderToEvent,
  type WooOrderShape,
  type WooRefund,
  type DataSource,
} from './index.js';

/** Canonical event names — SHARED with @brain/shopify-mapper (product/customer/refund) + the NEW
 *  coupon grain. Sourced from the leaf ./event-names.ts (cycle-safe); imported + re-exported. */
import {
  PRODUCT_UPSERT_V1_EVENT_NAME,
  CUSTOMER_UPSERT_V1_EVENT_NAME,
  COUPON_UPSERT_V1_EVENT_NAME,
  REFUND_RECORDED_V1_EVENT_NAME,
} from './event-names.js';
export {
  PRODUCT_UPSERT_V1_EVENT_NAME,
  CUSTOMER_UPSERT_V1_EVENT_NAME,
  COUPON_UPSERT_V1_EVENT_NAME,
  REFUND_RECORDED_V1_EVENT_NAME,
};

/** What the framework driver needs to emit one raw record: dedup identity + canonical draft(s). */
export interface MappedResourceRecord {
  readonly providerId: string;
  readonly events: readonly CanonicalEventDraft[];
  readonly occurredAt: Date;
}

function toUtcIso(value: string | null | undefined, fallbackIso: string): string {
  const raw = (value ?? '').trim() || fallbackIso;
  const hasTz = /[zZ]$/.test(raw) || /[+-]\d{2}:?\d{2}$/.test(raw);
  return new Date(hasTz ? raw : `${raw}Z`).toISOString();
}

function provenance(brandId: string): CanonicalEventDraft['provenance'] {
  return { brand_id: brandId, source: 'woocommerce' };
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s.length === 0 ? null : s;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Products (product.upsert.v1 — Shopify-parity shape + currency sibling)
// ═══════════════════════════════════════════════════════════════════════════════

export interface WooProductVariation {
  id?: number | string | null;
  sku?: string | null;
  price?: string | number | null;
  stock_quantity?: number | null;
  [key: string]: unknown;
}

export interface WooProductShape {
  id: number | string;
  name?: string | null;
  slug?: string | null;
  status?: string | null; // publish | draft | pending | private
  type?: string | null; // simple | variable | grouped | external
  sku?: string | null;
  price?: string | number | null;
  regular_price?: string | number | null;
  stock_quantity?: number | null;
  date_created_gmt?: string | null;
  date_modified_gmt?: string | null;
  variations?: WooProductVariation[] | null;
  [key: string]: unknown;
}

/** One variant — IDENTICAL keys to shopify-mapper's product variant + a currency_code sibling so
 *  the price_minor is never a bare/blended number (MONEY FIX). */
export interface WooProductVariantOut {
  variant_id: string | null;
  sku: string | null;
  title: string | null;
  price_minor: string | null;
  currency_code: string | null;
  inventory_quantity: number | null;
}

export interface WooProductUpsertProperties {
  source: 'woocommerce';
  woocommerce_product_id: string;
  product_id: string;
  title: string | null;
  handle: string | null;
  status: string | null;
  type: string | null;
  /** Store currency the catalogue price is denominated in — the sibling for price_minor (MONEY FIX). */
  currency_code: string | null;
  // ── Flat fields (simple product / variations-as-ids only) — read by the silver flat branch. ──
  sku: string | null;
  price_minor: string | null;
  stock_quantity: number | null;
  // ── Variant array (variable product with full variation objects) — Shopify-parity; each variant
  //    carries its own price_minor + currency_code sibling. Empty when the product is flat. ──
  variants: WooProductVariantOut[];
}

/**
 * Map a raw WooCommerce product → product.upsert.v1. Identity is product id; date_modified folded
 * into the dedup identity so distinct catalogue states are distinct Bronze rows (provider_id+kind).
 *
 * MONEY FIX: every price is scaled by the STORE currency (currency-aware), and a currency_code
 * sibling is carried at the product level AND on each variant (closing the resources.ts gap where
 * variant prices had no currency sibling). The wc/v3 /products list endpoint returns variation IDs
 * only — when the fetcher has resolved full variation objects (per-variation price fetch) they
 * populate `variants[]`; otherwise the product-level price flows on the flat fields.
 *
 * @param currencyCode  store currency (e.g. 'INR'/'JPY'/'KWD') — drives price scaling + the sibling.
 */
export function mapWooProductToDraft(
  product: WooProductShape,
  brandId: string,
  currencyCode: string,
): MappedResourceRecord {
  const productId = String(product.id);
  const occurredAt = new Date(
    toUtcIso(product.date_modified_gmt ?? product.date_created_gmt, new Date(0).toISOString()),
  );
  const currency = (currencyCode ?? '').trim().toUpperCase() || null;

  const rawPrice = product.price ?? product.regular_price;
  const priceMinor =
    rawPrice != null && currency ? (tryDecimalToMinor(rawPrice, currency)?.toString() ?? null) : null;

  const variants: WooProductVariantOut[] = (product.variations ?? [])
    // Only FULL variation objects carry a price/sku; bare-id entries (list endpoint) are skipped —
    // those degrade to the flat product-level price below.
    .filter((v) => v != null && (v.price != null || v.sku != null))
    .map((v) => ({
      variant_id: v.id != null ? String(v.id) : null,
      sku: str(v.sku),
      title: null,
      price_minor:
        v.price != null && currency ? (tryDecimalToMinor(v.price, currency)?.toString() ?? null) : null,
      currency_code: currency,
      inventory_quantity: num(v.stock_quantity),
    }));

  const properties: WooProductUpsertProperties = {
    source: 'woocommerce',
    woocommerce_product_id: productId,
    product_id: productId,
    title: str(product.name),
    handle: str(product.slug),
    status: str(product.status),
    type: str(product.type),
    currency_code: currency,
    sku: str(product.sku),
    price_minor: priceMinor,
    stock_quantity: num(product.stock_quantity),
    variants,
  };

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
// Customers (customer.upsert.v1 — Shopify-parity; hashed PII only — D-10 / I-S02)
// ═══════════════════════════════════════════════════════════════════════════════

export interface WooCustomerAddress {
  email?: string | null;
  phone?: string | null;
  country?: string | null;
  state?: string | null;
  city?: string | null;
  postcode?: string | null;
  [key: string]: unknown;
}

export interface WooCustomerShape {
  id: number | string;
  email?: string | null;
  phone?: string | null;
  role?: string | null;
  username?: string | null;
  is_paying_customer?: boolean | null;
  orders_count?: number | null;
  total_spent?: string | number | null;
  date_created_gmt?: string | null;
  date_modified_gmt?: string | null;
  billing?: WooCustomerAddress | null;
  shipping?: WooCustomerAddress | null;
  [key: string]: unknown;
}

export interface WooCustomerUpsertProperties {
  source: 'woocommerce';
  woocommerce_customer_id: string;
  customer_id: string;
  state: string | null;
  orders_count: number | null;
  total_spent_minor: string | null;
  currency_code: string | null;
  hashed_customer_email?: string;
  hashed_customer_phone?: string;
  // ── Coarse, non-identifying geo (NOT PII) — billing/shipping country/region/city for segments.
  //    Street/postcode/email/phone are PII and never leave this boundary in raw form. ──
  billing_country?: string;
  billing_region?: string;
  billing_city?: string;
  shipping_country?: string;
  shipping_region?: string;
  shipping_city?: string;
}

/**
 * Map a raw WooCommerce customer → customer.upsert.v1. Raw email/phone are hashed via
 * @brain/identity-core at THIS boundary and DROPPED (D-10 / I-S02); only the salted hashes leave.
 * Identity is the customer id; date_modified folded into the dedup identity for per-state restatement.
 *
 * email/phone are read from the top-level fields, falling back to the billing address block (the
 * wc/v3 customer carries them under `billing`).
 *
 * @param saltHex       per-brand 64-hex PII salt
 * @param regionCode    region for phone normalisation (e.g. 'IN')
 * @param currencyCode  store currency — the sibling for total_spent_minor (MONEY FIX); honest-null
 *                      when not supplied / customer carries no lifetime spend.
 */
export function mapWooCustomerToDraft(
  customer: WooCustomerShape,
  brandId: string,
  saltHex: string,
  regionCode: string,
  currencyCode?: string,
): MappedResourceRecord {
  const customerId = String(customer.id);
  const occurredAt = new Date(
    toUtcIso(customer.date_modified_gmt ?? customer.date_created_gmt, new Date(0).toISOString()),
  );
  const currency = (currencyCode ?? '').trim().toUpperCase() || null;

  const rawEmail = customer.email ?? customer.billing?.email ?? null;
  const rawPhone = customer.phone ?? customer.billing?.phone ?? null;

  let hashedEmail: string | undefined;
  let hashedPhone: string | undefined;
  if (rawEmail) {
    hashedEmail = hashIdentifier(rawEmail, 'email', saltHex, regionCode);
  }
  if (rawPhone) {
    const { normalized } = normalizePhone(rawPhone, regionCode);
    hashedPhone = hashIdentifier(normalized, 'phone', saltHex, regionCode);
  }
  // raw email/phone DROPPED here — never leave this scope (D-10)

  const totalSpentMinor =
    customer.total_spent != null && currency
      ? (tryDecimalToMinor(customer.total_spent, currency)?.toString() ?? null)
      : null;

  // Woo has no Shopify-style enabled/disabled state — derive an honest one from role / paying flag.
  const state =
    str(customer.role) ??
    (typeof customer.is_paying_customer === 'boolean'
      ? customer.is_paying_customer
        ? 'paying'
        : 'non_paying'
      : null);

  const billing = customer.billing ?? null;
  const shipping = customer.shipping ?? null;

  const properties: WooCustomerUpsertProperties = {
    source: 'woocommerce',
    woocommerce_customer_id: customerId,
    customer_id: customerId,
    state,
    orders_count: num(customer.orders_count),
    total_spent_minor: totalSpentMinor,
    currency_code: currency,
    ...(hashedEmail ? { hashed_customer_email: hashedEmail } : {}),
    ...(hashedPhone ? { hashed_customer_phone: hashedPhone } : {}),
    ...(str(billing?.country) ? { billing_country: str(billing?.country) as string } : {}),
    ...(str(billing?.state) ? { billing_region: str(billing?.state) as string } : {}),
    ...(str(billing?.city) ? { billing_city: str(billing?.city) as string } : {}),
    ...(str(shipping?.country) ? { shipping_country: str(shipping?.country) as string } : {}),
    ...(str(shipping?.state) ? { shipping_region: str(shipping?.state) as string } : {}),
    ...(str(shipping?.city) ? { shipping_city: str(shipping?.city) as string } : {}),
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
      },
    ],
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Coupons (coupon.upsert.v1 — NEW grain; no Shopify peer)
// ═══════════════════════════════════════════════════════════════════════════════

export interface WooCouponShape {
  id: number | string;
  code?: string | null;
  amount?: string | number | null; // fixed money OR a percentage (when discount_type='percent')
  discount_type?: string | null; // percent | fixed_cart | fixed_product
  description?: string | null;
  date_created_gmt?: string | null;
  date_modified_gmt?: string | null;
  date_expires_gmt?: string | null;
  usage_count?: number | null;
  usage_limit?: number | null;
  [key: string]: unknown;
}

export interface WooCouponUpsertProperties {
  source: 'woocommerce';
  woocommerce_coupon_id: string;
  coupon_id: string;
  code: string | null;
  discount_type: string | null;
  /** Fixed-discount amount in MINOR units (currency-aware). NULL for percentage coupons. */
  amount_minor: string | null;
  /** Percentage value (e.g. "10" = 10%) when discount_type='percent'. NULL for fixed coupons.
   *  A percentage is NOT money — it is never scaled to minor units (avoids the x100 corruption). */
  amount_percent: string | null;
  /** Currency for amount_minor — NULL for percentage coupons (a percentage has no currency). */
  currency_code: string | null;
  usage_count: number | null;
  usage_limit: number | null;
  expires_at: string | null;
}

const PERCENT_DISCOUNT_TYPES = new Set(['percent', 'percentage']);

/**
 * Map a raw WooCommerce coupon → coupon.upsert.v1 (NEW canonical grain). Identity is the coupon id;
 * date_modified folded into the dedup identity for per-state restatement.
 *
 * MONEY DISCIPLINE: for a PERCENT coupon the `amount` is a percentage (e.g. "10" = 10%), NOT money —
 * it is carried verbatim on `amount_percent` and NEVER scaled (scaling it would be a 100× corruption).
 * For a FIXED coupon (fixed_cart / fixed_product) the `amount` is money → minor units, currency-aware.
 *
 * @param currencyCode  store currency — the sibling for a FIXED coupon's amount_minor.
 */
export function mapWooCouponToDraft(
  coupon: WooCouponShape,
  brandId: string,
  currencyCode: string,
): MappedResourceRecord {
  const couponId = String(coupon.id);
  const occurredAt = new Date(
    toUtcIso(coupon.date_modified_gmt ?? coupon.date_created_gmt, new Date(0).toISOString()),
  );
  const currency = (currencyCode ?? '').trim().toUpperCase() || null;
  const discountType = str(coupon.discount_type);
  const isPercent = discountType != null && PERCENT_DISCOUNT_TYPES.has(discountType.toLowerCase());

  let amountMinor: string | null = null;
  let amountPercent: string | null = null;
  let couponCurrency: string | null = null;
  if (coupon.amount != null) {
    if (isPercent) {
      amountPercent = str(coupon.amount);
    } else if (currency) {
      amountMinor = tryDecimalToMinor(coupon.amount, currency)?.toString() ?? null;
      couponCurrency = amountMinor != null ? currency : null;
    }
  }

  const properties: WooCouponUpsertProperties = {
    source: 'woocommerce',
    woocommerce_coupon_id: couponId,
    coupon_id: couponId,
    code: str(coupon.code),
    discount_type: discountType,
    amount_minor: amountMinor,
    amount_percent: amountPercent,
    currency_code: couponCurrency,
    usage_count: num(coupon.usage_count),
    usage_limit: num(coupon.usage_limit),
    expires_at: coupon.date_expires_gmt
      ? toUtcIso(coupon.date_expires_gmt, occurredAt.toISOString())
      : null,
  };

  const stateMs = occurredAt.getTime();
  return {
    providerId: `${couponId}:${stateMs}`,
    occurredAt,
    events: [
      {
        event_name: COUPON_UPSERT_V1_EVENT_NAME,
        occurred_at: occurredAt.toISOString(),
        properties: properties as unknown as Record<string, unknown>,
        provenance: provenance(brandId),
      },
    ],
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Refunds (refund.recorded.v1 — Shopify-parity; standalone first-class grain)
// ═══════════════════════════════════════════════════════════════════════════════

export interface WooRefundShape {
  id?: number | string | null;
  order_id?: number | string | null;
  reason?: string | null;
  amount?: string | number | null; // POSITIVE refund amount (wc/v3 /orders/<id>/refunds)
  total?: string | number | null; // NEGATIVE total when read from the order payload (e.g. "-500.00")
  currency?: string | null;
  date_created_gmt?: string | null;
  date_created?: string | null;
  [key: string]: unknown;
}

export interface WooRefundRecordedProperties {
  source: 'woocommerce';
  woocommerce_refund_id: string;
  refund_id: string;
  order_id: string | null;
  amount_minor: string; // settled refund total, ABS minor units (I-S07)
  currency_code: string | null;
  reason: string | null;
}

/** Absolute refund amount in minor units — `amount` (positive) preferred, else abs(`total`). */
function refundAbsMinor(refund: WooRefundShape, currencyCode: string): bigint {
  const raw = refund.amount ?? refund.total ?? null;
  const signed = tryDecimalToMinor(raw, currencyCode) ?? 0n;
  return signed < 0n ? -signed : signed;
}

/**
 * Map a raw WooCommerce refund → refund.recorded.v1 (Shopify-parity shape; source:'woocommerce').
 * A Woo refund id is globally unique → plain provider_id dedup (one refund → one event). The
 * standalone `order.refunded` webhook and the /orders/<id>/refunds backfill both reach this mapper.
 *
 * @param orderId       parent order id (Woo refunds are scoped under an order — supplied by caller)
 * @param currencyCode  store/order currency — drives amount scaling + the currency_code sibling.
 */
export function mapWooRefundToDraft(
  refund: WooRefundShape,
  brandId: string,
  orderId: string | null,
  currencyCode: string,
): MappedResourceRecord {
  const refundId = String(refund.id ?? '').trim();
  if (!refundId) {
    throw new Error('[woocommerce-mapper] refund missing id');
  }
  const currency = (currencyCode ?? '').trim().toUpperCase() || null;
  const occurredAt = new Date(
    toUtcIso(refund.date_created_gmt ?? refund.date_created, new Date(0).toISOString()),
  );

  const properties: WooRefundRecordedProperties = {
    source: 'woocommerce',
    woocommerce_refund_id: refundId,
    refund_id: refundId,
    order_id: orderId != null ? String(orderId) : refund.order_id != null ? String(refund.order_id) : null,
    amount_minor: (currency ? refundAbsMinor(refund, currency) : 0n).toString(),
    currency_code: refund.currency?.toUpperCase() ?? currency,
    reason: str(refund.reason),
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

/**
 * Fan an order's nested `refunds[]` array into standalone refund.recorded.v1 drafts. Used by the
 * webhook strategy (order.updated / order.refunded carries the order with its refunds[]) and the
 * order-refunds backfill — so a refund becomes a FIRST-CLASS grain instead of being folded only into
 * the order payload. Order id + currency come from the order itself.
 */
export function mapWooOrderRefundsToDrafts(
  order: WooOrderShape,
  brandId: string,
): MappedResourceRecord[] {
  const orderId = String(order.id ?? '').trim();
  const currency = (order.currency ?? '').trim().toUpperCase();
  if (!currency) return [];
  return (order.refunds ?? [])
    .filter((r): r is WooRefund => r != null && r.id != null && String(r.id).trim() !== '')
    .map((r) =>
      mapWooRefundToDraft(
        { id: r.id, total: r.total, reason: r.reason, date_created: r.date_created },
        brandId,
        orderId || null,
        currency,
      ),
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Orders — framework-record adapter over the FROZEN mapWooOrderToEvent
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Adapt the FROZEN `mapWooOrderToEvent` into the framework's `MappedResourceRecord` so WooCommerce
 * orders flow through the generic resumable backfill driver. The dedup identity folds date_modified
 * (the order's occurred_at ms) into the providerId so each order STATE is a distinct Bronze row —
 * byte-for-byte equivalent to the live lane's uuidV5FromOrderLive(brand, order, updatedAtMs) under
 * the manifest's provider_id+kind strategy.
 */
export function mapWooOrderToDraft(
  order: WooOrderShape,
  brandId: string,
  saltHex: string,
  regionCode: string,
  dataSource: DataSource = 'real',
): MappedResourceRecord {
  const mapped = mapWooOrderToEvent(order, brandId, saltHex, regionCode, dataSource);
  const orderId = String(order.id ?? '').trim();
  const occurredAt = new Date(mapped.occurred_at);
  const stateMs = occurredAt.getTime();

  return {
    providerId: `${orderId}:${stateMs}`,
    occurredAt,
    events: [
      {
        event_name: mapped.event_name,
        occurred_at: mapped.occurred_at,
        properties: mapped.properties as unknown as Record<string, unknown>,
        provenance: provenance(brandId),
      },
    ],
  };
}
