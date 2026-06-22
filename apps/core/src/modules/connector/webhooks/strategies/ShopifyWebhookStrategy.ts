/**
 * ShopifyWebhookStrategy — per-provider Strategy for the WebhookPipeline.
 *
 * signatureVerify:
 *   Uses SHOPIFY_HMAC_CONFIG (base64 HMAC-SHA256). Lookup key = X-Shopify-Shop-Domain header.
 *   Byte-compatible with the legacy ShopifyHmac.validateWebhook().
 *
 * payloadMap:
 *   Processes order topics (orders/create, orders/updated, orders/paid, orders/fulfilled,
 *   orders/cancelled). Non-order topics fast-ack (skip=true). Hashes PII at boundary (I-S02).
 *   Includes cart-stitch side effect (fire-and-forget — D-5).
 *
 * SHOPIFY-SPECIFIC FIX (drift correction):
 *   Shopify previously lacked the 5-min replay-window age gate that Razorpay/Shopflo have.
 *   The pipeline applies a unified age gate. For Shopify, ageCheckTimestampSeconds is derived
 *   from order.updated_at/processed_at/created_at — consistent with the event_id derivation.
 */

import type { FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { IWebhookStrategy, SignatureVerifyResult, PayloadMapResult, WebhookStrategyContext } from '../platform/IWebhookStrategy.js';
import { SHOPIFY_HMAC_CONFIG } from '../platform/HmacConfig.js';
import {
  mapOrderToEvent,
  projectOrderStitch,
  uuidV5FromOrderLive,
  ORDER_LIVE_V1_EVENT_NAME,
  type ShopifyOrderShape,
} from '@brain/shopify-mapper';
import { redactShopifyPii } from '../../sources/storefront/shopify/domain/redactPii.js';

const ORDER_TOPICS = new Set([
  'orders/create',
  'orders/updated',
  'orders/paid',
  'orders/fulfilled',
  'orders/cancelled',
]);

export class ShopifyWebhookStrategy implements IWebhookStrategy {
  readonly provider = 'shopify';

  async signatureVerify(
    rawBody: Buffer,
    headers: FastifyRequest['headers'],
    getSecret: (lookupKey: string) => Promise<{ webhookSecret: string; connectorLookupKey: string }>,
  ): Promise<SignatureVerifyResult> {
    const shopDomain = (headers['x-shopify-shop-domain'] as string | undefined) ?? '';
    if (!shopDomain) {
      const err = new Error('X-Shopify-Shop-Domain header missing');
      (err as NodeJS.ErrnoException & { code: string }).code = 'HMAC_INVALID';
      throw err;
    }

    const hmacHeader = (headers[SHOPIFY_HMAC_CONFIG.header] as string | undefined) ?? '';
    const { webhookSecret } = await getSecret(shopDomain);

    if (!webhookSecret || !SHOPIFY_HMAC_CONFIG.validateWebhook(rawBody, hmacHeader, webhookSecret)) {
      const err = new Error('HMAC validation failed');
      (err as NodeJS.ErrnoException & { code: string }).code = 'HMAC_INVALID';
      throw err;
    }

    return { lookupKey: shopDomain, parsedPayload: null };
  }

  async payloadMap(ctx: WebhookStrategyContext): Promise<PayloadMapResult> {
    const { rawBody, headers, brandId, saltHex, correlationId, requestId } = ctx;

    // Shopify sends the topic in the URL param (:topic). The strategy receives it
    // via the request headers workaround — the route registers with :topic param and
    // the pipeline calls us with the full request headers.
    // We parse topic from the rawBody's Content-Type — no, the topic is a URL param.
    // The pipeline passes the parsed request query/params via a header convention;
    // we use a dedicated approach: parse the body first, then read topic from the
    // Fastify request's path which was injected into a custom header by the pipeline.
    // Actually: the topic is in the request via the x-webhook-topic header we inject
    // at registration time, OR we read from the raw body.
    // CLEAN APPROACH: we read the topic from headers['x-wh-topic'] which the
    // route registration sets (see ShopifyWebhookRouteConfig).
    const topic = (headers['x-wh-topic'] as string | undefined) ?? '';

    if (!ORDER_TOPICS.has(topic)) {
      return {
        eventId: '',
        eventName: '',
        occurredAt: '',
        properties: {},
        ageCheckTimestampSeconds: null,
        dedupKey: null,
        skip: true,
      };
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
    } catch {
      const err = new Error('Webhook body is not valid JSON');
      (err as NodeJS.ErrnoException & { code: string }).code = 'INVALID_JSON';
      throw err;
    }

    const orderRaw = (body['order'] as Record<string, unknown> | undefined) ?? body;
    if (typeof orderRaw['id'] !== 'number' && typeof orderRaw['id'] !== 'string') {
      return { eventId: '', eventName: '', occurredAt: '', properties: {}, ageCheckTimestampSeconds: null, dedupKey: null, skip: true };
    }

    const order = orderRaw as unknown as ShopifyOrderShape;
    const updatedAt = order.updated_at ?? order.processed_at ?? order.created_at;
    const updatedAtUtcMs = updatedAt ? new Date(updatedAt).getTime() : NaN;
    if (Number.isNaN(updatedAtUtcMs)) {
      return { eventId: '', eventName: '', occurredAt: '', properties: {}, ageCheckTimestampSeconds: null, dedupKey: null, skip: true };
    }

    const orderId = String(order.id);
    const eventId = uuidV5FromOrderLive(brandId, orderId, updatedAtUtcMs);
    const mapped = mapOrderToEvent(order, saltHex, 'IN', ORDER_LIVE_V1_EVENT_NAME);

    // Age check timestamp — derived from the order's updated_at (Unix seconds).
    // This closes the Shopify replay-window drift that Razorpay/Shopflo already had.
    const ageCheckTimestampSeconds = Math.floor(updatedAtUtcMs / 1000);

    // Cart-stitch side-effect (D-5): fire-and-forget.
    const stitch = projectOrderStitch(order);
    let sideEffect: ((brandId: string, rawPgPool: pg.Pool, _requestId: string) => Promise<void>) | undefined;
    if (stitch.stitchedAnonId) {
      const capturedOrderId = orderId;
      const capturedStitch = stitch;
      sideEffect = async (_brandId: string, rawPgPool: pg.Pool, _reqId: string): Promise<void> => {
        if (!capturedStitch.stitchedAnonId) return;
        const client = await rawPgPool.connect();
        try {
          await client.query('BEGIN');
          await client.query(`SELECT set_config('app.current_brand_id', $1, true)`, [_brandId]);
          await client.query(
            `INSERT INTO connector_journey_stitch_map
               (brand_id, order_id, stitched_anon_id, click_ids, utms)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (brand_id, order_id) DO UPDATE
               SET stitched_anon_id = EXCLUDED.stitched_anon_id,
                   click_ids        = EXCLUDED.click_ids,
                   utms             = EXCLUDED.utms`,
            [
              _brandId,
              capturedOrderId,
              capturedStitch.stitchedAnonId,
              capturedStitch.clickIds ? JSON.stringify(capturedStitch.clickIds) : null,
              capturedStitch.utms ? JSON.stringify(capturedStitch.utms) : null,
            ],
          );
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw err;
        } finally {
          client.release();
        }
      };
    }

    void correlationId; void requestId; // used by the pipeline for logging

    return {
      eventId,
      eventName: ORDER_LIVE_V1_EVENT_NAME,
      occurredAt: mapped.occurred_at,
      properties: mapped.properties as unknown as Record<string, unknown>,
      ageCheckTimestampSeconds,
      dedupKey: null,
      skip: false,
      sideEffect,
      throwOnSideEffectError: false,
    };
  }

  /**
   * Returns a redacted body suitable for the raw archive.
   * Called by the pipeline before payloadMap for the archive write.
   */
  redactForArchive(parsedBody: unknown): unknown {
    return redactShopifyPii(parsedBody);
  }
}
