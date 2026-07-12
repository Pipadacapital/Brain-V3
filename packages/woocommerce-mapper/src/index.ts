/**
 * @brain/woocommerce-mapper — maps a WooCommerce REST order into the SHARED canonical
 * `order.live.v1` event (the SAME contract @brain/shopify-mapper produces).
 *
 * FROZEN API — do not change after commit without Architect sign-off.
 *
 * WHY order.live.v1 (the ~90% reuse — SPEC 2): WooCommerce is a storefront-category source.
 * By emitting the IDENTICAL canonical order event Shopify emits, WooCommerce orders flow through
 * the EXISTING downstream with ZERO new code — LiveOrderConsumer → realized_revenue_ledger
 * (provisional_recognition / rto_reversal / refund) → silver_order_state, plus the order-depth
 * line-item path. The only WooCommerce-authored code is this mapper + the source adapter.
 *
 * The consumer (apps/stream-worker LiveOrderConsumer) requires from properties:
 *   order_id (string), amount_minor (digits-only string, I-S07), currency_code, payment_method
 *   ('cod'|'prepaid'), cancelled_at (iso|null → drives rto_reversal), and occurred_at on the
 *   envelope; optional refunds[] (each {refund_id, processed_at, amount_minor} → one refund row).
 *
 * Binding decisions (mirror @brain/shopify-mapper):
 *   MONEY        — decimal price strings → BIGINT minor units (I-S07). Integer arithmetic only.
 *   PII-BOUNDARY — billing email/phone hashed via @brain/identity-core; raw DROPPED at this scope.
 *   uuidV5       — uuidV5FromOrderLive(brand, order, updatedAtMs) — IDENTICAL algorithm + namespace
 *                  to shopify-mapper so the Bronze dedup key is consistent across storefront sources.
 *   DEV-HONESTY  — data_source provenance ('real'|'synthetic') stamped for the UI badge.
 *
 * brandId is ALWAYS passed by the caller (from the connector row — MT-1), NEVER from the payload.
 */

import { hashToUuidShaped, type IdentityFieldsOptions } from '@brain/connector-core';
import { hashIdentifier, normalizePhone } from '@brain/identity-core';
// SPEC: A.1.4 — WA-09 interop-space dual-write (AMD-01): plain-sha256 of the SAME normalized
// values, so pixel identify hashes become joinable with connector identities.
import { emailInteropHash, phoneInteropHash } from '@brain/identity-normalization';
import { minorUnitDigits } from '@brain/money';

// ── Canonical event name (MUST equal shopify-mapper's — the shared contract) ──
// Defined in the leaf ./event-names.ts to stay out of the index <-> manifest <->
// resources import cycle (ESM TDZ). Imported for local use AND re-exported unchanged.
import { ORDER_LIVE_V1_EVENT_NAME } from './event-names.js';
export { ORDER_LIVE_V1_EVENT_NAME };

export type DataSource = 'real' | 'synthetic';

// ── Raw WooCommerce REST order shape (wc/v3 — only the fields we read) ─────────

export interface WooOrderLineItem {
  id?: number | string | null;
  name?: string | null;
  sku?: string | null;
  quantity?: number | null;
  price?: string | number | null;       // per-unit (decimal)
  subtotal?: string | null;             // pre-discount line subtotal (decimal)
  total?: string | null;                // post-discount line total (decimal)
  product_id?: number | string | null;
  variation_id?: number | string | null;
  [key: string]: unknown;
}

export interface WooTaxLine {
  label?: string | null;
  rate_percent?: number | null;
  tax_total?: string | null;            // decimal
  [key: string]: unknown;
}

export interface WooCouponLine {
  code?: string | null;
  discount?: string | null;             // decimal
  discount_type?: string | null;
  [key: string]: unknown;
}

export interface WooRefund {
  id?: number | string | null;
  reason?: string | null;
  total?: string | null;                // NEGATIVE decimal string in Woo (e.g. "-500.00")
  date_created?: string | null;         // ISO (gmt variant preferred by caller)
  [key: string]: unknown;
}

export interface WooBilling {
  email?: string | null;
  phone?: string | null;
  [key: string]: unknown;
}

