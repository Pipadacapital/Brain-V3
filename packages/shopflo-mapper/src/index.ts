/**
 * @brain/shopflo-mapper — Frozen shared mapper for the Shopflo checkout_abandoned webhook.
 *
 * FROZEN API — do not change after commit without Architect sign-off.
 *
 * Binding decisions implemented here (05-architecture.md §2):
 *   PII-BOUNDARY  — email + phone are hashed with the per-brand salt BEFORE leaving this
 *                   layer: sha256(per-brand-salt || normalized). Raw values exist ONLY in-memory
 *                   in this call frame; NEVER persisted, NEVER logged (I-S02).
 *   ALLOWLIST     — only the documented checkout_abandoned funnel + discount + financial-summary
 *                   fields cross the boundary. Any other field (PG metadata, raw addresses) is DROPPED.
 *   MINOR-UNITS   — every money field → BIGINT-as-string minor units (×100), with currency_code (I-S07).
 *                   Shopflo sends decimal/number money (e.g. total_price=65, total_tax=9.92).
 *   uuidV5        — deterministic event_id = uuidV5(brand:checkout_id:occurred_at:shopflo.checkout_abandoned.v1).
 *                   Stable per (checkout, occurred_at) → replay-safe Bronze dedup.
 *   DEV-HONESTY   — data_source is stamped into the properties ('real' | 'synthetic') so the
 *                   BFF can surface the honest "Synthetic (dev)" badge. checkout_abandoned is REAL.
 *
 * Brand is NEVER read from the payload — the caller passes brandId resolved server-side from
 * the connector row (resolve_shopflo_connector_by_merchant — MT-1).
 */

import { createHash } from 'node:crypto';
import { hashIdentifier, normalizePhone } from '@brain/identity-core';

// ── Event name constant ──────────────────────────────────────────────────────

export const SHOPFLO_CHECKOUT_ABANDONED_V1_EVENT_NAME = 'shopflo.checkout_abandoned.v1' as const;

// ── data_source provenance (DEV-HONESTY — §4) ────────────────────────────────

export type DataSource = 'real' | 'synthetic';

// ── Raw Shopflo checkout_abandoned webhook payload (documented fields — research finding 8) ──

export interface ShopfloLineItem {
  id?: string | number | null;
  title?: string | null;
  quantity?: number | string | null;
  price?: number | string | null;   // decimal/number — per-unit price
  [key: string]: unknown;
}

export interface ShopfloAddress {
  [key: string]: unknown;
}

export interface ShopfloCustomer {
  uid?: string | null;
  email?: string | null;            // raw PII — hashed at boundary, DROPPED after
  phone?: string | null;            // raw PII — hashed at boundary, DROPPED after
  marketing_consent?: boolean | null;
  [key: string]: unknown;
}

export interface ShopfloCheckoutAbandonedPayload {
  event_name?: string | null;       // 'checkout_abandoned'
  checkout_id?: string | null;
  cart_token?: string | null;
  customer?: ShopfloCustomer | null;
  email?: string | null;            // top-level fallback (addressless checkouts may have email:null)
  phone?: string | null;
  marketing_consent?: boolean | null;
  shipping_address?: ShopfloAddress | null;
  billing_address?: ShopfloAddress | null;
  line_items?: ShopfloLineItem[] | null;
  // financial summary (decimal/number money)
  subtotal_price?: number | string | null;
  total_discount?: number | string | null;
  total_shipping?: number | string | null;
  total_tax?: number | string | null;
  total_price?: number | string | null;
  currency?: string | null;
  created_at?: string | null;
  occurred_at?: string | null;
  [key: string]: unknown;
}

// ── Output Silver shape (checkout-conversion funnel) ─────────────────────────

export interface ShopfloMappedLineItem {
  id: string | null;
  title: string | null;
  quantity: number;
  price_minor: string;              // BIGINT-as-string minor units
}

