/**
 * WooCommerceWebhookStrategy — per-provider Strategy for the WebhookPipeline.
 *
 * signatureVerify:
 *   Lookup key = X-WC-Webhook-Source (normalised, trailing-slash stripped).
 *   Validates base64(HMAC-SHA256(rawBody, webhookSecret)) == X-WC-Webhook-Signature.
 *   Byte-compatible with legacy WooCommerceHmac.validateWebhook(). Fail-closed: a missing/invalid
 *   secret or signature → HMAC_INVALID (no spoofed events admitted).
 *
 * payloadMap (FULL RESOURCE COVERAGE — the orders-only gap is closed):
 *   The WooCommerce topic is the `X-WC-Webhook-Topic` header (resource.event dot-form). Each topic is
 *   mapped to the SAME canonical event the backfill fetchers + Shopify emit, so one downstream code
 *   path serves both storefronts and both lanes (live webhook + resumable backfill):
 *     order.created   / order.updated   → order.live.v1     (mapWooOrderToEvent — FROZEN; refunds fold
 *                                                             into recognition exactly as before)
 *     order.refunded                    → refund.recorded.v1 (newest refund in the order's refunds[])
 *     customer.created/ customer.updated → customer.upsert.v1 (mapWooCustomerToDraft — hashed PII only)
 *     product.created / product.updated → product.upsert.v1  (mapWooProductToDraft)
 *     coupon.created  / coupon.updated  → coupon.upsert.v1   (mapWooCouponToDraft — NEW grain)
 *     *.deleted                         → fast-ack skip (no canonical hard-delete grain downstream;
 *                                          soft-state is carried via `status` on the upsert event)
 *     unknown / registration-ping / id-less payloads → fast-ack skip (no event loss, no 400 retry-storm)
 *
 * LIVE↔BACKFILL DEDUP PARITY (no duplicate ingestion):
 *   For the NEW resource grains the event_id is derived with the framework's
 *   `deterministicDedupKeyDeriver` over the SAME (brand, provider, resource, providerId, eventName)
 *   namespace the resumable backfill driver uses — so a product/customer/coupon/refund seen on BOTH
 *   the live webhook and a backfill page derives one byte-identical event_id → Bronze MERGE drops the
 *   replay. (The order lane keeps its FROZEN uuidV5FromOrderLive id, unchanged.)
 *
 * STORE CURRENCY (MONEY DISCIPLINE — no INR default, ever):
 *   product/customer/coupon webhook payloads do NOT carry a currency (only orders do). The store
 *   currency is resolved via the OPTIONAL injected `resolveStoreCurrency(brandId)` (mirrors Shopify's
 *   injected resolveHmacSecret). When it is not wired the currency is null and the mappers emit honest
 *   nulls for the money fields (price_minor / amount_minor / total_spent_minor) while still surfacing
 *   the catalogue/identity metadata — NEVER a guessed currency. The /wc/v3 backfill (which knows the
 *   store currency) restates the same state with priced money under the identical event_id.
 *
 * No provider-level age check (WooCommerce has no event timestamp in the envelope) → idempotency is
 * carried entirely by the deterministic event_id + Bronze MERGE (no-event-loss invariant).
 */

import type { FastifyRequest } from 'fastify';
import type { IWebhookStrategy, SignatureVerifyResult, PayloadMapResult, WebhookStrategyContext } from '../platform/IWebhookStrategy.js';
import { WOOCOMMERCE_HMAC_CONFIG } from '../platform/HmacConfig.js';
import {
  mapWooOrderToEvent,
  mapWooCustomerToDraft,
  mapWooProductToDraft,
  mapWooCouponToDraft,
  mapWooOrderRefundsToDrafts,
  uuidV5FromOrderLive,
  ORDER_LIVE_V1_EVENT_NAME,
  WOOCOMMERCE_PROVIDER,
  WOOCOMMERCE_CUSTOMERS_RESOURCE,
  WOOCOMMERCE_PRODUCTS_RESOURCE,
  WOOCOMMERCE_COUPONS_RESOURCE,
  WOOCOMMERCE_REFUNDS_RESOURCE,
  type WooOrderShape,
  type WooCustomerShape,
  type WooProductShape,
  type WooCouponShape,
  type MappedResourceRecord,
} from '@brain/woocommerce-mapper';
import { deterministicDedupKeyDeriver, type ResourceDescriptor } from '@brain/connector-core';
import { incrementCounter } from '@brain/observability';