export interface WooOrderShape {
  id: number | string;
  status?: string | null;               // pending|processing|on-hold|completed|cancelled|refunded|failed
  currency?: string | null;
  total?: string | null;                // order grand total (decimal)
  total_tax?: string | null;
  shipping_total?: string | null;
  discount_total?: string | null;
  date_created_gmt?: string | null;
  date_modified_gmt?: string | null;
  date_paid_gmt?: string | null;
  payment_method?: string | null;       // e.g. 'cod', 'razorpay', 'stripe'
  payment_method_title?: string | null;
  transaction_id?: string | null;
  customer_id?: number | string | null;
  billing?: WooBilling | null;
  line_items?: WooOrderLineItem[] | null;
  tax_lines?: WooTaxLine[] | null;
  coupon_lines?: WooCouponLine[] | null;
  refunds?: WooRefund[] | null;
  [key: string]: unknown;
}

// ── Output canonical shapes (mirror shopify-mapper OrderProperties) ────────────

export interface OrderLineItem {
  sku: string | null;
  title: string | null;
  quantity: number;
  unit_price_minor: string;
  line_total_minor: string;
  line_discount_minor: string;
  product_id: string | null;
  variant_id: string | null;
}

export interface OrderTaxLine {
  title: string | null;
  rate: number | null;
  amount_minor: string;
}

export interface OrderDiscountCode {
  code: string | null;
  amount_minor: string;
  type: string | null;
}

export interface OrderRefund {
  refund_id: string | null;
  processed_at: string | null;
  amount_minor: string;
  reason: string | null;
}

export interface OrderProperties {
  source: 'woocommerce';
  woocommerce_order_id: string;
  order_id: string;
  amount_minor: string;                 // BIGINT-as-string (I-S07)
  currency_code: string;
  payment_method: 'cod' | 'prepaid';
  data_source: DataSource;
  financial_status?: string;
  fulfillment_status?: string | null;
  cancelled_at?: string | null;
  hashed_customer_email?: string;
  hashed_customer_phone?: string;
  storefront_customer_id?: string;
  // ── SPEC: A.1.4 (WA-09, AMD-01 dual-write) — INTEROP-space plain-sha256 identifiers,
  // emitted ONLY when the caller passes emitInteropIdentifiers (flag connector.identity_fields).
  // Salted fields above are unchanged; platform_customer_id = storefront_customer_id (AMD-02).
  email_sha256?: string;
  phone_sha256?: string;
  line_items?: OrderLineItem[];
  tax_total_minor?: string;
  tax_lines?: OrderTaxLine[];
  shipping_total_minor?: string;
  discount_total_minor?: string;
  discount_codes?: OrderDiscountCode[];
  refunds?: OrderRefund[];
  refund_total_minor?: string;
}

export interface MappedOrderEvent {
  event_name: typeof ORDER_LIVE_V1_EVENT_NAME;
  occurred_at: string;
  properties: OrderProperties;
}

// ── Money helpers (I-S07 — integer arithmetic only; CURRENCY-AWARE via @brain/money) ────
//
// MONEY FIX (HIGH, was index.ts:170-182): the prior helper HARDCODED 2-decimal scaling (×100,
// slice(0,2)) on EVERY amount — under-scaling 3dp currencies (KWD/BHD/OMR) by 10× and over-scaling
// 0dp currencies (JPY/KRW) by 100×. Every money conversion is now keyed on the order/store currency
// via @brain/money's per-currency exponent (minorUnitDigits) — the single source of truth for the
// ISO-4217 minor-unit table. No hardcoded x100; no INR default (see mapWooOrderToEvent).

/**
 * Strict: decimal string → BIGINT minor units, scaled by the currency's exponent (0/2/3/4 dp).
 * Integer arithmetic only — no parseFloat (I-S07). Throws on an invalid value OR on more fractional
 * digits than the currency supports (e.g. "10.50" for JPY) — we never silently round money.
 *
 * @param value         decimal money string (e.g. "1250.00", "999", "15.5", "-500.000")
 * @param currencyCode  ISO-4217 code driving the exponent (e.g. 'INR'→2, 'JPY'→0, 'KWD'→3)
 */
