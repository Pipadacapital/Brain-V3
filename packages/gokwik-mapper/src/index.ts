/**
 * @brain/gokwik-mapper — Frozen shared mapper for GoKwik webhook-first checkout/payments events.
 *
 * FROZEN API — do not change after commit without Architect sign-off.
 *
 * GoKwik is a CHECKOUT / PAYMENTS-OPTIMISATION source (NOT logistics). Its real-time seam is the
 * webhook (GokwikWebhookStrategy). Every webhook is discriminated on its GoKwik event_type and mapped
 * to exactly ONE canonical Brain event that flows through silver_collector_event into the existing
 * order / checkout-signal / payment marts. The earlier AWB-lifecycle model was a synthetic mistake
 * (GoKwik exposes no AWB-read API; logistics truth = Shiprocket) and has been RETIRED here.
 *
 * The pure mappers exported here:
 *   mapGokwikOrder        — order.created/paid/failed/cancelled/refunded/updated → order.live.v1
 *                           (OrderProperties-shaped, source:'gokwik' → reuses @brain/shopify-mapper
 *                            decimalStringToMinor / uuidV5FromOrderLive / ORDER_LIVE_V1_EVENT_NAME so
 *                            GoKwik orders land in silver_order_state identically to Shopify orders).
 *   mapGokwikCheckout     — checkout.abandoned → checkout.abandoned.v1 (source-neutral);
 *                           checkout.started → gokwik.checkout_started.v1;
 *                           checkout.step_completed → gokwik.checkout_step.v1 (→ silver_checkout_signal).
 *   mapGokwikPayment      — payment.attempted → payment.attempted.v1 (initiated/failed);
 *                           payment.authorized → payment.authorized.v1 (→ silver_payment).
 *   mapGokwikRtoPredict   — risk.scored → gokwik.rto_predict.v1 (categorical risk_flag, VERBATIM raw).
 *
 * Binding invariants (identical to Shopify):
 *   MONEY         — bigint MINOR units (decimalStringToMinor) + a sibling currency_code (default INR).
 *                   Never a float, never blended.
 *   BOUNDARY-HASH — raw email/phone are hashed at this boundary with the per-brand salt
 *                   (hashIdentifier / normalizePhone) and DROPPED. payment_id is hashed too. Raw PII
 *                   NEVER leaves this scope. The order_id (ledger spine key) is NOT PII → passed through.
 *   uuidV5        — order: uuidV5FromOrderLive(brand:order_id:occurredAtMs:order.live.v1) → per-state
 *                   idempotent restatement. checkout/payment: uuidV5(brand:key:occurredAtMs:event_name).
 *   DEV-HONESTY   — data_source stamped into properties ('real' | 'synthetic') for the UI badge.
 *
 * brandId / saltHex / regionCode are ALWAYS passed by the caller (server-derived from the connector
 * row — MT-1), NEVER read from the GoKwik payload.
 */

import { createHash } from 'node:crypto';
import { hashToUuidShaped } from '@brain/connector-core';
import { hashIdentifier, normalizePhone } from '@brain/identity-core';
import {
  decimalStringToMinor,
  tryDecimalToMinor,
  uuidV5FromOrderLive,
  ORDER_LIVE_V1_EVENT_NAME,
  type OrderLineItem,
  type OrderRefund,
} from '@brain/shopify-mapper';

// ── Event name constants ─────────────────────────────────────────────────────

export const GOKWIK_RTO_PREDICT_V1_EVENT_NAME = 'gokwik.rto_predict.v1' as const;
/** Source-neutral abandoned-checkout signal (shared with the shopflo lane's semantics). */
export const CHECKOUT_ABANDONED_V1_EVENT_NAME = 'checkout.abandoned.v1' as const;
/** GoKwik checkout funnel — entered checkout. */
export const GOKWIK_CHECKOUT_STARTED_V1_EVENT_NAME = 'gokwik.checkout_started.v1' as const;
/** GoKwik checkout funnel — completed a checkout step (address / payment-method / etc.). */
export const GOKWIK_CHECKOUT_STEP_V1_EVENT_NAME = 'gokwik.checkout_step.v1' as const;
/** Payment attempt (initiated or failed). */
export const PAYMENT_ATTEMPTED_V1_EVENT_NAME = 'payment.attempted.v1' as const;
/** Payment authorized (the gateway authorized the charge). */
export const PAYMENT_AUTHORIZED_V1_EVENT_NAME = 'payment.authorized.v1' as const;