// ── Topic sets (WooCommerce `X-WC-Webhook-Topic` is resource.event dot-form) ──────────────────────
const ORDER_UPSERT_TOPICS = new Set(['order.created', 'order.updated']);
const CUSTOMER_UPSERT_TOPICS = new Set(['customer.created', 'customer.updated']);
const PRODUCT_UPSERT_TOPICS = new Set(['product.created', 'product.updated']);
const COUPON_UPSERT_TOPICS = new Set(['coupon.created', 'coupon.updated']);
/** Not a native Woo topic; handled if a merchant registers a custom action topic for refunds. */
const ORDER_REFUNDED_TOPIC = 'order.refunded';
/** No canonical hard-delete grain downstream → fast-acked. Subscribed for forward-compatibility. */
const DELETE_TOPICS = new Set(['order.deleted', 'customer.deleted', 'product.deleted', 'coupon.deleted']);

/** Uniform fast-ack (HTTP 200, no Kafka produce). */
const SKIP: PayloadMapResult = {
  eventId: '',
  eventName: '',
  occurredAt: '',
  properties: {},
  ageCheckTimestampSeconds: null,
  dedupKey: null,
  skip: true,
};

export class WooCommerceWebhookStrategy implements IWebhookStrategy {
  readonly provider = 'woocommerce';

  /**
   * @param resolveStoreCurrency OPTIONAL — resolves the brand's WooCommerce store currency (ISO-4217)
   *   for the resource mappers that have no currency in their webhook payload (product/customer/coupon).
   *   Injected by the composition root (registerWebhookRoutes) with access to the connector config /
   *   the wc/v3 /settings/general `woocommerce_currency`. Omitted by the pure payloadMap unit tests and
   *   until wired → currency resolves to null (the mappers emit honest-null money, never a guessed code).
   */
  constructor(
    private readonly resolveStoreCurrency?: (brandId: string) => Promise<string | null>,
  ) {}

  async signatureVerify(
    rawBody: Buffer,
    headers: FastifyRequest['headers'],
    getSecret: (lookupKey: string) => Promise<{ webhookSecret: string; connectorLookupKey: string }>,
  ): Promise<SignatureVerifyResult> {
    const sourceUrl = (headers['x-wc-webhook-source'] as string | undefined)?.trim() ?? '';
    const normalizedSource = sourceUrl.replace(/\/+$/, '');
    if (!normalizedSource) {
      const err = new Error('X-WC-Webhook-Source header missing');
      (err as NodeJS.ErrnoException & { code: string }).code = 'HMAC_INVALID';
      throw err;
    }

    const signatureHeader = (headers[WOOCOMMERCE_HMAC_CONFIG.header] as string | undefined) ?? '';
    const { webhookSecret } = await getSecret(normalizedSource);

    if (!webhookSecret || !WOOCOMMERCE_HMAC_CONFIG.validateWebhook(rawBody, signatureHeader, webhookSecret)) {
      incrementCounter('connector_auth_rejected_total', { provider: 'woocommerce' });
      const err = new Error('HMAC validation failed');
      (err as NodeJS.ErrnoException & { code: string }).code = 'HMAC_INVALID';
      throw err;
    }

    return { lookupKey: normalizedSource, parsedPayload: null };
  }

  async payloadMap(ctx: WebhookStrategyContext): Promise<PayloadMapResult> {
    const { rawBody, headers, brandId, saltHex, regionCode } = ctx;
    const region = regionCode ?? 'IN';

    const topic = (headers['x-wc-webhook-topic'] as string | undefined)?.trim() ?? '';

    // Delete topics + anything we don't handle → fast-ack (no event loss; no canonical delete grain).
    if (DELETE_TOPICS.has(topic)) return SKIP;
    const handled =
      ORDER_UPSERT_TOPICS.has(topic) ||
      CUSTOMER_UPSERT_TOPICS.has(topic) ||
      PRODUCT_UPSERT_TOPICS.has(topic) ||
      COUPON_UPSERT_TOPICS.has(topic) ||
      topic === ORDER_REFUNDED_TOPIC;
    if (!handled) return SKIP;

    // Parse once. WooCommerce delivers the resource object directly as the body (not wrapped).
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
    } catch {
      const err = new Error('Webhook body is not valid JSON');
      (err as NodeJS.ErrnoException & { code: string }).code = 'INVALID_JSON';
      throw err;
    }

    // ── Orders (FROZEN path) → order.live.v1 ──────────────────────────────────────────────────────
    if (ORDER_UPSERT_TOPICS.has(topic)) {
      return this.mapOrder(body as unknown as WooOrderShape, brandId, saltHex, region);
    }

    // ── Refunds (newest refund in the order's refunds[]) → refund.recorded.v1 ─────────────────────
    if (topic === ORDER_REFUNDED_TOPIC) {
      return this.mapRefund(body as unknown as WooOrderShape, brandId);
    }

