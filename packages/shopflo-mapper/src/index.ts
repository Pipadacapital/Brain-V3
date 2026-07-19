/**
 * @brain/shopflo-mapper — shared mapper for Shopflo webhook-first commerce events.
 *
 * SLICE B (full reimplementation): Shopflo is now a full ORDER / PAYMENT / CHECKOUT-funnel source —
 * not the checkout-abandoned-only signal it used to be. Every webhook is discriminated on its Shopflo
 * event type and mapped to exactly ONE canonical Brain event that flows through silver_collector_event
 * into the EXISTING order / payment / checkout-signal marts (source-neutral lanes), so Shopflo order
 * revenue finally reaches Gold with ZERO silver_order_state change:
 *   mapShopfloOrder              — order.created/paid/failed/cancelled/refunded/fulfilled → order.live.v1
 *                                  (OrderProperties-shaped, source:'shopflo' → reuses @brain/shopify-mapper
 *                                   decimalStringToMinor / uuidV5FromOrderLive / ORDER_LIVE_V1_EVENT_NAME so
 *                                   Shopflo orders land in silver_order_state identically to Shopify orders).
 *   mapShopfloRefund             — a dedicated refund event → refund.recorded.v1.
 *   mapShopfloPayment            — payment.attempted → payment.attempted.v1; payment.authorized → payment.authorized.v1.
 *   mapShopfloCheckout(kind)     — 'abandoned' → checkout.abandoned.v1 (source-neutral convergence target);
 *                                  'started' → shopflo.checkout_started.v1; 'step' → shopflo.checkout_step.v1;
 *                                  'completed' → shopflo.checkout_completed.v1 (→ silver_checkout_signal).
 *   mapShopfloCheckoutAbandoned  — the original frozen abandoned mapper (→ shopflo.checkout_abandoned.v1).
 *                                  PRESERVED byte-for-byte (parity-locked vs silver_shopflo_normalize golden
 *                                  vectors); the live webhook lane still uses it for back-compat dedup stability.
 *
 * FROZEN parts — mapShopfloCheckoutAbandoned + its types + moneyToMinorString + uuidV5FromShopfloCheckout are
 * frozen (Architect sign-off to change). New mappers extend the SAME boundary contract.
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
import { hashToUuidShaped, type IdentityFieldsOptions } from '@brain/connector-core';
import { hashIdentifier, normalizePhone } from '@brain/identity-core';
// SPEC: A.1.4 — WA-09 interop-space dual-write (AMD-01): plain-sha256 of the SAME normalized
// values, so pixel identify hashes become joinable with connector identities.
import { emailInteropHash, phoneInteropHash } from '@brain/identity-normalization';
import {
  decimalStringToMinor,
  tryDecimalToMinor,
  uuidV5FromOrderLive,
  ORDER_LIVE_V1_EVENT_NAME,
  REFUND_RECORDED_V1_EVENT_NAME,
  type OrderLineItem,
  type OrderRefund,
} from '@brain/shopify-mapper';

// ── Event name constants ─────────────────────────────────────────────────────

export const SHOPFLO_CHECKOUT_ABANDONED_V1_EVENT_NAME = 'shopflo.checkout_abandoned.v1' as const;
/** Source-neutral abandoned-checkout signal (shared canon with the gokwik lane; carries source='shopflo'). */
export const CHECKOUT_ABANDONED_V1_EVENT_NAME = 'checkout.abandoned.v1' as const;
/** Shopflo checkout funnel — entered checkout. */
export const SHOPFLO_CHECKOUT_STARTED_V1_EVENT_NAME = 'shopflo.checkout_started.v1' as const;
/** Shopflo checkout funnel — completed a checkout step (address / payment-method / etc.). */
export const SHOPFLO_CHECKOUT_STEP_V1_EVENT_NAME = 'shopflo.checkout_step.v1' as const;
/** Shopflo checkout funnel — checkout completed (conversion marker; the order arrives via order.live.v1). */
export const SHOPFLO_CHECKOUT_COMPLETED_V1_EVENT_NAME = 'shopflo.checkout_completed.v1' as const;
/** Payment attempt (initiated or failed). */
export const PAYMENT_ATTEMPTED_V1_EVENT_NAME = 'payment.attempted.v1' as const;
/** Payment authorized (the gateway authorized the charge). */
export const PAYMENT_AUTHORIZED_V1_EVENT_NAME = 'payment.authorized.v1' as const;

// Re-export the canonical order/refund event names so consumers can reference them from the shopflo surface.
export { ORDER_LIVE_V1_EVENT_NAME, REFUND_RECORDED_V1_EVENT_NAME };

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
  // ── SPEC: A.1.4 (WA-09) — emitted ONLY when connector.identity_fields is ON:
  // AMD-02 name unification (the standard salted names alongside the frozen legacy ones above),
  // the AMD-01 interop plain-sha256 dual-write, and the checkout-session join key.
  hashed_customer_email?: string;
  hashed_customer_phone?: string;
  email_sha256?: string;
  phone_sha256?: string;
  checkout_session_id?: string;
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