// Re-export the canonical order event name so consumers can reference it from the gokwik surface.
export { ORDER_LIVE_V1_EVENT_NAME };

// ── data_source provenance (DEV-HONESTY) ──────────────────────────────────────

export type DataSource = 'real' | 'synthetic';

// ── Categorical risk flag (RTO-Predict) ───────────────────────────────────────

/** Categorical risk flag — normalized to a closed set; the original string is preserved verbatim. */
export type RiskFlag = 'high' | 'medium' | 'low' | 'control' | 'unknown';

// ── Field-probe helpers ───────────────────────────────────────────────────────

/** First non-empty string/number across a list of candidate keys (GoKwik naming is POC-mediated). */
function firstField(rec: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return null;
}

const ORDER_ID_KEYS = ['moid', 'merchant_order_id', 'gokwik_order_id', 'order_id', 'oid'] as const;
const CHECKOUT_ID_KEYS = ['checkout_id', 'cart_id', 'moid', 'merchant_order_id', 'order_id'] as const;
const AMOUNT_KEYS = ['total', 'order_total', 'grand_total', 'amount'] as const;
const CHECKOUT_AMOUNT_KEYS = ['total', 'cart_value', 'order_total', 'amount', 'cart_total'] as const;
const DISCOUNT_KEYS = ['total_discount', 'discount', 'discount_total', 'discounts'] as const;
const TAX_KEYS = ['total_tax', 'tax', 'tax_total'] as const;
const CURRENCY_KEYS = ['currency', 'currency_code'] as const;
const EMAIL_KEYS = ['email', 'customer_email', 'user_email'] as const;
const PHONE_KEYS = ['phone', 'customer_phone', 'mobile', 'user_phone', 'contact'] as const;
const CUSTOMER_ID_KEYS = ['customer_id', 'gokwik_customer_id', 'user_id'] as const;
const PAYMENT_ID_KEYS = ['payment_id', 'txn_id', 'transaction_id', 'razorpay_payment_id', 'pg_payment_id'] as const;
const OCCURRED_KEYS = ['updated_at', 'event_time', 'created_at', 'timestamp'] as const;
const STEP_KEYS = ['step', 'step_name', 'stage', 'checkout_step'] as const;

const DEFAULT_CURRENCY = 'INR';

function resolveCurrency(rec: Record<string, unknown>): string {
  return (firstField(rec, CURRENCY_KEYS) ?? DEFAULT_CURRENCY).toUpperCase();
}

function resolveOccurredAt(rec: Record<string, unknown>): string {
  const raw = firstField(rec, OCCURRED_KEYS);
  if (raw && !Number.isNaN(Date.parse(raw))) return new Date(raw).toISOString();
  return new Date().toISOString();
}

/** Normalize a payment method to the closed set; default 'prepaid' (GoKwik orders are mostly online). */
function resolvePaymentMethod(raw: string | null | undefined): 'cod' | 'prepaid' {
  const s = (raw ?? '').trim().toLowerCase();
  if (s === 'cod' || s === 'cash_on_delivery' || s === 'cash on delivery' || s === 'cash') return 'cod';
  return 'prepaid';
}

/** Normalize the categorical risk_flag to a closed set. The verbatim string is preserved separately. */
export function normalizeRiskFlag(raw: string | null | undefined): RiskFlag {
  const s = (raw ?? '').trim().toLowerCase();
  if (s.includes('high')) return 'high';
  if (s.includes('medium') || s.includes('med')) return 'medium';
  if (s.includes('low')) return 'low';
  if (s.includes('control')) return 'control';
  return 'unknown';
}

