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

import { hashToUuidShaped } from '@brain/connector-core';
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
  // ADDITIVE (feat-journey-touchpoint): the storefront pixel forwards the journey keys
  // into checkout note_attributes so the order webhook can read brain_anon_id BACK
  // (deterministic cart-stitch, D-5 — never inferred). Optional; absent on legacy orders.
  note_attributes?: Array<{ name?: string | null; value?: string | null }> | null;
  // ADDITIVE (feat-shopify-order-depth): the economic breakdown of the order. All optional —
  // absent on legacy/synthetic payloads and on the backfill path until the fetch fields are
  // widened. Shopify decimal strings throughout; the mapper converts to minor units (I-S07).
  line_items?: Array<{
    id?: number | null;
    sku?: string | null;
    title?: string | null;
    name?: string | null;
    quantity?: number | null;
    price?: string | null;           // per-UNIT price (decimal string)
    product_id?: number | null;
    variant_id?: number | null;
    total_discount?: string | null;  // line-level discount (decimal string)
  }> | null;
  tax_lines?: Array<{ title?: string | null; rate?: number | null; price?: string | null }> | null;
  total_tax?: string | null;         // order tax total (decimal string)
  shipping_lines?: Array<{ title?: string | null; price?: string | null }> | null;
  total_discounts?: string | null;   // order discount total (decimal string)
  discount_codes?: Array<{ code?: string | null; amount?: string | null; type?: string | null }> | null;
  refunds?: Array<{
    id?: number | null;
    created_at?: string | null;
    processed_at?: string | null;
    note?: string | null;
    transactions?: Array<{ amount?: string | null; kind?: string | null; status?: string | null }> | null;
  }> | null;
}

/**
 * The deterministic journey-stitch projection read BACK from a Shopify order's
 * note_attributes (feat-journey-touchpoint §3). NOT inferred (D-5) — these are the exact
 * keys the storefront pixel wrote at checkout. All fields optional/honest-NULL.
 */
export interface OrderStitchProjection {
  /** brain_anon_id read back from note_attributes — the anon journey key. */
  stitchedAnonId: string | null;
  clickIds: { fbclid?: string; gclid?: string; ttclid?: string } | null;
  utms: { source?: string; medium?: string; campaign?: string; term?: string; content?: string } | null;
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
  // ── Journey-stitch key (read BACK from note_attributes, D-5) — the anon journey id the storefront
  // pixel wrote at checkout. Carried on the order event so the LIVE/REPULL lane can write the
  // order→anon stitch map (previously only the webhook did → repull'd orders never stitched).
  stitched_anon_id?: string;
  // ── ADDITIVE (feat-shopify-order-depth): order economic breakdown ──────────────
  // All optional + minor-units (BIGINT-as-string, I-S07). Present only when the source order
  // carried the detail (live webhook always does; backfill once the fetch fields are widened).
  // These nest as plain JSONB under payload.properties — no Bronze migration.
  line_items?: OrderLineItem[];
  tax_total_minor?: string;
  tax_lines?: OrderTaxLine[];
  shipping_total_minor?: string;
  discount_total_minor?: string;
  discount_codes?: OrderDiscountCode[];
  refunds?: OrderRefund[];
  refund_total_minor?: string;
}

/** One product line on an order (feat-shopify-order-depth). PII-free. */
export interface OrderLineItem {
  sku: string | null;
  title: string | null;
  quantity: number;
  unit_price_minor: string;   // per-unit (I-S07)
  line_total_minor: string;   // unit_price_minor * quantity − line discount
  line_discount_minor: string;
  product_id: string | null;
  variant_id: string | null;
}

/** One tax line on an order. */
export interface OrderTaxLine {
  title: string | null;
  rate: number | null;        // fractional rate, e.g. 0.18
  amount_minor: string;
}

/** One discount code applied to an order. */
export interface OrderDiscountCode {
  code: string | null;
  amount_minor: string;
  type: string | null;
}

/** One refund against an order (sum of its refund transactions). */
export interface OrderRefund {
  refund_id: string | null;
  processed_at: string | null;  // ISO-8601
  amount_minor: string;
  reason: string | null;
}

// ── Event name constants ──────────────────────────────────────────────────────
// Defined in the leaf module ./event-names.ts to keep them out of the
// index <-> manifest <-> resources import cycle (ESM TDZ). Imported for local use
// (typeof references below) AND re-exported so external consumers are unchanged.

import { ORDER_BACKFILL_V1_EVENT_NAME, ORDER_LIVE_V1_EVENT_NAME } from './event-names.js';
export { ORDER_BACKFILL_V1_EVENT_NAME, ORDER_LIVE_V1_EVENT_NAME };

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