export interface ShopfloCheckoutProperties {
  source: 'shopflo';
  data_source: DataSource;          // 'real' | 'synthetic' — DEV-HONESTY badge driver
  checkout_id: string;
  cart_token: string | null;
  customer_email_hash: string | null;   // sha256(salt || normalized email) — raw DROPPED
  customer_phone_hash: string | null;   // sha256(salt || normalized E.164) — raw DROPPED
  marketing_consent: boolean;
  has_address: boolean;             // addressless-checkout flag (research finding 8)
  line_items: ShopfloMappedLineItem[];
  subtotal_minor: string;           // BIGINT-as-string minor units (I-S07)
  total_discount_minor: string;
  total_shipping_minor: string;
  total_tax_minor: string;
  total_price_minor: string;
  currency_code: string;
  occurred_at: string;              // ISO-8601
}

export interface MappedShopfloCheckoutEvent {
  event_name: typeof SHOPFLO_CHECKOUT_ABANDONED_V1_EVENT_NAME;
  occurred_at: string;
  properties: ShopfloCheckoutProperties;
}

// ── UUID util (IDENTICAL algorithm to shopify-mapper/razorpay-mapper — I-ST04) ──

function hashToUuidShaped(input: string): string {
  const hash = createHash('sha256').update(input, 'utf8').digest();
  const bytes = Buffer.alloc(16);
  hash.copy(bytes, 0, 0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;   // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;   // RFC 4122 variant
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32),
  ].join('-');
}

/**
 * Deterministic event_id for a Shopflo checkout_abandoned event.
 * Seed: sha256(`${brandId}:${checkoutId}:${occurredAt}:shopflo.checkout_abandoned.v1`)
 *
 * Distinct namespace from order/settlement events. Stable per (checkout, occurred_at)
 * → a re-delivered webhook with the same checkout + time → same id → Bronze dedup.
 * (Also used as the Redis replay key by the webhook handler.)
 */
export function uuidV5FromShopfloCheckout(
  brandId: string,
  checkoutId: string,
  occurredAt: string,
): string {
  return hashToUuidShaped(`${brandId}:${checkoutId}:${occurredAt}:shopflo.checkout_abandoned.v1`);
}

// ── Money util — decimal/number → BIGINT-as-string minor units (I-S07, no parseFloat) ──

/**
 * Convert a Shopflo money value (number or decimal-string) to minor units as BIGINT-as-string.
 * Shopflo sends amounts as major-unit numbers/strings (e.g. 65, "65", 9.92).
 * Integer arithmetic only — NO parseFloat (I-S07): split on the decimal point.
 *
 * @throws if the value is not a non-negative decimal with ≤2 decimal places.
 */
export function moneyToMinorString(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return '0';
  // Number inputs: stringify without exponent. Shopflo money fits well inside Number safe range,
  // but we go through string parsing to avoid float rounding (I-S07).
  const str = (typeof value === 'number' ? value.toString() : String(value)).trim();
  if (str === '') return '0';

  if (!/^\d+(\.\d{1,2})?$/.test(str)) {
    throw new Error(
      `[shopflo-mapper] moneyToMinorString: invalid money value "${str}" — ` +
      `expected non-negative decimal with at most 2 decimal places (I-S07)`,
    );
  }

  const dotIdx = str.indexOf('.');
  if (dotIdx === -1) {
    return (BigInt(str) * 100n).toString();
  }
  const whole = str.slice(0, dotIdx);
  const frac = str.slice(dotIdx + 1).padEnd(2, '0');
  return (BigInt(whole) * 100n + BigInt(frac)).toString();
}