// ── Boundary hashes ────────────────────────────────────────────────────────────

/**
 * Hash a payment id at the boundary: sha256(per-brand-salt-hex || normalized id).
 * The raw payment id is consumed here and DROPPED — only the hash survives.
 */
export function hashPaymentId(rawId: string, saltHex: string): string {
  const normalized = rawId.trim().toLowerCase();
  return createHash('sha256')
    .update(Buffer.from(saltHex, 'hex'))
    .update(normalized, 'utf8')
    .digest('hex');
}

/** Hash a raw email/phone with the per-brand salt; raw DROPPED. Returns undefined when absent. */
function hashEmail(rec: Record<string, unknown>, saltHex: string, regionCode: string): string | undefined {
  const email = firstField(rec, EMAIL_KEYS);
  return email ? hashIdentifier(email, 'email', saltHex, regionCode) : undefined;
}

function hashPhone(rec: Record<string, unknown>, saltHex: string, regionCode: string): string | undefined {
  const phone = firstField(rec, PHONE_KEYS);
  if (!phone) return undefined;
  const { normalized } = normalizePhone(phone, regionCode);
  return hashIdentifier(normalized, 'phone', saltHex, regionCode);
}

// ── UUID utils — shared kernel util (@brain/connector-core), IDENTICAL byte layout (I-ST04) ──

/**
 * Deterministic event_id for an RTO-Predict risk event.
 * Seed: sha256(`${brandId}:${orderId}:${requestId}:gokwik.rto_predict.v1`)
 * One event per prediction call (request_id distinguishes re-predictions for the same order).
 */
export function uuidV5FromRtoPredict(
  brandId: string,
  orderId: string,
  requestId: string,
): string {
  return hashToUuidShaped(`${brandId}:${orderId}:${requestId}:gokwik.rto_predict.v1`);
}

/**
 * Deterministic event_id for a GoKwik checkout signal.
 * Seed: sha256(`${brandId}:${checkoutId}:${occurredAtMs}:${eventName}`)
 * DISTINCT per (checkout, occurred_at, event) → a state change lands a new Bronze row; a replay of the
 * same signal → same id → Bronze ON CONFLICT DO NOTHING dedup.
 */
export function uuidV5FromCheckout(
  brandId: string,
  checkoutId: string,
  occurredAtMs: number,
  eventName: string,
): string {
  return hashToUuidShaped(`${brandId}:${checkoutId}:${occurredAtMs}:${eventName}`);
}

/**
 * Deterministic event_id for a GoKwik payment signal.
 * Seed: sha256(`${brandId}:${orderId}:${paymentKey}:${occurredAtMs}:${eventName}`)
 */
export function uuidV5FromPayment(
  brandId: string,
  orderId: string,
  paymentKey: string,
  occurredAtMs: number,
  eventName: string,
): string {
  return hashToUuidShaped(`${brandId}:${orderId}:${paymentKey}:${occurredAtMs}:${eventName}`);
}

// ── Raw GoKwik shapes ─────────────────────────────────────────────────────────

/** A raw GoKwik order webhook body (POC-mediated naming → probed across common keys). */
export interface GokwikOrderRecord {
  /** The normalized GoKwik order event subtype, e.g. 'order.created' | 'order.failed' | 'order.cancelled'. */
  event_type?: string | null;
  status?: string | null;
  order_status?: string | null;
  financial_status?: string | null;
  cancelled_at?: string | null;
  payment_method?: string | null;
  [key: string]: unknown;
}

export interface GokwikCheckoutRecord {
  event_type?: string | null;
  [key: string]: unknown;
}

export interface GokwikPaymentRecord {
  event_type?: string | null;
  payment_status?: string | null;
  status?: string | null;
  [key: string]: unknown;
}

export interface GokwikRtoPredictRecord {
  order_id?: string | null;          // order this prediction is for (the spine key)
  request_id?: string | null;        // GoKwik request_id
  risk_flag?: string | null;         // CATEGORICAL: High / Medium / Low Risk / Control — VERBATIM
  risk_reason?: string | null;       // free-text reason
  occurred_at?: string | null;
  [key: string]: unknown;
}