// ── UUID util — shared kernel util (@brain/connector-core), IDENTICAL byte layout (I-ST04) ──

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
  identityFields?: IdentityFieldsOptions,
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
  // SPEC: A.1.4 — INTEROP-space dual-write (AMD-01), flag-gated by the caller. undefined when OFF.
  let emailSha256: string | undefined;
  let phoneSha256: string | undefined;
  if (rawEmail) {
    emailHash = hashIdentifier(rawEmail, 'email', saltHex, regionCode);
    if (identityFields?.emitInteropIdentifiers === true) {
      emailSha256 = emailInteropHash(rawEmail) ?? undefined;
    }
  }
  if (rawPhone) {
    const { normalized } = normalizePhone(rawPhone, regionCode);
    phoneHash = hashIdentifier(normalized, 'phone', saltHex, regionCode);
    if (identityFields?.emitInteropIdentifiers === true) {
      phoneSha256 = phoneInteropHash(rawPhone, regionCode) ?? undefined;
    }
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
    // SPEC: A.1.4 — flag-ON additions ONLY (AMD-02 standard-name unification + AMD-01 interop
    // dual-write + the checkout-session join key = this event's checkout_id).
    ...(identityFields?.emitInteropIdentifiers === true && emailHash !== null
      ? { hashed_customer_email: emailHash }
      : {}),
    ...(identityFields?.emitInteropIdentifiers === true && phoneHash !== null
      ? { hashed_customer_phone: phoneHash }
      : {}),
    ...(emailSha256 !== undefined ? { email_sha256: emailSha256 } : {}),
    ...(phoneSha256 !== undefined ? { phone_sha256: phoneSha256 } : {}),
    ...(identityFields?.emitInteropIdentifiers === true ? { checkout_session_id: checkoutId } : {}),
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

// ═══════════════════════════════════════════════════════════════════════════════
// SLICE B — full reimplementation: Order / Payment / Checkout-funnel mappers.
//
// Shopflo sends DECIMAL/number money in MAJOR units (e.g. total_price=65, "65", 9.92). All money goes
// through moneyToMinorString / firstMoney (integer arithmetic, no parseFloat — I-S07) → bigint minor
// units + a sibling currency_code. brandId / saltHex / regionCode are ALWAYS caller-supplied (server-
// derived from the connector row — MT-1), NEVER read from the payload. utm/referrer/discount/session are
// non-PII journey context (threaded directly). Raw email/phone/payment-id are hashed at THIS boundary.
// ═══════════════════════════════════════════════════════════════════════════════

// ── Field-probe helpers (Shopflo naming varies by webhook topic → probe candidate keys) ──────────────

/** First non-empty string/number across candidate keys → trimmed string (numbers stringified). */
function firstField(rec: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return null;
}

/** First present money-bearing value (number or numeric string) across candidate keys → minor string, else null. */
function firstMoneyMinor(rec: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const k of keys) {
    const v = rec[k];
    if (v === null || v === undefined || v === '') continue;
    if (typeof v === 'number' || typeof v === 'string') {
      try {
        return moneyToMinorString(v);
      } catch {
        return null;
      }
    }
  }
  return null;
}

const ORDER_ID_KEYS = ['order_id', 'shopflo_order_id', 'merchant_order_id', 'id', 'reference', 'order_number'] as const;
const CHECKOUT_ID_KEYS = ['checkout_id', 'cart_token', 'checkout_session_id', 'session_id', 'cart_id', 'id'] as const;
const AMOUNT_KEYS = ['total_price', 'grand_total', 'order_total', 'amount', 'total'] as const;
const DISCOUNT_KEYS = ['total_discount', 'discount', 'discount_total'] as const;
const TAX_KEYS = ['total_tax', 'tax', 'tax_total'] as const;
const SHIPPING_KEYS = ['total_shipping', 'shipping', 'shipping_total'] as const;
const SUBTOTAL_KEYS = ['subtotal_price', 'subtotal', 'sub_total'] as const;
const CURRENCY_KEYS = ['currency', 'currency_code'] as const;
const EMAIL_KEYS = ['email', 'customer_email', 'user_email'] as const;
const PHONE_KEYS = ['phone', 'customer_phone', 'mobile', 'contact'] as const;
const CUSTOMER_ID_KEYS = ['customer_id', 'customer_uid', 'uid', 'user_id'] as const;
const PAYMENT_ID_KEYS = ['payment_id', 'txn_id', 'transaction_id', 'pg_payment_id', 'gateway_payment_id'] as const;
const REFUND_ID_KEYS = ['refund_id', 'id', 'refund_reference'] as const;
const OCCURRED_KEYS = ['occurred_at', 'updated_at', 'event_time', 'created_at', 'timestamp'] as const;
const STEP_KEYS = ['step', 'step_name', 'stage', 'checkout_step'] as const;
const DISCOUNT_CODE_KEYS = ['discount_code', 'coupon_code', 'coupon', 'promo_code'] as const;
const REFERRER_KEYS = ['referrer', 'referring_url', 'http_referrer', 'referer'] as const;

