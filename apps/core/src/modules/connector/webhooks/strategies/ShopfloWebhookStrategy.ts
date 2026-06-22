/**
 * ShopfloWebhookStrategy — per-provider Strategy for the WebhookPipeline.
 *
 * signatureVerify:
 *   Parses JSON body early to extract merchant_id (lookup key).
 *   Validates hex(HMAC-SHA256(rawBody, webhookSecret)) against configurable header.
 *   Byte-compatible with legacy ShopfloHmac.validateWebhook() + signatureHeaderName().
 *
 * payloadMap:
 *   checkout_abandoned → mapShopfloCheckoutAbandoned → emit to live lane.
 *   Unknown events → fast-ack (skip=true).
 *   dedup key = uuidV5FromShopfloCheckout(brandId, checkout_id, occurred_at).
 *   Age check via occurred_at (ISO-8601 → seconds).
 */

import type { FastifyRequest } from 'fastify';
import type { IWebhookStrategy, SignatureVerifyResult, PayloadMapResult, WebhookStrategyContext } from '../platform/IWebhookStrategy.js';
import { buildShopfloHmacConfig } from '../platform/HmacConfig.js';
import {
  mapShopfloCheckoutAbandoned,
  uuidV5FromShopfloCheckout,
  SHOPFLO_CHECKOUT_ABANDONED_V1_EVENT_NAME,
  type ShopfloCheckoutAbandonedPayload,
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
    const { parsedBody, brandId, saltHex } = ctx;
    const envelope = parsedBody as ShopfloWebhookEnvelope;
    const eventName = typeof envelope.event === 'string' ? envelope.event : '';

    if (eventName !== 'checkout_abandoned') {
      return { eventId: '', eventName, occurredAt: '', properties: {}, ageCheckTimestampSeconds: null, dedupKey: null, skip: true };
    }

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
      'IN',
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
}