export function decimalStringToMinor(value: string, currencyCode: string): bigint {
  const s = String(value).trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) {
    throw new Error(`[woocommerce-mapper] invalid money string: ${value}`);
  }
  const digits = minorUnitDigits(currencyCode);
  const neg = s.startsWith('-');
  const unsigned = neg ? s.slice(1) : s;
  const [wholeRaw, fracRaw = ''] = unsigned.split('.');
  if (fracRaw.length > digits) {
    throw new Error(
      `[woocommerce-mapper] money "${value}" has ${fracRaw.length} decimals but ${currencyCode.toUpperCase()} ` +
        `supports ${digits} (refusing to silently round money)`,
    );
  }
  const whole = wholeRaw || '0';
  const scale = 10n ** BigInt(digits);
  const fracMinor = digits > 0 ? BigInt((fracRaw + '0'.repeat(digits)).slice(0, digits)) : 0n;
  const minor = BigInt(whole) * scale + fracMinor;
  return neg ? -minor : minor;
}

/**
 * Parse a WooCommerce date to a UTC ISO string. The wc/v3 `*_gmt` fields are GMT but frequently
 * lack a timezone suffix; `new Date('2026-06-11T09:30:00')` would be interpreted as LOCAL time, so
 * we append 'Z' when no offset is present (treat the gmt value as UTC).
 */
function toUtcIso(value: string | null | undefined, fallbackIso: string): string {
  const raw = (value ?? '').trim() || fallbackIso;
  const hasTz = /[zZ]$/.test(raw) || /[+-]\d{2}:?\d{2}$/.test(raw);
  return new Date(hasTz ? raw : `${raw}Z`).toISOString();
}

/**
 * Resilient variant — returns null instead of throwing for OPTIONAL depth fields (one bad price ≠
 * a failed order). Still currency-aware: scaling is keyed on `currencyCode`.
 */
export function tryDecimalToMinor(
  value: string | number | null | undefined,
  currencyCode: string,
): bigint | null {
  if (value === null || value === undefined) return null;
  try {
    return decimalStringToMinor(String(value), currencyCode);
  } catch {
    return null;
  }
}

// ── UUID v5 — shared kernel util (@brain/connector-core). IDENTICAL byte layout +
//    namespace to shopify-mapper so storefront sources share one Bronze dedup namespace (I-ST04).

/**
 * Deterministic event_id for a LIVE order — SAME seed shape as shopify-mapper's
 * uuidV5FromOrderLive so storefront sources share one Bronze dedup namespace.
 * Seed: sha256(`${brandId}:${orderId}:${updatedAtUtcMs}:order.live.v1`)
 */
export function uuidV5FromOrderLive(
  brandId: string,
  orderId: string,
  updatedAtUtcMs: number,
): string {
  return hashToUuidShaped(`${brandId}:${orderId}:${updatedAtUtcMs}:order.live.v1`);
}

// ── Payment-method classification (Woo) ───────────────────────────────────────

const COD_METHODS = new Set(['cod', 'cash_on_delivery', 'cheque']);

function classifyPaymentMethod(order: WooOrderShape): 'cod' | 'prepaid' {
  const method = (order.payment_method ?? '').toLowerCase();
  const title = (order.payment_method_title ?? '').toLowerCase();
  if (COD_METHODS.has(method)) return 'cod';
  if (title.includes('cash on delivery') || title.includes('cod')) return 'cod';
  return 'prepaid';
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s.length === 0 ? null : s;
}

// ── Order mapper ──────────────────────────────────────────────────────────────

/**
 * Map a raw WooCommerce REST order to the canonical order.live.v1 event.
 *
 * @param order       Raw Woo order (wc/v3 shape)
 * @param brandId     Brand UUID (from connector row — MT-1, never from payload)
 * @param saltHex     Per-brand 64-char hex salt for PII hashing
 * @param regionCode  Region for phone normalization (e.g. 'IN')
 * @param dataSource  'real' shape; dev fixture source → 'synthetic' (DEV-HONESTY)
 * @param identityFields SPEC: A.1.4 (WA-09) — optional dual-write knob; ABSENT = byte-identical
 *                       pre-Wave-A output (flag connector.identity_fields OFF).
 */