function resolveCurrency(rec: Record<string, unknown>): string {
  return (firstField(rec, CURRENCY_KEYS) ?? 'INR').toUpperCase();
}

/**
 * Resolve the payload's own timestamp — FAIL CLOSED when absent/unparseable.
 *
 * occurred_at feeds the DETERMINISTIC event_id seed (order/payment/checkout-funnel), so a
 * wall-clock fallback here would mint a DIFFERENT event_id on every at-least-once webhook
 * redelivery → a permanent TRUE duplicate in Bronze/Silver. A payload carrying none of the
 * OCCURRED_KEYS is therefore unmappable: throw — the same fail-closed posture the frozen
 * abandoned lane already takes (ShopfloWebhookStrategy rejects a missing occurred_at with a
 * clear reason instead of minting time; the pipeline's payloadMap catch turns this into a
 * logged 400 skip, never a 500 retry loop).
 */
function resolveOccurredAt(rec: Record<string, unknown>): string {
  const raw = firstField(rec, OCCURRED_KEYS);
  if (raw && !Number.isNaN(Date.parse(raw))) return new Date(raw).toISOString();
  throw new Error(
    `[shopflo-mapper] record missing a usable timestamp (${OCCURRED_KEYS.join('/')}) — ` +
    'refusing to mint wall-clock occurred_at (the deterministic event_id would change on redelivery)',
  );
}

/** Normalize a Shopflo payment method to the closed set; default 'prepaid' (Shopflo is online-checkout-first). */
function resolvePaymentMethod(raw: string | null | undefined): 'cod' | 'prepaid' {
  const s = (raw ?? '').trim().toLowerCase();
  if (s === 'cod' || s === 'cash_on_delivery' || s === 'cash on delivery' || s === 'cash') return 'cod';
  return 'prepaid';
}

// ── Boundary hashes ─────────────────────────────────────────────────────────────

/** Hash a raw payment id at the boundary: sha256(per-brand-salt-hex || normalized id). Raw DROPPED. */
export function hashPaymentId(rawId: string, saltHex: string): string {
  const normalized = rawId.trim().toLowerCase();
  return createHash('sha256')
    .update(Buffer.from(saltHex, 'hex'))
    .update(normalized, 'utf8')
    .digest('hex');
}

function hashEmailFrom(rec: Record<string, unknown>, saltHex: string, regionCode: string): string | undefined {
  const email = firstField(rec, EMAIL_KEYS) ?? firstNestedCustomer(rec, EMAIL_KEYS);
  return email ? hashIdentifier(email, 'email', saltHex, regionCode) : undefined;
}

function hashPhoneFrom(rec: Record<string, unknown>, saltHex: string, regionCode: string): string | undefined {
  const phone = firstField(rec, PHONE_KEYS) ?? firstNestedCustomer(rec, PHONE_KEYS);
  if (!phone) return undefined;
  const { normalized } = normalizePhone(phone, regionCode);
  return hashIdentifier(normalized, 'phone', saltHex, regionCode);
}

/** Probe a nested `customer` object for an identifier (Shopflo nests email/phone under customer). */
function firstNestedCustomer(rec: Record<string, unknown>, keys: readonly string[]): string | null {
  const cust = rec['customer'];
  if (cust && typeof cust === 'object') return firstField(cust as Record<string, unknown>, keys);
  return null;
}

// SPEC: A.1.4 — INTEROP-space (AMD-01) plain-sha256 of the SAME probed raw email/phone. Raw is
// consumed here and DROPPED exactly like the salted path. Only called when the flag is ON.
function interopEmailFrom(rec: Record<string, unknown>): string | undefined {
  const email = firstField(rec, EMAIL_KEYS) ?? firstNestedCustomer(rec, EMAIL_KEYS);
  return email ? (emailInteropHash(email) ?? undefined) : undefined;
}

function interopPhoneFrom(rec: Record<string, unknown>, regionCode: string): string | undefined {
  const phone = firstField(rec, PHONE_KEYS) ?? firstNestedCustomer(rec, PHONE_KEYS);
  return phone ? (phoneInteropHash(phone, regionCode) ?? undefined) : undefined;
}

/**
 * SPEC: A.1.4 — the interop block appended to Shopflo order/checkout properties when the caller
 * enables `connector.identity_fields`. Flag OFF (or absent) → {} → BYTE-IDENTICAL legacy envelope.
 * (checkout_session_id already rides projectJourneyContext on the SLICE-B events — AMD-02.)
 */
