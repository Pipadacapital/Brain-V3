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

import { createHash } from 'node:crypto';
import { hashIdentifier, normalizePhone } from '@brain/identity-core';

// ── Canonical event name (MUST equal shopify-mapper's — the shared contract) ──
export const ORDER_LIVE_V1_EVENT_NAME = 'order.live.v1' as const;

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

// ── Money helpers (I-S07 — integer arithmetic only; mirror shopify-mapper) ────

/** Strict: decimal string → BIGINT minor units (≤2 dp). Throws on invalid (core amount path). */
export function decimalStringToMinor(value: string): bigint {
  const s = value.trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) {
    throw new Error(`[woocommerce-mapper] invalid money string: ${value}`);
  }
  const neg = s.startsWith('-');
  const parts = (neg ? s.slice(1) : s).split('.');
  const whole = parts[0] ?? '0';
  const frac = parts[1] ?? '';
  const fracPadded = (frac + '00').slice(0, 2);
  const minor = BigInt(whole) * 100n + BigInt(fracPadded);
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

/** Resilient: returns null instead of throwing — for OPTIONAL depth fields (one bad price ≠ failed order). */
export function tryDecimalToMinor(value: string | number | null | undefined): bigint | null {
  if (value === null || value === undefined) return null;
  try {
    return decimalStringToMinor(String(value));
  } catch {
    return null;
  }
}

// ── UUID v5 (IDENTICAL algorithm + namespace to shopify-mapper — I-ST04) ──────

function hashToUuidShaped(input: string): string {
  const hash = createHash('sha256').update(input, 'utf8').digest();
  const bytes = Buffer.alloc(16);
  hash.copy(bytes, 0, 0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32),
  ].join('-');
}

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
 */
export function mapWooOrderToEvent(
  order: WooOrderShape,
  brandId: string,
  saltHex: string,
  regionCode: string,
  dataSource: DataSource = 'real',
): MappedOrderEvent {
  const orderId = String(order.id ?? '').trim();
  if (!orderId) {
    throw new Error('[woocommerce-mapper] order missing id');
  }

  const totalRaw = order.total ?? '0';
  const amountMinor = decimalStringToMinor(String(totalRaw));
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
  const billing = order.billing;
  if (billing) {
    if (billing.email) {
      hashedEmail = hashIdentifier(billing.email, 'email', saltHex, regionCode);
    }
    if (billing.phone) {
      const { normalized } = normalizePhone(billing.phone, regionCode);
      hashedPhone = hashIdentifier(normalized, 'phone', saltHex, regionCode);
    }
  }
  const storefrontCustomerId =
    order.customer_id != null && String(order.customer_id) !== '0'
      ? String(order.customer_id)
      : undefined;

  // ── Line items (optional depth — resilient money) ──
  const lineItems: OrderLineItem[] = (order.line_items ?? []).map((li) => {
    const qty = typeof li.quantity === 'number' ? li.quantity : Number(li.quantity ?? 0);
    const lineTotal = tryDecimalToMinor(li.total ?? null) ?? 0n;
    const lineSubtotal = tryDecimalToMinor(li.subtotal ?? null);
    const lineDiscount = lineSubtotal !== null ? lineSubtotal - lineTotal : 0n;
    const unitPrice = tryDecimalToMinor(li.price ?? null) ?? (qty > 0 ? lineTotal / BigInt(qty) : 0n);
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
    amount_minor: (tryDecimalToMinor(t.tax_total ?? null) ?? 0n).toString(),
  }));

  const discountCodes: OrderDiscountCode[] = (order.coupon_lines ?? []).map((c) => ({
    code: str(c.code),
    amount_minor: (tryDecimalToMinor(c.discount ?? null) ?? 0n).toString(),
    type: str(c.discount_type),
  }));

  // ── Refunds: Woo refund.total is NEGATIVE → store ABS minor, one row per refund_id ──
  let refundTotal = 0n;
  const refunds: OrderRefund[] = (order.refunds ?? []).map((r) => {
    const signed = tryDecimalToMinor(r.total ?? null) ?? 0n;
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
    currency_code: (order.currency ?? 'INR').toUpperCase(),
    payment_method: classifyPaymentMethod(order),
    data_source: dataSource,
    financial_status: status || undefined,
    fulfillment_status: status || null,
    cancelled_at: cancelledAt,
    ...(hashedEmail ? { hashed_customer_email: hashedEmail } : {}),
    ...(hashedPhone ? { hashed_customer_phone: hashedPhone } : {}),
    ...(storefrontCustomerId ? { storefront_customer_id: storefrontCustomerId } : {}),
    ...(lineItems.length ? { line_items: lineItems } : {}),
    ...(order.total_tax ? { tax_total_minor: (tryDecimalToMinor(order.total_tax) ?? 0n).toString() } : {}),
    ...(taxLines.length ? { tax_lines: taxLines } : {}),
    ...(order.shipping_total ? { shipping_total_minor: (tryDecimalToMinor(order.shipping_total) ?? 0n).toString() } : {}),
    ...(order.discount_total ? { discount_total_minor: (tryDecimalToMinor(order.discount_total) ?? 0n).toString() } : {}),
    ...(discountCodes.length ? { discount_codes: discountCodes } : {}),
    ...(refunds.length ? { refunds, refund_total_minor: refundTotal.toString() } : {}),
  };

  return {
    event_name: ORDER_LIVE_V1_EVENT_NAME,
    occurred_at: occurredAt,
    properties,
  };
}
