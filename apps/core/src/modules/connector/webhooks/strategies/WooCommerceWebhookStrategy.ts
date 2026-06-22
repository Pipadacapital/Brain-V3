/**
 * WooCommerceWebhookStrategy — per-provider Strategy for the WebhookPipeline.
 *
 * signatureVerify:
 *   Lookup key = X-WC-Webhook-Source (normalised, trailing-slash stripped).
 *   Validates base64(HMAC-SHA256(rawBody, webhookSecret)) == X-WC-Webhook-Signature.
 *   Byte-compatible with legacy WooCommerceHmac.validateWebhook().
 *
 * payloadMap:
 *   order.created / order.updated → mapWooOrderToEvent → emit via order.live.v1.
 *   Other topics → fast-ack (skip=true).
 *   dedup key = uuidV5FromOrderLive(brandId, orderId, updatedAtMs).
 *   No provider-level age check (WooCommerce has no event timestamp in envelope).
 */

import type { FastifyRequest } from 'fastify';
import type { IWebhookStrategy, SignatureVerifyResult, PayloadMapResult, WebhookStrategyContext } from '../platform/IWebhookStrategy.js';
import { WOOCOMMERCE_HMAC_CONFIG } from '../platform/HmacConfig.js';
import {
  mapWooOrderToEvent,
  uuidV5FromOrderLive,
  ORDER_LIVE_V1_EVENT_NAME,
  type WooOrderShape,
} from '@brain/woocommerce-mapper';
import { incrementCounter } from '@brain/observability';

const ORDER_TOPICS = new Set(['order.created', 'order.updated']);

export class WooCommerceWebhookStrategy implements IWebhookStrategy {
  readonly provider = 'woocommerce';

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

    const topic = (headers['x-wc-webhook-topic'] as string | undefined)?.trim() ?? '';
    if (!ORDER_TOPICS.has(topic)) {
      return { eventId: '', eventName: '', occurredAt: '', properties: {}, ageCheckTimestampSeconds: null, dedupKey: null, skip: true };
    }

    let order: WooOrderShape;
    try {
      order = JSON.parse(rawBody.toString('utf8')) as WooOrderShape;
    } catch {
      const err = new Error('Webhook body is not valid JSON');
      (err as NodeJS.ErrnoException & { code: string }).code = 'INVALID_JSON';
      throw err;
    }

    if (order.id === undefined || order.id === null || String(order.id).length === 0) {
      const err = new Error('Order id missing');
      (err as NodeJS.ErrnoException & { code: string }).code = 'INVALID_PAYLOAD';
      throw err;
    }

    let mapped;
    try {
      mapped = mapWooOrderToEvent(order, brandId, saltHex, regionCode ?? 'IN', 'real');
    } catch (mapErr) {
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
}