function projectInteropIdentifiers(
  rec: Record<string, unknown>,
  regionCode: string,
  identityFields?: IdentityFieldsOptions,
): { email_sha256?: string; phone_sha256?: string } {
  if (identityFields?.emitInteropIdentifiers !== true) return {};
  const emailSha256 = interopEmailFrom(rec);
  const phoneSha256 = interopPhoneFrom(rec, regionCode);
  return {
    ...(emailSha256 !== undefined ? { email_sha256: emailSha256 } : {}),
    ...(phoneSha256 !== undefined ? { phone_sha256: phoneSha256 } : {}),
  };
}

// ── Journey context (non-PII; threaded directly — finding #9) ────────────────────

interface ShopfloJourneyContext {
  utm_params?: Record<string, unknown>;
  referrer?: string;
  discount_code?: string;
  checkout_session_id?: string;
}

function projectJourneyContext(rec: Record<string, unknown>): ShopfloJourneyContext {
  const out: ShopfloJourneyContext = {};
  const utm = rec['utm_params'] ?? rec['utm'];
  if (utm && typeof utm === 'object' && !Array.isArray(utm)) out.utm_params = utm as Record<string, unknown>;
  const referrer = firstField(rec, REFERRER_KEYS);
  if (referrer) out.referrer = referrer;
  const discountCode = firstField(rec, DISCOUNT_CODE_KEYS);
  if (discountCode) out.discount_code = discountCode;
  const sessionId = firstField(rec, ['checkout_session_id', 'session_id']);
  if (sessionId) out.checkout_session_id = sessionId;
  return out;
}

// ── Deterministic event_id helpers (distinct namespaces; IDENTICAL byte layout to the kernel util) ──

/** Refund event_id: sha256(`${brandId}:${refundId}:refund.recorded.v1`) — one stable id per refund. */
export function uuidV5FromShopfloRefund(brandId: string, refundId: string): string {
  return hashToUuidShaped(`${brandId}:${refundId}:${REFUND_RECORDED_V1_EVENT_NAME}`);
}

/** Payment event_id: sha256(`${brandId}:${orderId}:${paymentKey}:${occurredAtMs}:${eventName}`). */
export function uuidV5FromShopfloPayment(
  brandId: string,
  orderId: string,
  paymentKey: string,
  occurredAtMs: number,
  eventName: string,
): string {
  return hashToUuidShaped(`${brandId}:${orderId}:${paymentKey}:${occurredAtMs}:${eventName}`);
}

/** Checkout-funnel event_id: sha256(`${brandId}:${checkoutId}:${occurredAtMs}:${eventName}`). */
export function uuidV5FromShopfloCheckoutFunnel(
  brandId: string,
  checkoutId: string,
  occurredAtMs: number,
  eventName: string,
): string {
  return hashToUuidShaped(`${brandId}:${checkoutId}:${occurredAtMs}:${eventName}`);
}

// ── Raw Shopflo shapes (loose — probed across candidate keys) ─────────────────────

export interface ShopfloOrderRecord {
  /** The Shopflo order event subtype, e.g. 'order.created' | 'order.paid' | 'order.cancelled' | 'order.refunded'. */
  event_name?: string | null;
  status?: string | null;
  financial_status?: string | null;
  payment_method?: string | null;
  cancelled_at?: string | null;
  [key: string]: unknown;
}

export interface ShopfloPaymentRecord {
  event_name?: string | null;
  payment_status?: string | null;
  status?: string | null;
  [key: string]: unknown;
}

export interface ShopfloRefundRecord {
  [key: string]: unknown;
}

export interface ShopfloCheckoutFunnelRecord {
  [key: string]: unknown;
}

// ── Output shapes ────────────────────────────────────────────────────────────────

/**
 * order.live.v1 properties, Shopflo-sourced. Mirrors @brain/shopify-mapper OrderProperties field-for-field
 * (so silver_order_state reads it identically) but with source:'shopflo' and no shopify_order_id.
 */
export interface ShopfloOrderProperties extends ShopfloJourneyContext {
  source: 'shopflo';
  data_source: DataSource;
  order_id: string;                  // ledger spine key (NOT PII)
  amount_minor: string;              // BIGINT-as-string minor units (I-S07)
  currency_code: string;
  payment_method: 'cod' | 'prepaid';
  financial_status: string;          // normalized: paid|pending|refunded|voided|cancelled
  cancelled_at: string | null;       // ISO-8601 when cancelled, else null
  hashed_customer_email?: string;
  hashed_customer_phone?: string;
  storefront_customer_id?: string;
  // ── SPEC: A.1.4 (WA-09, AMD-01 dual-write) — interop plain-sha256; emitted ONLY when the
  // caller enables connector.identity_fields. checkout_session_id rides ShopfloJourneyContext.
  email_sha256?: string;
  phone_sha256?: string;
  line_items?: OrderLineItem[];
  tax_total_minor?: string;
  shipping_total_minor?: string;
  discount_total_minor?: string;
  refunds?: OrderRefund[];
  refund_total_minor?: string;
}

