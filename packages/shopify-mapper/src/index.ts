/**
 * @brain/shopify-mapper — Frozen shared mapper package (ADR-LV-0 / D-12).
 *
 * FROZEN API — do not change after A0 commit without Architect sign-off.
 *
 * Exports:
 *   mapOrderToEvent        — raw Shopify order → MappedOrderEvent (hashed PII only)
 *   decimalStringToMinor   — Shopify price string → BigInt minor units (I-S07)
 *   uuidV5FromOrderBackfill — deterministic event_id for backfill (unchanged semantics)
 *   uuidV5FromOrderLive    — NEW: per-state deterministic event_id for live events (D-6)
 *   ORDER_LIVE_V1_EVENT_NAME — 'order.live.v1' event name constant
 *   OrderLivePropertiesSchema / OrderLiveProperties — live event contract
 *   ShopifyOrderShape      — shared Shopify order input type
 *   MappedOrderEvent       — shared output type
 *
 * Source-of-truth for D-6:
 *   BACKFILL: sha256(brand:order:order.backfill.v1) → namespace ':order.backfill.v1' → ONE id/order
 *   LIVE:     sha256(brand:order:updatedAtMs:order.live.v1) → distinct per updated_at → new Bronze row per state
 *   These two namespaces are provably non-colliding.
 *
 * Money: integer arithmetic only, no parseFloat (I-S07).
 * PII: raw email/phone consumed here and DROPPED — only hashed identifiers in output (D-10/I-S02).
 */

import { createHash } from 'node:crypto';
import { hashIdentifier, normalizePhone } from '@brain/identity-core';

// ── Re-exported types used by both stream-worker (re-pull) and core (webhook) ─

export interface ShopifyOrderShape {
  id: number;
  name: string;
  created_at: string;
  processed_at: string | null;
  updated_at?: string | null;
  cancelled_at: string | null;
  currency: string;
  current_total_price: string;  // Shopify decimal string
  financial_status: string;
  fulfillment_status: string | null;
  gateway?: string | null;
  payment_gateway_names?: string[] | null;
  tags?: string | null;
  customer?: {
    id?: number;
    email?: string | null;
    phone?: string | null;
  } | null;
}

export interface MappedOrderEvent {
  /** Event name — 'order.backfill.v1' or 'order.live.v1' */
  event_name: string;
  /** occurred_at: processed_at ?? created_at for backfill; updated_at for live */
  occurred_at: string;
  /** Properties payload (hashed PII only) */
  properties: OrderProperties;
}

/** Shared properties shape for both backfill and live order events */
export interface OrderProperties {
  source: 'shopify';
  shopify_order_id: string;
  order_id: string;
  amount_minor: string;        // BIGINT-as-string (I-S07)
  currency_code: string;
  payment_method: 'cod' | 'prepaid';
  financial_status?: string;
  fulfillment_status?: string | null;
  cancelled_at?: string | null;
  hashed_customer_email?: string;
  hashed_customer_phone?: string;
  storefront_customer_id?: string;
}

// ── Event name constants ──────────────────────────────────────────────────────

/** Backfill event name (unchanged from packages/contracts) */
export const ORDER_BACKFILL_V1_EVENT_NAME = 'order.backfill.v1' as const;

/** Live event name — NEW (D-6) */
export const ORDER_LIVE_V1_EVENT_NAME = 'order.live.v1' as const;

// ── Money util (moved from shopify-backfill/money-utils.ts) ──────────────────

/**
 * Convert a Shopify decimal-string price to minor units (BigInt).
 * Integer arithmetic — no parseFloat (I-S07).
 *
 * @param str  Shopify price string (e.g. "1250.00", "999", "15.5")
 * @returns    Amount in minor units as BigInt (e.g. 125000n, 99900n, 1550n)
 * @throws     Error if the input is not a valid non-negative decimal with ≤2 decimal places
 */