// ── Output Silver shapes ──────────────────────────────────────────────────────

/**
 * order.live.v1 properties, GoKwik-sourced. Mirrors @brain/shopify-mapper OrderProperties field-for-field
 * (so silver_order_state reads it identically) but with source:'gokwik' and no shopify_order_id.
 */
export interface GokwikOrderProperties {
  source: 'gokwik';
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
  // Optional economic breakdown (all minor units, BIGINT-as-string).
  line_items?: OrderLineItem[];
  tax_total_minor?: string;
  discount_total_minor?: string;
  refunds?: OrderRefund[];
  refund_total_minor?: string;
}

export interface MappedGokwikOrderEvent {
  event_name: typeof ORDER_LIVE_V1_EVENT_NAME;
  event_id: string;
  occurred_at: string;
  properties: GokwikOrderProperties;
}

export type GokwikCheckoutEventName =
  | typeof CHECKOUT_ABANDONED_V1_EVENT_NAME
  | typeof GOKWIK_CHECKOUT_STARTED_V1_EVENT_NAME
  | typeof GOKWIK_CHECKOUT_STEP_V1_EVENT_NAME;

export interface GokwikCheckoutProperties {
  source: 'gokwik';
  data_source: DataSource;
  order_id: string | null;               // checkout/cart ref (silver_checkout_signal.order_id)
  total_price_minor?: string;            // bigint minor units (optional — absent omits the money fields)
  total_discount_minor?: string;
  currency_code: string;
  has_address: boolean;
  step_name?: string;                    // only for gokwik.checkout_step.v1
  hashed_customer_email?: string;
  hashed_customer_phone?: string;
  storefront_customer_id?: string;
  occurred_at: string;
}

export interface MappedGokwikCheckoutEvent {
  event_name: GokwikCheckoutEventName;
  event_id: string;
  occurred_at: string;
  properties: GokwikCheckoutProperties;
}

export type GokwikPaymentEventName =
  | typeof PAYMENT_ATTEMPTED_V1_EVENT_NAME
  | typeof PAYMENT_AUTHORIZED_V1_EVENT_NAME;

export interface GokwikPaymentProperties {
  source: 'gokwik';
  data_source: DataSource;
  order_id: string;
  payment_status: 'initiated' | 'failed' | 'authorized';
  payment_id_hash: string | null;       // sha256(salt || raw payment id) — raw DROPPED
  amount_minor?: string;                 // bigint minor units (optional)
  currency_code: string;
  occurred_at: string;
}

export interface MappedGokwikPaymentEvent {
  event_name: GokwikPaymentEventName;
  event_id: string;
  occurred_at: string;
  properties: GokwikPaymentProperties;
}

export interface GokwikRtoPredictProperties {
  source: 'gokwik';
  data_source: DataSource;
  order_id: string;                  // spine key
  request_id: string | null;
  risk_flag: RiskFlag;               // categorical, closed set
  risk_flag_raw: string | null;      // the verbatim GoKwik string (never a fabricated number)
  risk_reason: string | null;
  occurred_at: string;
}

export interface MappedGokwikRtoPredictEvent {
  event_name: typeof GOKWIK_RTO_PREDICT_V1_EVENT_NAME;
  occurred_at: string;
  properties: GokwikRtoPredictProperties;
}

// ── Order status normalizer ────────────────────────────────────────────────────

/**
 * Normalize a GoKwik order to the canonical financial_status set the recognition gate understands:
 * paid | pending | refunded | voided | cancelled. The GoKwik event subtype wins over the raw status
 * (order.failed → 'voided' — the recognition gate recognises refunded/voided/cancelled, never "failed").
 */