export interface MappedShopfloOrderEvent {
  event_name: typeof ORDER_LIVE_V1_EVENT_NAME;
  event_id: string;
  occurred_at: string;
  properties: ShopfloOrderProperties;
}

export interface ShopfloRefundProperties {
  source: 'shopflo';
  data_source: DataSource;
  refund_id: string;
  order_id: string | null;
  amount_minor: string;
  currency_code: string | null;
  reason: string | null;
  occurred_at: string;
}

export interface MappedShopfloRefundEvent {
  event_name: typeof REFUND_RECORDED_V1_EVENT_NAME;
  event_id: string;
  occurred_at: string;
  properties: ShopfloRefundProperties;
}

export type ShopfloPaymentEventName =
  | typeof PAYMENT_ATTEMPTED_V1_EVENT_NAME
  | typeof PAYMENT_AUTHORIZED_V1_EVENT_NAME;

export interface ShopfloPaymentProperties {
  source: 'shopflo';
  data_source: DataSource;
  order_id: string;
  payment_status: 'initiated' | 'failed' | 'authorized';
  payment_id_hash: string | null;       // sha256(salt || raw payment id) — raw DROPPED
  amount_minor?: string;                 // bigint minor units (optional)
  currency_code: string;
  occurred_at: string;
}

export interface MappedShopfloPaymentEvent {
  event_name: ShopfloPaymentEventName;
  event_id: string;
  occurred_at: string;
  properties: ShopfloPaymentProperties;
}

export type ShopfloCheckoutFunnelKind = 'abandoned' | 'started' | 'step' | 'completed';

export type ShopfloCheckoutFunnelEventName =
  | typeof CHECKOUT_ABANDONED_V1_EVENT_NAME
  | typeof SHOPFLO_CHECKOUT_STARTED_V1_EVENT_NAME
  | typeof SHOPFLO_CHECKOUT_STEP_V1_EVENT_NAME
  | typeof SHOPFLO_CHECKOUT_COMPLETED_V1_EVENT_NAME;

export interface ShopfloCheckoutFunnelProperties extends ShopfloJourneyContext {
  source: 'shopflo';
  data_source: DataSource;
  order_id: string | null;               // checkout/cart ref (silver_checkout_signal.order_id)
  total_price_minor?: string;            // bigint minor units (OMITTED when absent → no phantom currency-only row)
  total_discount_minor?: string;
  currency_code: string;
  has_address: boolean;
  step_name?: string;                    // only for shopflo.checkout_step.v1
  hashed_customer_email?: string;
  hashed_customer_phone?: string;
  storefront_customer_id?: string;
  // ── SPEC: A.1.4 (WA-09, AMD-01 dual-write) — interop plain-sha256; emitted ONLY when the
  // caller enables connector.identity_fields. checkout_session_id rides ShopfloJourneyContext.
  email_sha256?: string;
  phone_sha256?: string;
  occurred_at: string;
}

export interface MappedShopfloCheckoutFunnelEvent {
  event_name: ShopfloCheckoutFunnelEventName;
  event_id: string;
  occurred_at: string;
  properties: ShopfloCheckoutFunnelProperties;
}

// ── Order status normalizer ──────────────────────────────────────────────────────

/**
 * Normalize a Shopflo order to the canonical financial_status the recognition gate understands:
 * paid | pending | refunded | voided | cancelled. The event subtype wins over the raw status
 * (order.failed → 'voided' — the recognition gate recognises refunded/voided/cancelled, never "failed").
 */
function normalizeFinancialStatus(record: ShopfloOrderRecord): string {
  const ev = (record.event_name ?? '').toLowerCase();
  const raw = (record.financial_status ?? record.status ?? '').toLowerCase();
  if (ev.includes('fail') || raw.includes('fail') || raw === 'voided') return 'voided';
  if (ev.includes('cancel') || raw.includes('cancel')) return 'cancelled';
  if (ev.includes('refund') || raw.includes('refund')) return 'refunded';
  if (ev.includes('paid') || raw === 'paid' || raw === 'success' || raw === 'completed' || raw === 'captured') return 'paid';
  return 'pending';
}

