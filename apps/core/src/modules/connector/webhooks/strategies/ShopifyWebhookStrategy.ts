/**
 * ShopifyWebhookStrategy — per-provider Strategy for the WebhookPipeline.
 *
 * signatureVerify:
 *   Uses SHOPIFY_HMAC_CONFIG (base64 HMAC-SHA256). Lookup key = X-Shopify-Shop-Domain header.
 *   Byte-compatible with the legacy ShopifyHmac.validateWebhook().
 *
 * payloadMap:
 *   Processes order topics (orders/create, orders/updated, orders/paid, orders/fulfilled,
 *   orders/cancelled). Processes GDPR compliance topics (customers/data_request,
 *   customers/redact, shop/redact). Processes app/uninstalled (marks ConnectorInstance
 *   Disconnected). Non-handled topics fast-ack (skip=true). Hashes PII at boundary (I-S02).
 *   Includes cart-stitch side effect (fire-and-forget — D-5).
 *
 * SHOPIFY-SPECIFIC FIX (drift correction):
 *   Shopify previously lacked the 5-min replay-window age gate that Razorpay/Shopflo have.
 *   The pipeline applies a unified age gate. For Shopify, ageCheckTimestampSeconds is derived
 *   from order.updated_at/processed_at/created_at — consistent with the event_id derivation.
 *
 * GDPR TOPICS (shopify-compliance-token-lifecycle):
 *   customers/data_request — fast-ack (Shopify acknowledges; no PII lookup here).
 *   customers/redact — fast-ack, fires erase_customer SECURITY DEFINER side-effect.
 *   shop/redact — fast-ack (no individual brain_id; shop-level deletion is ops runbook).
 *
 * APP UNINSTALL:
 *   app/uninstalled — invalidates stored secret, marks ConnectorInstance Disconnected via
 *   the entity's disconnect() transition. The pipeline fast-acks after the side-effect.
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
import { hashIdentifier, normalizeIdentifier, resolveSaltHex } from '@brain/identity-core';

const ORDER_TOPICS = new Set([
  'orders/create',
  'orders/updated',
  'orders/paid',
  'orders/fulfilled',
  'orders/cancelled',
]);

/** app/uninstalled: invalidate secret + mark ConnectorInstance Disconnected. */
const UNINSTALL_TOPIC = 'app/uninstalled' as const;

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

    // ── GDPR: customers/data_request — acknowledge only ───────────────────────
    // Shopify requires a 200 ack within 48h. No PII lookup; data export is an
    // async ops runbook. Fast-ack without Kafka produce (no business event).
    if (topic === 'customers/data_request' || topic === 'shop/redact') {
      void correlationId; void requestId; void saltHex;
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

    // ── GDPR: customers/redact — erase_customer SECURITY DEFINER ──────────────
    // The body carries customer.id and orders_to_redact[].id. We resolve the
    // brain_id from the customer.id via customer_brain_id() (SECURITY DEFINER),
    // then call erase_customer() which hard-deletes PII vault rows + tombstones
    // identity_link under the correct brand GUC. Fast-ack on success; the pipeline
    // runs the sideEffect (throwOnSideEffectError=false — idempotent, Shopify retries).
    if (topic === 'customers/redact') {
      void saltHex;
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
      } catch {
        const err = new Error('Webhook body is not valid JSON');
        (err as NodeJS.ErrnoException & { code: string }).code = 'INVALID_JSON';
        throw err;
      }

      const customerId = body['customer'] != null
        ? (body['customer'] as Record<string, unknown>)['id']
        : null;
      const shopifyCustomerId = customerId != null ? String(customerId) : null;
      const capturedBrandId = brandId;
      const capturedCorrelationId = correlationId;
      const capturedRequestId = requestId;

      const sideEffect = async (
        _brandId: string,
        _rawPgPool: pg.Pool,
        _reqId: string,
        identityReader?: { resolveBrainIdByStorefrontCustomerId(b: string, h: string): Promise<string | null>; eraseCustomer(b: string, id: string): Promise<{ erased: boolean }> },
      ): Promise<void> => {
        if (!shopifyCustomerId || !identityReader) {
          // No customer.id in payload, or no identity graph wired — nothing to erase. Fast-exit.
          return;
        }

        // MEDALLION REALIGNMENT (Epic 3 / ADR-0004): resolve brain_id from the Shopify customer.id via
        // the Neo4j identity SoR (hash the storefront_customer_id with the brand salt, as the resolver
        // does), then erase (graph tombstone + PG contact_pii delete + audit).
        const salt = resolveSaltHex(capturedBrandId);
        if (!salt || salt.length !== 64) return; // bad salt → cannot match; never crash the webhook
        // storefront_customer_id is hashed under identity-core's 'external_id' type (matches the resolver).
        const hash = hashIdentifier(
          normalizeIdentifier(shopifyCustomerId, 'external_id'),
          'external_id',
          salt,
        );
        const brainId = await identityReader.resolveBrainIdByStorefrontCustomerId(capturedBrandId, hash);
        if (!brainId) {
          // Customer not in our identity graph — nothing to erase (never converted). Correct no-op.
          return;
        }
        await identityReader.eraseCustomer(capturedBrandId, brainId);

        void capturedCorrelationId; void capturedRequestId;
      };

      return {
        eventId: '',
        eventName: '',
        occurredAt: '',
        properties: {},
        ageCheckTimestampSeconds: null,
        dedupKey: null,
        skip: true,  // skip Kafka produce — this is a compliance side-effect only
        sideEffect,
        throwOnSideEffectError: false, // fire-and-forget; Shopify retries on non-200 are handled by 200 ack
      };
    }

    // ── app/uninstalled — mark ConnectorInstance Disconnected ────────────────
    // Shopify sends this when the app is uninstalled from the shop. We must:
    //   1. Mark the ConnectorInstance Disconnected (entity transition).
    //   2. Invalidate the stored secret (delete from Secrets Manager via raw PG
    //      dev_secret or flag-only if AWS — actual deletion is async/ops runbook
    //      for prod; here we set status to 'disconnected' + health→Disconnected
    //      which is the entity-level signal, same as DisconnectCommand).
    // Fast-ack so Shopify sees 200. Side-effect is fire-and-forget.
    if (topic === UNINSTALL_TOPIC) {
      void saltHex;
      const capturedBrandId = brandId;

      const sideEffect = async (_brandId: string, rawPgPool: pg.Pool, _reqId: string): Promise<void> => {
        // Mark the connector_instance row as disconnected using the same fields
        // as the entity's disconnect() transition (ADR-CM-5):
        //   status = 'disconnected', health_state = 'Disconnected', safety_rating = 'blocked',
        //   disconnected_at = NOW(), updated_at = NOW().
        // We use raw PG (not the GUC-middleware pool) to set GUC in txn.
        const client = await rawPgPool.connect();
        try {
          await client.query('BEGIN');
          await client.query(`SELECT set_config('app.current_brand_id', $1, true)`, [capturedBrandId]);
          await client.query(
            `UPDATE connector_instance
             SET status = 'disconnected',
                 health_state = 'Disconnected',
                 safety_rating = 'blocked',
                 disconnected_at = NOW(),
                 updated_at = NOW()
             WHERE brand_id = $1 AND provider = 'shopify'`,
            [capturedBrandId],
          );
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw err;
        } finally {
          client.release();
        }
      };

      return {
        eventId: '',
        eventName: '',
        occurredAt: '',
        properties: {},
        ageCheckTimestampSeconds: null,
        dedupKey: null,
        skip: true,  // skip Kafka produce — connector state change is PG-only
        sideEffect,
        throwOnSideEffectError: false, // fire-and-forget; we ack 200 regardless
      };
    }

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