function normalizeFinancialStatus(record: GokwikOrderRecord): string {
  const ev = (record.event_type ?? '').toLowerCase();
  const raw = (record.financial_status ?? record.status ?? record.order_status ?? '').toLowerCase();
  if (ev.includes('fail') || raw.includes('fail') || raw === 'voided') return 'voided';
  if (ev.includes('cancel') || raw.includes('cancel')) return 'cancelled';
  if (ev.includes('refund') || raw.includes('refund')) return 'refunded';
  if (ev.includes('paid') || raw === 'paid' || raw === 'success' || raw === 'completed' || raw === 'captured') return 'paid';
  return 'pending';
}

// ── Order economic-depth projection (optional, resilient) ──────────────────────

function projectGokwikOrderDepth(record: GokwikOrderRecord): Partial<GokwikOrderProperties> {
  const out: Partial<GokwikOrderProperties> = {};

  // Line items.
  const rawItems = record.line_items;
  if (Array.isArray(rawItems) && rawItems.length > 0) {
    const items: OrderLineItem[] = [];
    for (const raw of rawItems) {
      const li = (raw ?? {}) as Record<string, unknown>;
      const unit = tryDecimalToMinor(firstField(li, ['unit_price', 'price', 'mrp', 'selling_price']));
      if (unit === null) continue;
      const qtyRaw = li['quantity'] ?? li['qty'];
      const qty = typeof qtyRaw === 'number' && qtyRaw >= 0 ? qtyRaw : 1;
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

  // Tax + discount totals.
  const tax = tryDecimalToMinor(firstField(record, TAX_KEYS));
  if (tax !== null) out.tax_total_minor = tax.toString();
  const discount = tryDecimalToMinor(firstField(record, DISCOUNT_KEYS));
  if (discount !== null) out.discount_total_minor = discount.toString();

  // Refunds.
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
    // Scalar refund_amount fallback (some GoKwik refund webhooks carry just a total).
    const scalar = tryDecimalToMinor(firstField(record, ['refund_amount', 'refunded_amount']));
    if (scalar !== null) out.refund_total_minor = scalar.toString();
  }

  return out;
}

// ── Order mapper ────────────────────────────────────────────────────────────────

/**
 * Map a raw GoKwik order webhook to a canonical order.live.v1 event (source:'gokwik').
 *
 * @param record      Raw GoKwik order body (carries event_type for the state subtype)
 * @param brandId     Brand UUID (server-derived from the connector row — MT-1, never from payload)
 * @param saltHex     Per-brand 64-char hex salt for PII hashing
 * @param regionCode  Brand region code (e.g. 'IN')
 * @param dataSource  'real' | 'synthetic' (DEV-HONESTY)
 */
export function mapGokwikOrder(
  record: GokwikOrderRecord,
  brandId: string,
  saltHex: string,
  regionCode: string,
  dataSource: DataSource = 'real',
): MappedGokwikOrderEvent {
  const orderId = firstField(record, ORDER_ID_KEYS);
  if (!orderId) {
    throw new Error('[gokwik-mapper] order record missing order_id (ledger spine key)');
  }

  const amountMinor = decimalStringToMinor(firstField(record, AMOUNT_KEYS) ?? '0');
  const financialStatus = normalizeFinancialStatus(record);
  const occurredAt = resolveOccurredAt(record);

  const cancelledRaw = record.cancelled_at != null ? String(record.cancelled_at) : null;
  const cancelledAt =
    financialStatus === 'cancelled'
      ? (cancelledRaw && !Number.isNaN(Date.parse(cancelledRaw)) ? new Date(cancelledRaw).toISOString() : occurredAt)
      : (cancelledRaw && !Number.isNaN(Date.parse(cancelledRaw)) ? new Date(cancelledRaw).toISOString() : null);

  const hashedEmail = hashEmail(record, saltHex, regionCode);
  const hashedPhone = hashPhone(record, saltHex, regionCode);
  const storefrontCustomerId = firstField(record, CUSTOMER_ID_KEYS) ?? undefined;

  const properties: GokwikOrderProperties = {
    source: 'gokwik',
    data_source: dataSource,
    order_id: orderId,
    amount_minor: amountMinor.toString(),
    currency_code: resolveCurrency(record),
    payment_method: resolvePaymentMethod(record.payment_method),
    financial_status: financialStatus,
    cancelled_at: cancelledAt,
    ...(hashedEmail !== undefined ? { hashed_customer_email: hashedEmail } : {}),
    ...(hashedPhone !== undefined ? { hashed_customer_phone: hashedPhone } : {}),
    ...(storefrontCustomerId !== undefined ? { storefront_customer_id: storefrontCustomerId } : {}),
    ...projectGokwikOrderDepth(record),
  };

  const occurredAtMs = new Date(occurredAt).getTime();
  return {
    event_name: ORDER_LIVE_V1_EVENT_NAME,
    event_id: uuidV5FromOrderLive(brandId, orderId, occurredAtMs),
    occurred_at: occurredAt,
    properties,
  };
}

// ── Checkout mapper ──────────────────────────────────────────────────────────────

const CHECKOUT_EVENT_NAME: Record<'abandoned' | 'started' | 'step', GokwikCheckoutEventName> = {
  abandoned: CHECKOUT_ABANDONED_V1_EVENT_NAME,
  started: GOKWIK_CHECKOUT_STARTED_V1_EVENT_NAME,
  step: GOKWIK_CHECKOUT_STEP_V1_EVENT_NAME,
};

/**
 * Map a raw GoKwik checkout webhook to a canonical checkout signal event.
 *
 * @param kind 'abandoned' → checkout.abandoned.v1 | 'started' → gokwik.checkout_started.v1 |
 *             'step' → gokwik.checkout_step.v1
 */
export function mapGokwikCheckout(
  record: GokwikCheckoutRecord,
  brandId: string,
  saltHex: string,
  regionCode: string,
  kind: 'abandoned' | 'started' | 'step',
  dataSource: DataSource = 'real',
): MappedGokwikCheckoutEvent {
  const checkoutId = firstField(record, CHECKOUT_ID_KEYS);
  if (!checkoutId) {
    throw new Error('[gokwik-mapper] checkout record missing checkout/order id');
  }

  const eventName = CHECKOUT_EVENT_NAME[kind];
  const occurredAt = resolveOccurredAt(record);
  const occurredAtMs = new Date(occurredAt).getTime();

  const totalMinor = tryDecimalToMinor(firstField(record, CHECKOUT_AMOUNT_KEYS));
  const discountMinor = tryDecimalToMinor(firstField(record, DISCOUNT_KEYS));
  const hasAddressRaw = record['has_address'] ?? record['address_present'];
  const hasAddress =
    hasAddressRaw === true ||
    hasAddressRaw === 'true' ||
    firstField(record, ['address', 'shipping_address', 'pincode', 'zip']) !== null;

  const hashedEmail = hashEmail(record, saltHex, regionCode);
  const hashedPhone = hashPhone(record, saltHex, regionCode);
  const storefrontCustomerId = firstField(record, CUSTOMER_ID_KEYS) ?? undefined;
  const stepName = kind === 'step' ? (firstField(record, STEP_KEYS) ?? undefined) : undefined;

  const properties: GokwikCheckoutProperties = {
    source: 'gokwik',
    data_source: dataSource,
    order_id: firstField(record, ORDER_ID_KEYS) ?? checkoutId,
    currency_code: resolveCurrency(record),
    has_address: hasAddress,
    occurred_at: occurredAt,
    // Money fields are OMITTED when absent (a NULL price must not carry a phantom currency-only row).
    ...(totalMinor !== null ? { total_price_minor: totalMinor.toString() } : {}),
    ...(discountMinor !== null ? { total_discount_minor: discountMinor.toString() } : {}),
    ...(stepName !== undefined ? { step_name: stepName } : {}),
    ...(hashedEmail !== undefined ? { hashed_customer_email: hashedEmail } : {}),
    ...(hashedPhone !== undefined ? { hashed_customer_phone: hashedPhone } : {}),
    ...(storefrontCustomerId !== undefined ? { storefront_customer_id: storefrontCustomerId } : {}),
  };

  return {
    event_name: eventName,
    event_id: uuidV5FromCheckout(brandId, checkoutId, occurredAtMs, eventName),
    occurred_at: occurredAt,
    properties,
  };
}

// ── Payment mapper ───────────────────────────────────────────────────────────────

/**
 * Map a raw GoKwik payment webhook to a canonical payment event.
 *
 * @param kind 'attempted' → payment.attempted.v1 (payment_status initiated|failed) |
 *             'authorized' → payment.authorized.v1 (payment_status authorized)
 */
export function mapGokwikPayment(
  record: GokwikPaymentRecord,
  brandId: string,
  saltHex: string,
  _regionCode: string,
  kind: 'attempted' | 'authorized',
  dataSource: DataSource = 'real',
): MappedGokwikPaymentEvent {
  const orderId = firstField(record, ORDER_ID_KEYS);
  if (!orderId) {
    throw new Error('[gokwik-mapper] payment record missing order_id');
  }

  const eventName = kind === 'authorized' ? PAYMENT_AUTHORIZED_V1_EVENT_NAME : PAYMENT_ATTEMPTED_V1_EVENT_NAME;
  const occurredAt = resolveOccurredAt(record);
  const occurredAtMs = new Date(occurredAt).getTime();

  let paymentStatus: 'initiated' | 'failed' | 'authorized';
  if (kind === 'authorized') {
    paymentStatus = 'authorized';
  } else {
    const raw = (record.payment_status ?? record.status ?? '').toLowerCase();
    paymentStatus = raw.includes('fail') ? 'failed' : 'initiated';
  }

  const rawPaymentId = firstField(record, PAYMENT_ID_KEYS);
  const paymentIdHash = rawPaymentId ? hashPaymentId(rawPaymentId, saltHex) : null;
  const amountMinor = tryDecimalToMinor(firstField(record, AMOUNT_KEYS));

  const properties: GokwikPaymentProperties = {
    source: 'gokwik',
    data_source: dataSource,
    order_id: orderId,
    payment_status: paymentStatus,
    payment_id_hash: paymentIdHash,
    currency_code: resolveCurrency(record),
    occurred_at: occurredAt,
    ...(amountMinor !== null ? { amount_minor: amountMinor.toString() } : {}),
  };

  return {
    event_name: eventName,
    event_id: uuidV5FromPayment(brandId, orderId, rawPaymentId ?? 'na', occurredAtMs, eventName),
    occurred_at: occurredAt,
    properties,
  };
}

// ── RTO-Predict mapper ─────────────────────────────────────────────────────────

/**
 * Map a raw GoKwik RTO-Predict record to a canonical Silver event.
 * The risk_flag is CATEGORICAL — recorded verbatim in risk_flag_raw + normalized into a closed set.
 * NEVER fabricate a numeric score (GoKwik does not expose one — research finding 1).
 */
export function mapGokwikRtoPredict(
  record: GokwikRtoPredictRecord,
  brandId: string,
  dataSource: DataSource = 'real',
): MappedGokwikRtoPredictEvent {
  const orderId = String(record.order_id ?? '').trim();
  if (!orderId) {
    throw new Error('[gokwik-mapper] RTO-Predict record missing order_id');
  }

  const occurredAt = new Date(record.occurred_at ?? new Date().toISOString()).toISOString();
  const riskFlagRaw = record.risk_flag != null ? String(record.risk_flag).trim() : null;

  const properties: GokwikRtoPredictProperties = {
    source: 'gokwik',
    data_source: dataSource,
    order_id: orderId,
    request_id: record.request_id != null ? String(record.request_id).trim() : null,
    risk_flag: normalizeRiskFlag(riskFlagRaw),
    risk_flag_raw: riskFlagRaw,
    risk_reason: record.risk_reason != null ? String(record.risk_reason) : null,
    occurred_at: occurredAt,
  };

  return {
    event_name: GOKWIK_RTO_PREDICT_V1_EVENT_NAME,
    occurred_at: occurredAt,
    properties,
  };
}