/** Optional economic-depth projection (line items / tax / shipping / discount / refunds), resilient. */
function projectShopfloOrderDepth(record: ShopfloOrderRecord): Partial<ShopfloOrderProperties> {
  const out: Partial<ShopfloOrderProperties> = {};

  const rawItems = record.line_items;
  if (Array.isArray(rawItems) && rawItems.length > 0) {
    const items: OrderLineItem[] = [];
    for (const raw of rawItems) {
      const li = (raw ?? {}) as Record<string, unknown>;
      const unit = tryDecimalToMinor(firstField(li, ['unit_price', 'price', 'mrp', 'selling_price']));
      if (unit === null) continue;
      const qtyRaw = li['quantity'] ?? li['qty'];
      const qty = typeof qtyRaw === 'number' && qtyRaw >= 0 ? qtyRaw : toQuantity(qtyRaw as string | number | null) || 1;
      const lineDiscount = tryDecimalToMinor(firstField(li, ['total_discount', 'discount'])) ?? 0n;
      const lineTotal = unit * BigInt(qty) - lineDiscount;
      items.push({
        sku: firstField(li, ['sku']) ?? null,
        title: firstField(li, ['title', 'name', 'product_name']) ?? null,
        quantity: qty,
        unit_price_minor: unit.toString(),
        line_total_minor: lineTotal.toString(),
        line_discount_minor: lineDiscount.toString(),
        product_id: firstField(li, ['product_id']) ?? null,
        variant_id: firstField(li, ['variant_id']) ?? null,
      });
    }
    if (items.length > 0) out.line_items = items;
  }

  const tax = firstMoneyMinor(record, TAX_KEYS);
  if (tax !== null) out.tax_total_minor = tax;
  const shipping = firstMoneyMinor(record, SHIPPING_KEYS);
  if (shipping !== null) out.shipping_total_minor = shipping;
  const discount = firstMoneyMinor(record, DISCOUNT_KEYS);
  if (discount !== null) out.discount_total_minor = discount;

  const rawRefunds = record.refunds;
  if (Array.isArray(rawRefunds) && rawRefunds.length > 0) {
    const refunds: OrderRefund[] = [];
    let refundTotal = 0n;
    for (const raw of rawRefunds) {
      const r = (raw ?? {}) as Record<string, unknown>;
      const amt = tryDecimalToMinor(firstField(r, ['amount', 'refund_amount', 'total'])) ?? 0n;
      refundTotal += amt;
      const processedRaw = firstField(r, ['processed_at', 'created_at', 'refunded_at']);
      refunds.push({
        refund_id: firstField(r, ['refund_id', 'id']) ?? null,
        processed_at: processedRaw && !Number.isNaN(Date.parse(processedRaw)) ? new Date(processedRaw).toISOString() : null,
        amount_minor: amt.toString(),
        reason: firstField(r, ['reason', 'note']) ?? null,
      });
    }
    if (refunds.length > 0) {
      out.refunds = refunds;
      out.refund_total_minor = refundTotal.toString();
    }
  } else {
    const scalar = firstMoneyMinor(record, ['refund_amount', 'refunded_amount']);
    if (scalar !== null) out.refund_total_minor = scalar;
  }

  return out;
}

// ── Order mapper (THE critical fix — makes Shopflo an order source) ───────────────

/**
 * Map a raw Shopflo order webhook to a canonical order.live.v1 event (source:'shopflo'). The order state
 * is carried by financial_status + cancelled_at + refunds, exactly like the Shopify/GoKwik order lane, so
 * silver_order_state → silver_order_recognition → the Gold revenue ledger ingest it with ZERO change.
 */
export function mapShopfloOrder(
  record: ShopfloOrderRecord,
  brandId: string,
  saltHex: string,
  regionCode = 'IN',
  dataSource: DataSource = 'real',
  identityFields?: IdentityFieldsOptions,
): MappedShopfloOrderEvent {
  const orderId = firstField(record, ORDER_ID_KEYS);
  if (!orderId) {
    throw new Error('[shopflo-mapper] order record missing order_id (ledger spine key)');
  }

  const amountMinor = moneyToMinorString(firstField(record, AMOUNT_KEYS) ?? '0');
  const financialStatus = normalizeFinancialStatus(record);
  const occurredAt = resolveOccurredAt(record);
  const occurredAtMs = new Date(occurredAt).getTime();

  const cancelledRaw = record.cancelled_at != null ? String(record.cancelled_at) : null;
  const cancelledAt =
    financialStatus === 'cancelled'
      ? (cancelledRaw && !Number.isNaN(Date.parse(cancelledRaw)) ? new Date(cancelledRaw).toISOString() : occurredAt)
      : (cancelledRaw && !Number.isNaN(Date.parse(cancelledRaw)) ? new Date(cancelledRaw).toISOString() : null);

  const hashedEmail = hashEmailFrom(record, saltHex, regionCode);
  const hashedPhone = hashPhoneFrom(record, saltHex, regionCode);
  const storefrontCustomerId = firstField(record, CUSTOMER_ID_KEYS) ?? firstNestedCustomer(record, CUSTOMER_ID_KEYS) ?? undefined;

  const properties: ShopfloOrderProperties = {
    source: 'shopflo',
    data_source: dataSource,
    order_id: orderId,
    amount_minor: amountMinor,
    currency_code: resolveCurrency(record),
    payment_method: resolvePaymentMethod(record.payment_method),
    financial_status: financialStatus,
    cancelled_at: cancelledAt,
    ...(hashedEmail !== undefined ? { hashed_customer_email: hashedEmail } : {}),
    ...(hashedPhone !== undefined ? { hashed_customer_phone: hashedPhone } : {}),
    ...(storefrontCustomerId !== undefined ? { storefront_customer_id: storefrontCustomerId } : {}),
    // SPEC: A.1.4 — interop dual-write ({} when the flag is OFF).
    ...projectInteropIdentifiers(record, regionCode, identityFields),
    ...projectJourneyContext(record),
    ...projectShopfloOrderDepth(record),
  };

  return {
    event_name: ORDER_LIVE_V1_EVENT_NAME,
    event_id: uuidV5FromOrderLive(brandId, orderId, occurredAtMs),
    occurred_at: occurredAt,
    properties,
  };
}