export function mapWooOrderToEvent(
  order: WooOrderShape,
  brandId: string,
  saltHex: string,
  regionCode: string,
  dataSource: DataSource = 'real',
  identityFields?: IdentityFieldsOptions,
): MappedOrderEvent {
  const orderId = String(order.id ?? '').trim();
  if (!orderId) {
    throw new Error('[woocommerce-mapper] order missing id');
  }

  // MONEY FIX: read the order's own currency — NO INR default (the prior code blended every
  // currency-less order into INR). Fail closed: a money amount without a currency is unsafe to scale.
  const currencyCode = (order.currency ?? '').trim().toUpperCase();
  if (!currencyCode) {
    throw new Error(`[woocommerce-mapper] order ${orderId} missing currency (refusing to default to INR)`);
  }

  const totalRaw = order.total ?? '0';
  const amountMinor = decimalStringToMinor(String(totalRaw), currencyCode);
  if (amountMinor < 0n) {
    throw new Error(`[woocommerce-mapper] negative order total for order ${orderId}`);
  }

  const occurredAt = toUtcIso(
    order.date_modified_gmt ?? order.date_created_gmt,
    new Date().toISOString(),
  );

  const status = (order.status ?? '').toLowerCase();
  // Woo has no separate cancelled timestamp; a 'cancelled' status at occurred_at drives the
  // canonical rto_reversal in LiveOrderConsumer (cancelled_at non-null → negative reversal).
  const cancelledAt = status === 'cancelled' ? occurredAt : null;

  // ── PII boundary: hash billing email/phone; raw DROPPED here ──
  let hashedEmail: string | undefined;
  let hashedPhone: string | undefined;
  // SPEC: A.1.4 — INTEROP-space dual-write (AMD-01), flag-gated by the caller. undefined when OFF.
  let emailSha256: string | undefined;
  let phoneSha256: string | undefined;
  const billing = order.billing;
  if (billing) {
    if (billing.email) {
      hashedEmail = hashIdentifier(billing.email, 'email', saltHex, regionCode);
      if (identityFields?.emitInteropIdentifiers === true) {
        emailSha256 = emailInteropHash(billing.email) ?? undefined;
      }
    }
    if (billing.phone) {
      const { normalized } = normalizePhone(billing.phone, regionCode);
      hashedPhone = hashIdentifier(normalized, 'phone', saltHex, regionCode);
      if (identityFields?.emitInteropIdentifiers === true) {
        phoneSha256 = phoneInteropHash(billing.phone, regionCode) ?? undefined;
      }
    }
  }
  const storefrontCustomerId =
    order.customer_id != null && String(order.customer_id) !== '0'
      ? String(order.customer_id)
      : undefined;

  // ── Line items (optional depth — resilient money) ──
  const lineItems: OrderLineItem[] = (order.line_items ?? []).map((li) => {
    const qty = typeof li.quantity === 'number' ? li.quantity : Number(li.quantity ?? 0);
    const lineTotal = tryDecimalToMinor(li.total ?? null, currencyCode) ?? 0n;
    const lineSubtotal = tryDecimalToMinor(li.subtotal ?? null, currencyCode);
    const lineDiscount = lineSubtotal !== null ? lineSubtotal - lineTotal : 0n;
    const unitPrice = tryDecimalToMinor(li.price ?? null, currencyCode) ?? (qty > 0 ? lineTotal / BigInt(qty) : 0n);
    return {
      sku: str(li.sku),
      title: str(li.name),
      quantity: qty,
      unit_price_minor: unitPrice.toString(),
      line_total_minor: lineTotal.toString(),
      line_discount_minor: (lineDiscount < 0n ? 0n : lineDiscount).toString(),
      product_id: str(li.product_id),
      variant_id: str(li.variation_id),
    };
  });

  const taxLines: OrderTaxLine[] = (order.tax_lines ?? []).map((t) => ({
    title: str(t.label),
    rate: typeof t.rate_percent === 'number' ? t.rate_percent / 100 : null,
    amount_minor: (tryDecimalToMinor(t.tax_total ?? null, currencyCode) ?? 0n).toString(),
  }));

  const discountCodes: OrderDiscountCode[] = (order.coupon_lines ?? []).map((c) => ({
    code: str(c.code),
    amount_minor: (tryDecimalToMinor(c.discount ?? null, currencyCode) ?? 0n).toString(),
    type: str(c.discount_type),
  }));

  // ── Refunds: Woo refund.total is NEGATIVE → store ABS minor, one row per refund_id ──
  let refundTotal = 0n;
  const refunds: OrderRefund[] = (order.refunds ?? []).map((r) => {
    const signed = tryDecimalToMinor(r.total ?? null, currencyCode) ?? 0n;
    const abs = signed < 0n ? -signed : signed;
    refundTotal += abs;
    return {
      refund_id: str(r.id),
      processed_at: r.date_created ? toUtcIso(r.date_created, occurredAt) : null,
      amount_minor: abs.toString(),
      reason: str(r.reason),
    };
  });

  const properties: OrderProperties = {
    source: 'woocommerce',
    woocommerce_order_id: orderId,
    order_id: orderId,
    amount_minor: amountMinor.toString(),
    currency_code: currencyCode,
    payment_method: classifyPaymentMethod(order),
    data_source: dataSource,
    financial_status: status || undefined,
    fulfillment_status: status || null,
    cancelled_at: cancelledAt,
    ...(hashedEmail ? { hashed_customer_email: hashedEmail } : {}),
    ...(hashedPhone ? { hashed_customer_phone: hashedPhone } : {}),
    ...(storefrontCustomerId ? { storefront_customer_id: storefrontCustomerId } : {}),
    // SPEC: A.1.4 — interop dual-write (present ONLY when connector.identity_fields is ON).
    ...(emailSha256 ? { email_sha256: emailSha256 } : {}),
    ...(phoneSha256 ? { phone_sha256: phoneSha256 } : {}),
    ...(lineItems.length ? { line_items: lineItems } : {}),
    ...(order.total_tax ? { tax_total_minor: (tryDecimalToMinor(order.total_tax, currencyCode) ?? 0n).toString() } : {}),
    ...(taxLines.length ? { tax_lines: taxLines } : {}),
    ...(order.shipping_total ? { shipping_total_minor: (tryDecimalToMinor(order.shipping_total, currencyCode) ?? 0n).toString() } : {}),
    ...(order.discount_total ? { discount_total_minor: (tryDecimalToMinor(order.discount_total, currencyCode) ?? 0n).toString() } : {}),
    ...(discountCodes.length ? { discount_codes: discountCodes } : {}),
    ...(refunds.length ? { refunds, refund_total_minor: refundTotal.toString() } : {}),
  };

  return {
    event_name: ORDER_LIVE_V1_EVENT_NAME,
    occurred_at: occurredAt,
    properties,
  };
}