    // ── Resource grains needing the store currency (no currency in these payloads) ────────────────
    let currencyCode: string | null = null;
    if (this.resolveStoreCurrency) {
      try {
        currencyCode = await this.resolveStoreCurrency(brandId);
      } catch {
        currencyCode = null; // never crash the webhook into a 500 — emit honest-null money
      }
    }

    if (CUSTOMER_UPSERT_TOPICS.has(topic)) {
      if (!hasId(body)) return SKIP;
      const record = mapWooCustomerToDraft(
        body as unknown as WooCustomerShape,
        brandId,
        saltHex,
        region,
        currencyCode ?? undefined,
      );
      return resourceResult(record, brandId, WOOCOMMERCE_CUSTOMERS_RESOURCE);
    }

    if (PRODUCT_UPSERT_TOPICS.has(topic)) {
      if (!hasId(body)) return SKIP;
      const record = mapWooProductToDraft(body as unknown as WooProductShape, brandId, currencyCode ?? '');
      return resourceResult(record, brandId, WOOCOMMERCE_PRODUCTS_RESOURCE);
    }

    if (COUPON_UPSERT_TOPICS.has(topic)) {
      if (!hasId(body)) return SKIP;
      const record = mapWooCouponToDraft(body as unknown as WooCouponShape, brandId, currencyCode ?? '');
      return resourceResult(record, brandId, WOOCOMMERCE_COUPONS_RESOURCE);
    }

    return SKIP;
  }

  // ── Order → order.live.v1 (FROZEN id: uuidV5FromOrderLive) ───────────────────────────────────────
  private mapOrder(order: WooOrderShape, brandId: string, saltHex: string, region: string): PayloadMapResult {
    if (order.id === undefined || order.id === null || String(order.id).length === 0) {
      // id-less delivery (e.g. the registration ping) → fast-ack rather than 400-retry-storm.
      return SKIP;
    }

    let mapped;
    try {
      mapped = mapWooOrderToEvent(order, brandId, saltHex, region, 'real');
    } catch {
      const err = new Error('Order could not be mapped');
      (err as NodeJS.ErrnoException & { code: string }).code = 'INVALID_PAYLOAD';
      throw err;
    }

    const orderId = String(order.id);
    const updatedAtMs = Date.parse(mapped.occurred_at);
    const eventId = uuidV5FromOrderLive(brandId, orderId, updatedAtMs);

    return {
      eventId,
      eventName: ORDER_LIVE_V1_EVENT_NAME,
      occurredAt: mapped.occurred_at,
      properties: mapped.properties as unknown as Record<string, unknown>,
      ageCheckTimestampSeconds: null, // WooCommerce has no provider-level event timestamp
      dedupKey: null,
      skip: false,
    };
  }

  // ── order.refunded → refund.recorded.v1 (newest refund) ──────────────────────────────────────────
  //
  // The pipeline emits ONE event per webhook. A WooCommerce refund action creates exactly one refund
  // (it is appended to the order's refunds[]), so the NEWEST refund is the one this delivery is about.
  // Each refund carries a globally-unique id → a deterministic event_id, so the lossless /orders/<id>
  // /refunds backfill and this real-time signal converge in Bronze (no dup, no loss across lanes).
  private mapRefund(order: WooOrderShape, brandId: string): PayloadMapResult {
    const drafts = mapWooOrderRefundsToDrafts(order, brandId);
    if (drafts.length === 0) return SKIP; // no refunds, or order missing currency → nothing to emit
    const record = drafts.reduce((newest, r) => (r.occurredAt > newest.occurredAt ? r : newest));
    return resourceResult(record, brandId, WOOCOMMERCE_REFUNDS_RESOURCE);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────────────────────────

function hasId(body: Record<string, unknown>): boolean {
  const id = body['id'];
  return id !== undefined && id !== null && String(id).length > 0;
}

/**
 * Project a framework MappedResourceRecord (its single draft) into a PayloadMapResult, deriving the
 * deterministic event_id with the SAME deriver the resumable backfill uses — so the live webhook and
 * the backfill page for the same record state produce one byte-identical Bronze id (dedup parity).
 */
function resourceResult(
  record: MappedResourceRecord,
  brandId: string,
  resource: ResourceDescriptor,
): PayloadMapResult {
  const draft = record.events[0];
  if (!draft) return SKIP;
  const eventId = deterministicDedupKeyDeriver.deriveEventId({
    brandId,
    provider: WOOCOMMERCE_PROVIDER,
    resource,
    providerId: record.providerId,
    eventName: draft.event_name,
  });
  return {
    eventId,
    eventName: draft.event_name,
    occurredAt: draft.occurred_at,
    properties: draft.properties as unknown as Record<string, unknown>,
    ageCheckTimestampSeconds: null,
    dedupKey: eventId,
    skip: false,
  };
}
