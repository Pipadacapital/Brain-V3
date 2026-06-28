/**
 * ShopfloWebhookStrategy — per-provider Strategy for the WebhookPipeline.
 *
 * signatureVerify:
 *   Parses JSON body early to extract merchant_id (lookup key).
 *   Validates hex(HMAC-SHA256(rawBody, webhookSecret)) against configurable header.
 *   Byte-compatible with legacy ShopfloHmac.validateWebhook() + signatureHeaderName().
 *
 * payloadMap (SLICE B — full dispatch table over the whole Shopflo event set):
 *   order.*                         → mapShopfloOrder        → order.live.v1 (THE order-source fix → Gold revenue).
 *   refund.* (non-order)            → mapShopfloRefund       → refund.recorded.v1.
 *   checkout_abandoned (legacy)     → mapShopfloCheckoutAbandoned → shopflo.checkout_abandoned.v1 (frozen lane).
 *   checkout.started/step/completed → mapShopfloCheckout     → shopflo.checkout_started|step|completed.v1.
 *   payment.attempted/authorized    → mapShopfloPayment      → payment.attempted|authorized.v1.
 *   Unknown events                  → fast-ack (skip=true) — never rejected (no event loss).
 *   HMAC failure → 401. dedup key = the deterministic per-event event_id.
 */

import type { FastifyRequest } from 'fastify';
import type { IWebhookStrategy, SignatureVerifyResult, PayloadMapResult, WebhookStrategyContext } from '../platform/IWebhookStrategy.js';
import { buildShopfloHmacConfig } from '../platform/HmacConfig.js';
import {
  mapShopfloCheckoutAbandoned,
  mapShopfloOrder,
  mapShopfloRefund,
  mapShopfloPayment,
  mapShopfloCheckout,
  uuidV5FromShopfloCheckout,
  SHOPFLO_CHECKOUT_ABANDONED_V1_EVENT_NAME,
  type ShopfloCheckoutAbandonedPayload,
  type ShopfloCheckoutFunnelKind,
} from '@brain/shopflo-mapper';
import { incrementCounter } from '@brain/observability';

const SHOPFLO_REPLAY_WINDOW_SECONDS = 5 * 60;

interface ShopfloWebhookEnvelope {
  merchant_id?: string;
  event?: string;
  checkout_id?: string;
  occurred_at?: string;
  [key: string]: unknown;
}

/** A skipped (fast-ack) result for unknown/unmapped event types — never rejected (no event loss). */
function skipResult(eventName: string, occurredAt: string): PayloadMapResult {
  return { eventId: '', eventName, occurredAt, properties: {}, ageCheckTimestampSeconds: null, dedupKey: null, skip: true };
}

export class ShopfloWebhookStrategy implements IWebhookStrategy {
  readonly provider = 'shopflo';
  private readonly hmacConfig = buildShopfloHmacConfig();

  async signatureVerify(
    rawBody: Buffer,
    headers: FastifyRequest['headers'],
    getSecret: (lookupKey: string) => Promise<{ webhookSecret: string; connectorLookupKey: string }>,
  ): Promise<SignatureVerifyResult> {
    let envelope: ShopfloWebhookEnvelope;
    try {
      envelope = JSON.parse(rawBody.toString('utf8')) as ShopfloWebhookEnvelope;
    } catch {
      const err = new Error('Webhook body is not valid JSON');
      (err as NodeJS.ErrnoException & { code: string }).code = 'INVALID_JSON';
      throw err;
    }

    const merchantId = typeof envelope.merchant_id === 'string' ? envelope.merchant_id : '';
    if (!merchantId) {
      const err = new Error('merchant_id missing');
      (err as NodeJS.ErrnoException & { code: string }).code = 'HMAC_INVALID';
      throw err;
    }

    const signatureHeader = (headers[this.hmacConfig.header] as string | undefined) ?? '';
    const { webhookSecret } = await getSecret(merchantId);

    if (!webhookSecret || !this.hmacConfig.validateWebhook(rawBody, signatureHeader, webhookSecret)) {
      incrementCounter('connector_auth_rejected_total', { provider: 'shopflo' });
      const err = new Error('HMAC validation failed');
      (err as NodeJS.ErrnoException & { code: string }).code = 'HMAC_INVALID';
      throw err;
    }

    return { lookupKey: merchantId, parsedPayload: envelope };
  }