// ── ADDITIVE (ingestion-framework onboarding) ─────────────────────────────────
// The WooCommerce IngestionManifest + the framework-record mappers (orders adapter + products) for
// the resumable backfill driver. Purely additive — the FROZEN order mapper above is unchanged.

export {
  WOOCOMMERCE_PROVIDER,
  WOOCOMMERCE_MANIFEST,
  WOOCOMMERCE_ORDERS_RESOURCE,
  WOOCOMMERCE_PRODUCTS_RESOURCE,
  WOOCOMMERCE_CUSTOMERS_RESOURCE,
  WOOCOMMERCE_COUPONS_RESOURCE,
  WOOCOMMERCE_REFUNDS_RESOURCE,
  // Historical-depth policy cap (WOOCOMMERCE_MAX_HISTORY_YEARS env-overridable, default 5y):
  WOOCOMMERCE_DEFAULT_MAX_HISTORY_YEARS,
  WOOCOMMERCE_MAX_BACKFILL_WINDOW_MS,
  resolveWooMaxHistoryYears,
  wooMaxBackfillWindowMs,
} from './manifest.js';

export {
  PRODUCT_UPSERT_V1_EVENT_NAME,
  CUSTOMER_UPSERT_V1_EVENT_NAME,
  COUPON_UPSERT_V1_EVENT_NAME,
  REFUND_RECORDED_V1_EVENT_NAME,
  mapWooProductToDraft,
  mapWooOrderToDraft,
  mapWooCustomerToDraft,
  mapWooCouponToDraft,
  mapWooRefundToDraft,
  mapWooOrderRefundsToDrafts,
} from './resources.js';

export type {
  MappedResourceRecord,
  WooProductShape,
  WooProductVariation,
  WooProductUpsertProperties,
  WooCustomerShape,
  WooCustomerUpsertProperties,
  WooCouponShape,
  WooCouponUpsertProperties,
  WooRefundShape,
  WooRefundRecordedProperties,
} from './resources.js';