// ── Refund mapper ────────────────────────────────────────────────────────────────

/**
 * Map a dedicated Shopflo refund event → refund.recorded.v1. (order.refunded still flows through
 * mapShopfloOrder as a financial_status='refunded' state change; this handles standalone refund webhooks.)
 */
export function mapShopfloRefund(
  record: ShopfloRefundRecord,
  brandId: string,
  _saltHex: string,
  _regionCode = 'IN',
  dataSource: DataSource = 'real',
): MappedShopfloRefundEvent {
  const refundId = firstField(record, REFUND_ID_KEYS);
  if (!refundId) {
    throw new Error('[shopflo-mapper] refund record missing refund id');
  }

  const occurredAt = resolveOccurredAt(record);
  const amountMinor = firstMoneyMinor(record, ['amount', 'refund_amount', 'total', 'total_refund']) ?? '0';
  const orderId = firstField(record, ORDER_ID_KEYS);

  const properties: ShopfloRefundProperties = {
    source: 'shopflo',
    data_source: dataSource,
    refund_id: refundId,
    order_id: orderId,
    amount_minor: amountMinor,
    currency_code: firstField(record, CURRENCY_KEYS)?.toUpperCase() ?? null,
    reason: firstField(record, ['reason', 'note']) ?? null,
    occurred_at: occurredAt,
  };

  return {
    event_name: REFUND_RECORDED_V1_EVENT_NAME,
    event_id: uuidV5FromShopfloRefund(brandId, refundId),
    occurred_at: occurredAt,
    properties,
  };
}

// ── Payment mapper ───────────────────────────────────────────────────────────────

/**
 * Map a raw Shopflo payment webhook to a canonical payment event.
 * @param kind 'attempted' → payment.attempted.v1 (initiated|failed) | 'authorized' → payment.authorized.v1
 */
export function mapShopfloPayment(
  record: ShopfloPaymentRecord,
  brandId: string,
  saltHex: string,
  _regionCode: string,
  kind: 'attempted' | 'authorized',
  dataSource: DataSource = 'real',
): MappedShopfloPaymentEvent {
  const orderId = firstField(record, ORDER_ID_KEYS);
  if (!orderId) {
    throw new Error('[shopflo-mapper] payment record missing order_id');
  }

  const eventName = kind === 'authorized' ? PAYMENT_AUTHORIZED_V1_EVENT_NAME : PAYMENT_ATTEMPTED_V1_EVENT_NAME;
  const occurredAt = resolveOccurredAt(record);
  const occurredAtMs = new Date(occurredAt).getTime();

  let paymentStatus: 'initiated' | 'failed' | 'authorized';
  if (kind === 'authorized') {
    paymentStatus = 'authorized';
  } else {
    const raw = (record.payment_status ?? record.status ?? '').toLowerCase();
    paymentStatus = /fail|declin|error/.test(raw) ? 'failed' : 'initiated';
  }

  const rawPaymentId = firstField(record, PAYMENT_ID_KEYS);
  const paymentIdHash = rawPaymentId ? hashPaymentId(rawPaymentId, saltHex) : null;
  const amountMinor = firstMoneyMinor(record, AMOUNT_KEYS);

  // Null-payment-id discriminator (audit fix): with a bare 'na' key, two DISTINCT payment signals
  // for the same order at the same occurred_at (e.g. an 'initiated' and a 'failed' attempt — both
  // payment.attempted.v1) collapsed to ONE event_id → under-count. Fold the normalized
  // payment_status (a stable payload-derived field — never random/wall-clock) into the seed for
  // the null case. Two payloads identical in status+time with no payment id ARE the same logical
  // event → same id (collapsing stays correct). A present payment id keeps the legacy seed.
  const paymentKey = rawPaymentId ?? `na:${paymentStatus}`;

  const properties: ShopfloPaymentProperties = {
    source: 'shopflo',
    data_source: dataSource,
    order_id: orderId,
    payment_status: paymentStatus,
    payment_id_hash: paymentIdHash,
    currency_code: resolveCurrency(record),
    occurred_at: occurredAt,
    ...(amountMinor !== null ? { amount_minor: amountMinor } : {}),
  };

  return {
    event_name: eventName,
    event_id: uuidV5FromShopfloPayment(brandId, orderId, paymentKey, occurredAtMs, eventName),
    occurred_at: occurredAt,
    properties,
  };
}