/**
 * Resilient variant of decimalStringToMinor for the OPTIONAL depth fields (feat-shopify-order-depth):
 * returns null instead of throwing on a missing/malformed value, so one bad line-item price never
 * fails the whole order map. The core amount_minor still uses the strict throwing variant.
 */
export function tryDecimalToMinor(str: string | null | undefined): bigint | null {
  if (str == null) return null;
  try {
    return decimalStringToMinor(str);
  } catch {
    return null;
  }
}

// ── UUID utils (moved from shopify-backfill/uuid-utils.ts) ───────────────────

/**
 * hashToUuidShaped — now the SHARED kernel util (@brain/connector-core). The byte layout is
 * identical to the prior local copy, so deterministic event_ids are unchanged (I-ST04).
 *
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

// ── Order depth projection (feat-shopify-order-depth) ─────────────────────────

/**
 * Project the economic breakdown of a Shopify order — line items, tax, shipping, discounts,
 * refunds — into PII-free, minor-units output. Every piece is independently resilient: a malformed
 * sub-field is skipped (tryDecimalToMinor → null), never throwing, so depth never breaks the core
 * order map. Returns only the keys that have data (so legacy/synthetic orders stay flat).
 */
export function projectOrderDepth(order: ShopifyOrderShape): Partial<OrderProperties> {
  const out: Partial<OrderProperties> = {};

  // ── Line items ──────────────────────────────────────────────────────────────
  if (Array.isArray(order.line_items) && order.line_items.length > 0) {
    const items: OrderLineItem[] = [];
    for (const li of order.line_items) {
      const unit = tryDecimalToMinor(li.price);
      const qty = typeof li.quantity === 'number' && li.quantity >= 0 ? li.quantity : 0;
      if (unit === null) continue; // can't price the line → skip it (don't fabricate)
      const lineDiscount = tryDecimalToMinor(li.total_discount) ?? 0n;
      const lineTotal = unit * BigInt(qty) - lineDiscount;
      items.push({
        sku: li.sku ?? null,
        title: li.title ?? li.name ?? null,
        quantity: qty,
        unit_price_minor: unit.toString(),
        line_total_minor: lineTotal.toString(),
        line_discount_minor: lineDiscount.toString(),
        product_id: li.product_id != null ? String(li.product_id) : null,
        variant_id: li.variant_id != null ? String(li.variant_id) : null,
      });
    }
    if (items.length > 0) out.line_items = items;
  }

  // ── Tax ───────────────────────────────────────────────────────────────────────
  if (Array.isArray(order.tax_lines) && order.tax_lines.length > 0) {
    const taxes: OrderTaxLine[] = [];
    for (const t of order.tax_lines) {
      const amt = tryDecimalToMinor(t.price);
      if (amt === null) continue;
      taxes.push({ title: t.title ?? null, rate: typeof t.rate === 'number' ? t.rate : null, amount_minor: amt.toString() });
    }
    if (taxes.length > 0) out.tax_lines = taxes;
  }
  const taxTotal = tryDecimalToMinor(order.total_tax);
  if (taxTotal !== null) out.tax_total_minor = taxTotal.toString();

  // ── Shipping (sum of shipping_lines) ──────────────────────────────────────────
  if (Array.isArray(order.shipping_lines) && order.shipping_lines.length > 0) {
    let ship = 0n;
    let any = false;
    for (const s of order.shipping_lines) {
      const p = tryDecimalToMinor(s.price);
      if (p !== null) { ship += p; any = true; }
    }
    if (any) out.shipping_total_minor = ship.toString();
  }

  // ── Discounts ───────────────────────────────────────────────────────────────
  const discTotal = tryDecimalToMinor(order.total_discounts);
  if (discTotal !== null) out.discount_total_minor = discTotal.toString();
  if (Array.isArray(order.discount_codes) && order.discount_codes.length > 0) {
    const codes: OrderDiscountCode[] = [];
    for (const d of order.discount_codes) {
      const amt = tryDecimalToMinor(d.amount) ?? 0n;
      codes.push({ code: d.code ?? null, amount_minor: amt.toString(), type: d.type ?? null });
    }
    if (codes.length > 0) out.discount_codes = codes;
  }

  // ── Refunds (each = sum of its refund transactions) ───────────────────────────
  if (Array.isArray(order.refunds) && order.refunds.length > 0) {
    const refunds: OrderRefund[] = [];
    let refundTotal = 0n;
    for (const r of order.refunds) {
      let amt = 0n;
      for (const tx of r.transactions ?? []) {
        // Count settled refund/sale transactions; ignore voided/failed.
        const kind = (tx.kind ?? '').toLowerCase();
        const status = (tx.status ?? 'success').toLowerCase();
        if (kind !== 'refund' && kind !== 'sale') continue;
        if (status !== 'success' && status !== 'pending') continue;
        amt += tryDecimalToMinor(tx.amount) ?? 0n;
      }
      refundTotal += amt;
      refunds.push({
        refund_id: r.id != null ? String(r.id) : null,
        processed_at: (r.processed_at ?? r.created_at) ? new Date((r.processed_at ?? r.created_at) as string).toISOString() : null,
        amount_minor: amt.toString(),
        reason: r.note ?? null,
      });
    }
    if (refunds.length > 0) {
      out.refunds = refunds;
      out.refund_total_minor = refundTotal.toString();
    }
  }

  return out;
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
    // ADDITIVE (feat-shopify-order-depth): merge the economic breakdown when the order carries it.
    ...projectOrderDepth(order),
    // Journey-stitch (D-5): carry the anon journey key read back from note_attributes, so the
    // live/repull lane can write the order→anon stitch (honest-absent when the pixel didn't tag).
    ...(projectOrderStitch(order).stitchedAnonId
      ? { stitched_anon_id: projectOrderStitch(order).stitchedAnonId as string }
      : {}),
  };

  return { event_name: eventName, occurred_at: occurredAt, properties };
}

