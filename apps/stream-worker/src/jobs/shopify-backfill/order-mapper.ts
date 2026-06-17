/**
 * order-mapper.ts — Maps a raw Shopify order to an OrderBackfillProperties payload.
 *
 * SECURITY CONTRACT (D-10 / I-S02):
 *   - Raw email, phone, name, and address fields are consumed ONLY for identity
 *     hashing and are then DROPPED. They never appear in the emitted event payload,
 *     Bronze row, or any log line.
 *   - Hashed identifiers are computed using @brain/identity-core hashIdentifier
 *     with the per-brand salt (the same salt used by the identity bridge).
 *
 * Money (D-13 / I-S07):
 *   - current_total_price (Shopify decimal string) → BigInt minor units
 *     via decimalStringToMinor (integer arithmetic, no parseFloat).
 *   - Emitted as a BIGINT-as-string (JSON doesn't support BigInt directly).
 *
 * occurred_at (D-6):
 *   - = Shopify order's processed_at ?? created_at — NOT NOW() at ingest.
 *   - This is the field the revenue-finalization job uses for horizon calculation.
 *
 * payment_method (ADR-BF-15):
 *   - Mapped from Shopify gateway/payment_gateway_names/financial_status.
 *   - COD signals: gateway includes 'cash_on_delivery' or 'cod', OR
 *     payment_gateway_names includes 'Cash on Delivery', OR financial_status='pending'.
 *   - Conservative: when ambiguous → 'cod' (longer horizon = safer for finalization).
 */

import { hashIdentifier, normalizePhone } from '@brain/identity-core';
import { decimalStringToMinor } from './money-utils.js';
import { ORDER_BACKFILL_V1_EVENT_NAME } from '@brain/contracts';
import type { OrderBackfillProperties } from '@brain/contracts';
import type { ShopifyBackfillOrder } from './shopify-paged-client.js';

export interface MappedBackfillEvent {
  /** event_name for the CollectorEventV1 envelope */
  event_name: typeof ORDER_BACKFILL_V1_EVENT_NAME;
  /** occurred_at for the CollectorEventV1 envelope (D-6: processed_at ?? created_at) */
  occurred_at: string;
  /** The typed properties payload */
  properties: OrderBackfillProperties;
}

const COD_GATEWAYS = new Set([
  'cash_on_delivery', 'cod', 'cash', 'pay_on_delivery',
]);

const COD_GATEWAY_NAMES = [
  'cash on delivery', 'cod', 'pay on delivery', 'manual',
];

/**
 * Determine payment_method from Shopify order fields (ADR-BF-15).
 * Conservative: ambiguous → 'cod' (COD horizon is larger, safer for finalization).
 */
function classifyPaymentMethod(order: ShopifyBackfillOrder): 'cod' | 'prepaid' {
  const gateway = (order.gateway ?? '').toLowerCase();
  const gatewayNames = (order.payment_gateway_names ?? []).map((n) => n.toLowerCase());
  const financialStatus = (order.financial_status ?? '').toLowerCase();

  if (COD_GATEWAYS.has(gateway)) return 'cod';
  if (gatewayNames.some((n) => COD_GATEWAY_NAMES.some((c) => n.includes(c)))) return 'cod';
  if (financialStatus === 'pending') return 'cod';

  return 'prepaid';
}

/**
 * Map a raw Shopify order to the BackfillEvent shape.
 *
 * @param order        Raw Shopify order object
 * @param saltHex      Per-brand 64-char hex salt (from SaltProvider) for PII hashing
 * @param regionCode   Brand region code (e.g. 'IN') for phone normalization
 * @returns            Typed BackfillEvent ready for Kafka production
 */
export function mapOrderToBackfillEvent(
  order: ShopifyBackfillOrder,
  saltHex: string,
  regionCode: string,
): MappedBackfillEvent {
  // ── occurred_at (D-6) ────────────────────────────────────────────────────────
  // Must be processed_at ?? created_at — NOT NOW().
  // This is the anchor for the revenue-finalization horizon calculation.
  const occurredAt = order.processed_at ?? order.created_at;
  // Ensure UTC ISO-8601 (Shopify returns timestamps with timezone offset)
  const occurredAtUtc = new Date(occurredAt).toISOString();

  // ── amount_minor (D-13 / I-S07) ──────────────────────────────────────────────
  const amountMinor = decimalStringToMinor(order.current_total_price);

  // ── payment_method (ADR-BF-15) ───────────────────────────────────────────────
  const paymentMethod = classifyPaymentMethod(order);

  // ── PII hashing at worker boundary (D-10 / I-S02) ────────────────────────────
  // Raw customer.email and customer.phone are consumed HERE and DROPPED.
  // Only the salted SHA-256 hashes enter the event payload.
  let hashedCustomerEmail: string | undefined;
  let hashedCustomerPhone: string | undefined;
  let storefrontCustomerId: string | undefined;

  const customer = order.customer;
  if (customer) {
    // Hash email if present
    if (customer.email) {
      hashedCustomerEmail = hashIdentifier(
        customer.email,
        'email',
        saltHex,
        regionCode,
      );
    }

    // Hash phone if present — normalize first (E.164, regionCode)
    if (customer.phone) {
      const { normalized } = normalizePhone(customer.phone, regionCode);
      hashedCustomerPhone = hashIdentifier(
        normalized,
        'phone',
        saltHex,
        regionCode,
      );
    }

    // Shopify customer ID (numeric platform ID — not a contact identifier, not PII)
    if (customer.id != null) {
      storefrontCustomerId = String(customer.id);
    }

    // customer object is DROPPED here — raw PII never leaves this scope (D-10)
  }

  // ── Build properties payload ──────────────────────────────────────────────────
  const properties: OrderBackfillProperties = {
    source: 'shopify',
    shopify_order_id: String(order.id),
    order_id: String(order.id),          // canonical order_id = shopify order id
    amount_minor: amountMinor.toString(), // BIGINT-as-string for JSON safety
    currency_code: order.currency,
    payment_method: paymentMethod,
    financial_status: order.financial_status,
    fulfillment_status: order.fulfillment_status ?? null,
    cancelled_at: order.cancelled_at
      ? new Date(order.cancelled_at).toISOString()
      : null,
    // Hashed identifiers — ONLY if present (D-10)
    ...(hashedCustomerEmail !== undefined ? { hashed_customer_email: hashedCustomerEmail } : {}),
    ...(hashedCustomerPhone !== undefined ? { hashed_customer_phone: hashedCustomerPhone } : {}),
    ...(storefrontCustomerId !== undefined ? { storefront_customer_id: storefrontCustomerId } : {}),
  };

  return {
    event_name: ORDER_BACKFILL_V1_EVENT_NAME,
    occurred_at: occurredAtUtc,
    properties,
  };
}

/**
 * Compute the achieved_depth_label from the oldest order's occurred_at (HP-3).
 *
 * @param oldestOccurredAt  Oldest processed_at seen in the backfill run
 * @param targetWindowMs    The target backfill window in ms (24 months)
 * @returns                 Honest label string
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

  // If achieved is within 1 month of target: label as the target
  if (Math.abs(achievedMonths - targetMonths) <= 1) {
    return `${targetMonths} months`;
  }

  // Store is younger than the target window: honest label with actual months
  return `since store creation (${achievedMonths} months)`;
}