  async payloadMap(ctx: WebhookStrategyContext): Promise<PayloadMapResult> {
    const { parsedBody, brandId, saltHex, regionCode } = ctx;
    const envelope = (parsedBody ?? {}) as ShopfloWebhookEnvelope;
    const rawEvent = typeof envelope.event === 'string' ? envelope.event : '';
    const t = rawEvent.toLowerCase().replace(/\s+/g, '_');
    const region = regionCode || 'IN';
    const nowIso = new Date().toISOString();
    const body = envelope as unknown as Record<string, unknown>;

    // ── Legacy abandoned lane → shopflo.checkout_abandoned.v1 (frozen mapper + parity-stable event_id) ──
    if (t === 'checkout_abandoned') {
      const checkoutId = typeof envelope.checkout_id === 'string' ? envelope.checkout_id : '';
      const occurredAt = typeof envelope.occurred_at === 'string' ? envelope.occurred_at : '';
      if (!checkoutId || !occurredAt) {
        const err = new Error('checkout_id or occurred_at missing');
        (err as NodeJS.ErrnoException & { code: string }).code = 'REPLAY_REJECTED';
        throw err;
      }
      const occurredAtMs = Date.parse(occurredAt);
      if (Number.isNaN(occurredAtMs)) {
        const err = new Error('occurred_at is not a valid timestamp');
        (err as NodeJS.ErrnoException & { code: string }).code = 'REPLAY_REJECTED';
        throw err;
      }
      const ageSeconds = Math.floor((Date.now() - occurredAtMs) / 1000);
      if (ageSeconds > SHOPFLO_REPLAY_WINDOW_SECONDS) {
        const err = new Error('Event too old — outside replay window');
        (err as NodeJS.ErrnoException & { code: string }).code = 'REPLAY_REJECTED';
        throw err;
      }
      const bronzeEventId = uuidV5FromShopfloCheckout(brandId, checkoutId, occurredAt);
      const mapped = mapShopfloCheckoutAbandoned(
        envelope as unknown as ShopfloCheckoutAbandonedPayload,
        brandId,
        saltHex,
        region,
        'real',
      );
      return {
        eventId: bronzeEventId,
        eventName: SHOPFLO_CHECKOUT_ABANDONED_V1_EVENT_NAME,
        occurredAt: mapped.occurred_at,
        properties: mapped.properties as unknown as Record<string, unknown>,
        ageCheckTimestampSeconds: Math.floor(occurredAtMs / 1000),
        dedupKey: bronzeEventId,
        skip: false,
      };
    }

    // ── Refund (standalone) → refund.recorded.v1. Checked before order.* so 'refund.created' routes here;
    //    'order.refunded' (prefixed order) flows through the order lane as a financial_status state change. ──
    if (t.startsWith('refund')) {
      const mapped = mapShopfloRefund(body, brandId, saltHex, region);
      return this.toResult(mapped.event_id, mapped.event_name, mapped.occurred_at, mapped.properties);
    }

    // ── Order lifecycle → order.live.v1 (THE fix: Shopflo becomes an order source → Gold revenue) ──
    if (t.startsWith('order')) {
      const mapped = mapShopfloOrder({ ...body, event_name: rawEvent }, brandId, saltHex, region);
      return this.toResult(mapped.event_id, mapped.event_name, mapped.occurred_at, mapped.properties);
    }

    // ── Payment funnel → payment.attempted.v1 / payment.authorized.v1 ──
    if (t.includes('payment') || t.includes('transaction')) {
      const authorized = t.includes('authoriz') || t.includes('captur') || t.includes('success') || t.includes('paid');
      const kind = authorized ? 'authorized' : 'attempted';
      const mapped = mapShopfloPayment(body, brandId, saltHex, region, kind);
      return this.toResult(mapped.event_id, mapped.event_name, mapped.occurred_at, mapped.properties);
    }

    // ── Checkout funnel → shopflo.checkout_started|step|completed.v1 (abandoned handled above) ──
    if (t.includes('checkout')) {
      let kind: ShopfloCheckoutFunnelKind | null = null;
      if (t.includes('complet')) kind = 'completed';
      else if (t.includes('step')) kind = 'step';
      else if (t.includes('start') || t.includes('init') || t.includes('creat')) kind = 'started';
      if (kind === null) return skipResult(rawEvent || 'shopflo.unknown', nowIso);
      const mapped = mapShopfloCheckout(body, brandId, saltHex, region, kind);
      return this.toResult(mapped.event_id, mapped.event_name, mapped.occurred_at, mapped.properties);
    }

    // Unknown / unmapped → fast-ack 200, no Kafka produce (no event loss, no junk in Bronze).
    return skipResult(rawEvent || 'shopflo.unknown', nowIso);
  }

  /** Build a PayloadMapResult from a canonical mapped event. Dedup keys off the deterministic eventId. */
  private toResult(
    eventId: string,
    eventName: string,
    occurredAt: string,
    properties: object,
  ): PayloadMapResult {
    return {
      eventId,
      eventName,
      occurredAt,
      properties: properties as Record<string, unknown>,
      // No trusted provider-timestamp guarantee for the lifecycle events → skip the age gate; the
      // deterministic eventId (per-state) is the dedup key (dedupKey null → pipeline uses eventId).
      ageCheckTimestampSeconds: null,
      dedupKey: null,
      skip: false,
    };
  }
}