/**
 * Project the deterministic journey-stitch keys read BACK from a Shopify order's
 * note_attributes (feat-journey-touchpoint §3 / D-5 — read-back, NEVER inferred).
 *
 * The storefront pixel writes these note_attributes at checkout:
 *   brain_anon_id, utm_source/medium/campaign/term/content, fbclid/gclid/ttclid.
 * We read them back verbatim. Missing keys → honest NULL (anon not captured → no stitch).
 *
 * @param order Raw Shopify order (must carry note_attributes if a stitch is possible)
 */
export function projectOrderStitch(order: ShopifyOrderShape): OrderStitchProjection {
  const attrs = order.note_attributes ?? [];
  const get = (name: string): string | undefined => {
    const hit = attrs.find((a) => a?.name === name);
    const v = hit?.value;
    return v != null && v !== '' ? v : undefined;
  };

  const stitchedAnonId = get('brain_anon_id') ?? null;

  const fbclid = get('fbclid');
  const gclid = get('gclid');
  const ttclid = get('ttclid');
  const clickIds =
    fbclid || gclid || ttclid
      ? { ...(fbclid ? { fbclid } : {}), ...(gclid ? { gclid } : {}), ...(ttclid ? { ttclid } : {}) }
      : null;

  const source = get('utm_source');
  const medium = get('utm_medium');
  const campaign = get('utm_campaign');
  const term = get('utm_term');
  const content = get('utm_content');
  const utms =
    source || medium || campaign || term || content
      ? {
          ...(source ? { source } : {}),
          ...(medium ? { medium } : {}),
          ...(campaign ? { campaign } : {}),
          ...(term ? { term } : {}),
          ...(content ? { content } : {}),
        }
      : null;

  return { stitchedAnonId, clickIds, utms };
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

// ── ADDITIVE (ingestion-framework onboarding) ─────────────────────────────────
// The Shopify IngestionManifest + the pure mappers for the ADDITIONAL resources (products,
// customers, refunds, fulfillments) onboarded onto @brain/connector-core's resumable backfill
// driver. These are purely additive re-exports — the FROZEN order API above is unchanged.

export {
  SHOPIFY_PROVIDER,
  SHOPIFY_MANIFEST,
  SHOPIFY_ORDERS_RESOURCE,
  SHOPIFY_PRODUCTS_RESOURCE,
  SHOPIFY_CUSTOMERS_RESOURCE,
  SHOPIFY_REFUNDS_RESOURCE,
  SHOPIFY_FULFILLMENTS_RESOURCE,
} from './manifest.js';

export {
  PRODUCT_UPSERT_V1_EVENT_NAME,
  CUSTOMER_UPSERT_V1_EVENT_NAME,
  REFUND_RECORDED_V1_EVENT_NAME,
  FULFILLMENT_RECORDED_V1_EVENT_NAME,
  mapProductToDraft,
  mapCustomerToDraft,
  mapRefundToDraft,
  mapFulfillmentToDraft,
} from './resources.js';

export type {
  MappedResourceRecord,
  ShopifyProductShape,
  ShopifyProductVariant,
  ProductUpsertProperties,
  ShopifyCustomerShape,
  CustomerUpsertProperties,
  ShopifyRefundShape,
  ShopifyRefundTxn,
  RefundRecordedProperties,
  ShopifyFulfillmentShape,
  FulfillmentRecordedProperties,
} from './resources.js';