function toQuantity(value: number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === 'number' ? value : parseInt(String(value).trim(), 10);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function hasAddress(payload: ShopfloCheckoutAbandonedPayload): boolean {
  const ship = payload.shipping_address;
  const bill = payload.billing_address;
  const nonEmpty = (a: ShopfloAddress | null | undefined): boolean =>
    a != null && typeof a === 'object' && Object.keys(a).length > 0;
  return nonEmpty(ship) || nonEmpty(bill);
}

// ── Main mapper ──────────────────────────────────────────────────────────────

/**
 * Map a raw Shopflo checkout_abandoned payload to a canonical Silver event.
 *
 * Invariants:
 *   1. email + phone hashed at boundary; raw values DROPPED, never logged (I-S02).
 *   2. ONLY the funnel/discount/financial-summary fields pass — raw addresses are reduced to
 *      a boolean has_address flag; nothing else crosses.
 *   3. All money → BIGINT-as-string minor units + currency_code (I-S07).
 *   4. brandId comes from the connector row (MT-1) — never from the payload.
 *
 * @param payload     Raw Shopflo checkout_abandoned webhook payload
 * @param brandId     Brand UUID (from connector row — NEVER from payload)
 * @param saltHex     Per-brand 64-char hex salt for PII hashing
 * @param regionCode  Brand region code (default 'IN' — phone normalization)
 * @param dataSource  'real' for the live webhook; 'synthetic' for dev fixtures (DEV-HONESTY)
 */
export function mapShopfloCheckoutAbandoned(
  payload: ShopfloCheckoutAbandonedPayload,
  brandId: string,
  saltHex: string,
  regionCode = 'IN',
  dataSource: DataSource = 'real',
): MappedShopfloCheckoutEvent {
  const checkoutId = String(payload.checkout_id ?? payload.cart_token ?? '').trim();
  if (!checkoutId) {
    throw new Error('[shopflo-mapper] checkout_abandoned payload missing checkout_id / cart_token');
  }

  const occurredAt = new Date(
    payload.occurred_at ?? payload.created_at ?? new Date().toISOString(),
  ).toISOString();

  // ── PII hashing at boundary — raw email/phone DROPPED after this scope (I-S02) ──
  const customer = payload.customer ?? null;
  const rawEmail = customer?.email ?? payload.email ?? null;
  const rawPhone = customer?.phone ?? payload.phone ?? null;

  let emailHash: string | null = null;
  let phoneHash: string | null = null;
  if (rawEmail) {
    emailHash = hashIdentifier(rawEmail, 'email', saltHex, regionCode);
  }
  if (rawPhone) {
    const { normalized } = normalizePhone(rawPhone, regionCode);
    phoneHash = hashIdentifier(normalized, 'phone', saltHex, regionCode);
  }
  // rawEmail / rawPhone / customer object are dropped here — never leave this scope.

  const marketingConsent = Boolean(customer?.marketing_consent ?? payload.marketing_consent ?? false);

  const lineItems: ShopfloMappedLineItem[] = (payload.line_items ?? []).map((li) => ({
    id: li.id != null ? String(li.id) : null,
    title: li.title != null ? String(li.title) : null,
    quantity: toQuantity(li.quantity),
    price_minor: moneyToMinorString(li.price),
  }));

  const currencyCode = String(payload.currency ?? 'INR').trim().toUpperCase() || 'INR';

  const properties: ShopfloCheckoutProperties = {
    source: 'shopflo',
    data_source: dataSource,
    checkout_id: checkoutId,
    cart_token: payload.cart_token != null ? String(payload.cart_token) : null,
    customer_email_hash: emailHash,
    customer_phone_hash: phoneHash,
    marketing_consent: marketingConsent,
    has_address: hasAddress(payload),
    line_items: lineItems,
    subtotal_minor: moneyToMinorString(payload.subtotal_price),
    total_discount_minor: moneyToMinorString(payload.total_discount),
    total_shipping_minor: moneyToMinorString(payload.total_shipping),
    total_tax_minor: moneyToMinorString(payload.total_tax),
    total_price_minor: moneyToMinorString(payload.total_price),
    currency_code: currencyCode,
    occurred_at: occurredAt,
  };

  return {
    event_name: SHOPFLO_CHECKOUT_ABANDONED_V1_EVENT_NAME,
    occurred_at: occurredAt,
    properties,
  };
}