// ── Checkout-funnel mapper ─────────────────────────────────────────────────────────

const CHECKOUT_FUNNEL_EVENT_NAME: Record<ShopfloCheckoutFunnelKind, ShopfloCheckoutFunnelEventName> = {
  abandoned: CHECKOUT_ABANDONED_V1_EVENT_NAME,
  started: SHOPFLO_CHECKOUT_STARTED_V1_EVENT_NAME,
  step: SHOPFLO_CHECKOUT_STEP_V1_EVENT_NAME,
  completed: SHOPFLO_CHECKOUT_COMPLETED_V1_EVENT_NAME,
};

/**
 * Map a raw Shopflo checkout webhook to a canonical checkout-signal event.
 *
 * @param kind 'abandoned' → checkout.abandoned.v1 (source-neutral convergence canon) | 'started' →
 *             shopflo.checkout_started.v1 | 'step' → shopflo.checkout_step.v1 |
 *             'completed' → shopflo.checkout_completed.v1.
 *
 * NOTE: the LIVE abandoned webhook lane still uses the frozen mapShopfloCheckoutAbandoned (namespaced
 * shopflo.checkout_abandoned.v1) for dedup stability + silver_shopflo_normalize parity; this 'abandoned'
 * branch is the source-neutral convergence target (finding #13) available to new callers.
 */
export function mapShopfloCheckout(
  record: ShopfloCheckoutFunnelRecord,
  brandId: string,
  saltHex: string,
  regionCode: string,
  kind: ShopfloCheckoutFunnelKind,
  dataSource: DataSource = 'real',
  identityFields?: IdentityFieldsOptions,
): MappedShopfloCheckoutFunnelEvent {
  const checkoutId = firstField(record, CHECKOUT_ID_KEYS);
  if (!checkoutId) {
    throw new Error('[shopflo-mapper] checkout record missing checkout/cart id');
  }

  const eventName = CHECKOUT_FUNNEL_EVENT_NAME[kind];
  const occurredAt = resolveOccurredAt(record);
  const occurredAtMs = new Date(occurredAt).getTime();

  const totalMinor = firstMoneyMinor(record, [...AMOUNT_KEYS, ...SUBTOTAL_KEYS]);
  const discountMinor = firstMoneyMinor(record, DISCOUNT_KEYS);
  const hasAddressRaw = record['has_address'] ?? record['address_present'];
  const hasAddress =
    hasAddressRaw === true ||
    hasAddressRaw === 'true' ||
    firstField(record, ['address', 'shipping_address', 'pincode', 'zip']) !== null;

  const hashedEmail = hashEmailFrom(record, saltHex, regionCode);
  const hashedPhone = hashPhoneFrom(record, saltHex, regionCode);
  const storefrontCustomerId = firstField(record, CUSTOMER_ID_KEYS) ?? firstNestedCustomer(record, CUSTOMER_ID_KEYS) ?? undefined;
  const stepName = kind === 'step' ? (firstField(record, STEP_KEYS) ?? undefined) : undefined;

  const properties: ShopfloCheckoutFunnelProperties = {
    source: 'shopflo',
    data_source: dataSource,
    order_id: firstField(record, ORDER_ID_KEYS) ?? checkoutId,
    currency_code: resolveCurrency(record),
    has_address: hasAddress,
    occurred_at: occurredAt,
    ...(totalMinor !== null ? { total_price_minor: totalMinor } : {}),
    ...(discountMinor !== null ? { total_discount_minor: discountMinor } : {}),
    ...(stepName !== undefined ? { step_name: stepName } : {}),
    ...(hashedEmail !== undefined ? { hashed_customer_email: hashedEmail } : {}),
    ...(hashedPhone !== undefined ? { hashed_customer_phone: hashedPhone } : {}),
    ...(storefrontCustomerId !== undefined ? { storefront_customer_id: storefrontCustomerId } : {}),
    // SPEC: A.1.4 — interop dual-write ({} when the flag is OFF).
    ...projectInteropIdentifiers(record, regionCode, identityFields),
    ...projectJourneyContext(record),
  };

  return {
    event_name: eventName,
    event_id: uuidV5FromShopfloCheckoutFunnel(brandId, checkoutId, occurredAtMs, eventName),
    occurred_at: occurredAt,
    properties,
  };
}