export function decimalStringToMinor(str: string): bigint {
  const trimmed = str.trim();

  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    throw new Error(
      `[shopify-mapper] decimalStringToMinor: invalid price string "${trimmed}" — ` +
      `expected non-negative decimal with at most 2 decimal places (I-S07)`,
    );
  }

  const dotIdx = trimmed.indexOf('.');
  if (dotIdx === -1) {
    return BigInt(trimmed) * 100n;
  }

  const wholePart = trimmed.slice(0, dotIdx);
  const fracPart = trimmed.slice(dotIdx + 1);
  const fracPadded = fracPart.padEnd(2, '0');

  return BigInt(wholePart) * 100n + BigInt(fracPadded);
}

// ── UUID utils (moved from shopify-backfill/uuid-utils.ts) ───────────────────

/**
 * Format the first 16 bytes of a sha256 hash as a UUIDv5-shaped string.
 * Sets version nibble = 5 and RFC-4122 variant bits.
 * This is the same algorithm used by the original uuid-utils.ts (I-ST04).
 */
function hashToUuidShaped(input: string): string {
  const hash = createHash('sha256').update(input, 'utf8').digest();
  const bytes = Buffer.alloc(16);
  hash.copy(bytes, 0, 0, 16);

  // Version nibble = 5
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  // Variant bits = RFC 4122 (10xx xxxx)
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/**
 * Deterministic event_id for a BACKFILLED Shopify order (unchanged semantics).
 * Input: sha256(`${brandId}:${shopifyOrderId}:order.backfill.v1`)
 * ONE id per (brand, order) — idempotent re-run dedup.
 *
 * @param brandId         Brand UUID (string)
 * @param shopifyOrderId  Shopify numeric order ID (string)
 */
export function uuidV5FromOrderBackfill(brandId: string, shopifyOrderId: string): string {
  return hashToUuidShaped(`${brandId}:${shopifyOrderId}:order.backfill.v1`);
}

/**
 * Deterministic event_id for a LIVE Shopify order event (D-6 / ADR-LV-6).
 * Input: sha256(`${brandId}:${orderId}:${updatedAtUtcMs}:order.live.v1`)
 *
 * DISTINCT from the backfill namespace (':order.live.v1' vs ':order.backfill.v1').
 * Distinct updated_at → distinct Bronze row (status changes land, not deduped).
 * Same updated_at retry → same id → Bronze ON CONFLICT DO NOTHING dedup.
 *
 * @param brandId         Brand UUID (string)
 * @param orderId         Shopify numeric order ID (string)
 * @param updatedAtUtcMs  new Date(order.updated_at).getTime() — milliseconds since epoch
 */
export function uuidV5FromOrderLive(
  brandId: string,
  orderId: string,
  updatedAtUtcMs: number,
): string {
  return hashToUuidShaped(`${brandId}:${orderId}:${updatedAtUtcMs}:order.live.v1`);
}

// ── COD detection (moved from order-mapper.ts) ────────────────────────────────

const COD_GATEWAYS = new Set([
  'cash_on_delivery', 'cod', 'cash', 'pay_on_delivery',
]);

const COD_GATEWAY_NAMES = [
  'cash on delivery', 'cod', 'pay on delivery', 'manual',
];

function classifyPaymentMethod(order: ShopifyOrderShape): 'cod' | 'prepaid' {
  const gateway = (order.gateway ?? '').toLowerCase();
  const gatewayNames = (order.payment_gateway_names ?? []).map((n) => n.toLowerCase());
  const financialStatus = (order.financial_status ?? '').toLowerCase();

  if (COD_GATEWAYS.has(gateway)) return 'cod';
  if (gatewayNames.some((n) => COD_GATEWAY_NAMES.some((c) => n.includes(c)))) return 'cod';
  if (financialStatus === 'pending') return 'cod';

  return 'prepaid';
}

// ── mapOrderToEvent (unified mapper for both backfill and live) ───────────────

/**
 * Map a raw Shopify order to a MappedOrderEvent.
 *
 * For BACKFILL: pass eventName='order.backfill.v1'; occurred_at = processed_at ?? created_at.
 * For LIVE:     pass eventName='order.live.v1';     occurred_at = updated_at ?? processed_at ?? created_at.
 *
 * @param order       Raw Shopify order
 * @param saltHex     Per-brand 64-char hex salt for PII hashing
 * @param regionCode  Brand region code (e.g. 'IN')
 * @param eventName   'order.backfill.v1' | 'order.live.v1'
 */
export function mapOrderToEvent(
  order: ShopifyOrderShape,
  saltHex: string,
  regionCode: string,
  eventName: typeof ORDER_BACKFILL_V1_EVENT_NAME | typeof ORDER_LIVE_V1_EVENT_NAME,
): MappedOrderEvent {
  // occurred_at: for live events use updated_at as the state's economic time (D-6 / ADR-LV-6)
  const rawOccurredAt =
    eventName === ORDER_LIVE_V1_EVENT_NAME
      ? (order.updated_at ?? order.processed_at ?? order.created_at)
      : (order.processed_at ?? order.created_at);

  const occurredAt = new Date(rawOccurredAt!).toISOString();

  const amountMinor = decimalStringToMinor(order.current_total_price);
  const paymentMethod = classifyPaymentMethod(order);

  // PII hashing at boundary — raw email/phone DROPPED after this scope (D-10 / I-S02)
  let hashedCustomerEmail: string | undefined;
  let hashedCustomerPhone: string | undefined;
  let storefrontCustomerId: string | undefined;

  const customer = order.customer;
  if (customer) {
    if (customer.email) {
      hashedCustomerEmail = hashIdentifier(customer.email, 'email', saltHex, regionCode);
    }
    if (customer.phone) {
      const { normalized } = normalizePhone(customer.phone, regionCode);
      hashedCustomerPhone = hashIdentifier(normalized, 'phone', saltHex, regionCode);
    }
    if (customer.id != null) {
      storefrontCustomerId = String(customer.id);
    }
    // customer object DROPPED here — raw PII never leaves this scope
  }

  const properties: OrderProperties = {
    source: 'shopify',
    shopify_order_id: String(order.id),
    order_id: String(order.id),
    amount_minor: amountMinor.toString(),
    currency_code: order.currency,
    payment_method: paymentMethod,
    financial_status: order.financial_status,
    fulfillment_status: order.fulfillment_status ?? null,
    cancelled_at: order.cancelled_at
      ? new Date(order.cancelled_at).toISOString()
      : null,
    ...(hashedCustomerEmail !== undefined ? { hashed_customer_email: hashedCustomerEmail } : {}),
    ...(hashedCustomerPhone !== undefined ? { hashed_customer_phone: hashedCustomerPhone } : {}),
    ...(storefrontCustomerId !== undefined ? { storefront_customer_id: storefrontCustomerId } : {}),
  };

  return { event_name: eventName, occurred_at: occurredAt, properties };
}

/**
 * Compute the achieved_depth_label from the oldest order's occurred_at (HP-3).
 * Moved here to keep the backfill run.ts import footprint from the shared package.
 */
export function computeAchievedDepthLabel(
  oldestOccurredAt: Date,
  targetWindowMs: number,
): string {
  const nowMs = Date.now();
  const oldestMs = oldestOccurredAt.getTime();
  const achievedMs = nowMs - oldestMs;
  const achievedMonths = Math.round(achievedMs / (1000 * 60 * 60 * 24 * 30));
  const targetMonths = Math.round(targetWindowMs / (1000 * 60 * 60 * 24 * 30));

  if (Math.abs(achievedMonths - targetMonths) <= 1) {
    return `${targetMonths} months`;
  }
  return `since store creation (${achievedMonths} months)`;
}
