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
 * CRIT-2 (HMAC keys off the REAL secret):
 *   Shopify signs webhooks with the app (BYO-or-Brain) `client_secret` — NOT a per-connector
 *   `webhook_secret` that the OAuth connect flow never stored. signatureVerify therefore takes the
 *   secret in this priority order, fail-closed:
 *     1. The connector secret bundle's `webhook_secret` (the pipeline's getSecret) — honoured FIRST so
 *        a future/explicitly-provisioned bundle key wins (forward-compatible, uniform with Shiprocket).
 *     2. The injected `resolveHmacSecret(shopDomain)` → the brand's Shopify app `client_secret`
 *        (BYO app secret, else Brain's app secret via getShopifyClientSecret). This is the real signing
 *        key for live deployments where the bundle holds only the access token.
 *   An empty/absent secret → HMAC_INVALID (no spoofed events). The resolver is OPTIONAL so the existing
 *   pure unit tests (which exercise payloadMap only) construct the strategy with no args unchanged.
 *
 * HIGH (no-event-loss — order-webhook replay gate REMOVED):
 *   Order webhooks return ageCheckTimestampSeconds=null. The pipeline's 5-min transport replay gate was
 *   being fed the BUSINESS order.updated_at, so any Shopify retry/delay >5min (Shopify retries up to
 *   ~48h) was permanently REJECTED = event loss, violating the no-event-loss invariant. Idempotency is
 *   instead guaranteed by the deterministic uuidV5(brand,orderId,updated_at) event_id + Bronze MERGE,
 *   so a replayed/late delivery is safely deduped rather than dropped.
 *
 * TOPIC ENCODING (registrar↔matcher alignment):
 *   The authoritative topic is Shopify's `X-Shopify-Topic` header (slash form, e.g. 'orders/create').
 *   The route also injects the URL `:topic` segment as `x-wh-topic`; the registrar encodes the slash as
 *   '_' in that path segment, so when X-Shopify-Topic is absent we reverse-map the underscore form
 *   against the known topic set (lossless over the closed set — 'customers_data_request' →
 *   'customers/data_request'). This makes the registrar and the matcher agree on one canonical form.
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
import { hashIdentifier, normalizeIdentifier } from '@brain/identity-core';
import type { ErasureEventPublisher } from '../../../../infrastructure/events/ErasureEventPublisher.js';

const ORDER_TOPICS = new Set([
  'orders/create',
  'orders/updated',
  'orders/paid',
  'orders/fulfilled',
  'orders/cancelled',
]);

/** app/uninstalled: invalidate secret + mark ConnectorInstance Disconnected. */
const UNINSTALL_TOPIC = 'app/uninstalled' as const;

/** The full canonical (slash-form) topic set the strategy handles — used for underscore reverse-mapping. */
const ALL_HANDLED_TOPICS: readonly string[] = [
  ...ORDER_TOPICS,
  'customers/data_request',
  'customers/redact',
  'shop/redact',
  UNINSTALL_TOPIC,
];

/**
 * Resolve the canonical (slash-form) Shopify topic from request headers.
 *   1. `X-Shopify-Topic` — Shopify's own header, always slash form. Authoritative when present.
 *   2. `x-wh-topic` — the route's injected URL `:topic` segment. If it already contains '/', use it;
 *      otherwise it is the registrar's underscore-encoded form, reverse-mapped against the known set
 *      (lossless over the closed set: 'customers_data_request' → 'customers/data_request').
 */
function resolveTopic(headers: FastifyRequest['headers']): string {
  const shopifyTopic = (headers['x-shopify-topic'] as string | undefined)?.trim();
  if (shopifyTopic) return shopifyTopic;
  const injected = ((headers['x-wh-topic'] as string | undefined) ?? '').trim();
  if (!injected || injected.includes('/')) return injected;
  for (const t of ALL_HANDLED_TOPICS) {
    if (t.replace(/\//g, '_') === injected) return t;
  }
  return injected;
}

export class ShopifyWebhookStrategy implements IWebhookStrategy {
  readonly provider = 'shopify';

  /**
   * @param resolveHmacSecret OPTIONAL — resolves the brand's Shopify app `client_secret` for `shopDomain`
   *   (the real webhook signing key; CRIT-2). Injected by the composition root (registerWebhookRoutes)
   *   with access to the connector resolver + Secrets Manager. Omitted by the pure payloadMap unit tests.
   * @param erasurePublisher OPTIONAL (AUD-OPS-036) — the RTBF erasure-trigger bridge. When present,
   *   customers/redact ALSO publishes the canonical privacy.erasure.requested event (subject
   *   email/phone from the Shopify payload + the resolved brain_id) so the stream-worker
   *   orchestrator runs the FULL crypto-shred sequence. Omitted by the pure payloadMap unit tests.
   */
  constructor(
    private readonly resolveHmacSecret?: (shopDomain: string) => Promise<string>,
    private readonly erasurePublisher?: ErasureEventPublisher,
  ) {}

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

    // CRIT-2: prefer an explicitly-provisioned bundle webhook_secret (forward-compatible), else fall
    // back to the brand's Shopify app client_secret — the key Shopify actually signs with. Fail-closed.
    const { webhookSecret } = await getSecret(shopDomain);
    let secret = webhookSecret;
    if (!secret && this.resolveHmacSecret) {
      try {
        secret = await this.resolveHmacSecret(shopDomain);
      } catch {
        secret = ''; // resolver failure → fail-closed (never crash the webhook into a 500)
      }
    }

    if (!secret || !SHOPIFY_HMAC_CONFIG.validateWebhook(rawBody, hmacHeader, secret)) {
      const err = new Error('HMAC validation failed');
      (err as NodeJS.ErrnoException & { code: string }).code = 'HMAC_INVALID';
      throw err;
    }

    return { lookupKey: shopDomain, parsedPayload: null };
  }

  async payloadMap(ctx: WebhookStrategyContext): Promise<PayloadMapResult> {
    const { rawBody, headers, brandId, saltHex, correlationId, requestId } = ctx;
    // SPEC: A.1.4 (WA-09) — connector.identity_fields flag (pipeline-resolved, fail-closed OFF).
    const identityFields = { emitInteropIdentifiers: ctx.identityFieldsEnabled === true };

    // Canonical (slash-form) topic: Shopify's authoritative X-Shopify-Topic header when present, else the
    // route's injected x-wh-topic URL segment (underscore form reverse-mapped). See resolveTopic.
    const topic = resolveTopic(headers);

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

      const customerObj = body['customer'] != null
        ? (body['customer'] as Record<string, unknown>)
        : null;
      const customerId = customerObj?.['id'];
      const shopifyCustomerId = customerId != null ? String(customerId) : null;
      // AUD-OPS-036: Shopify's customers/redact payload carries the subject's raw email/phone —
      // exactly the envelope shape the erasure orchestrator salt-hashes. Captured for the
      // trigger emit below; never logged, never stored by this strategy.
      const customerEmail =
        typeof customerObj?.['email'] === 'string' && customerObj['email'].length > 0
          ? (customerObj['email'] as string)
          : undefined;
      const customerPhone =
        typeof customerObj?.['phone'] === 'string' && customerObj['phone'].length > 0
          ? (customerObj['phone'] as string)
          : undefined;
      const capturedBrandId = brandId;
      const capturedCorrelationId = correlationId;
      const capturedRequestId = requestId;
      const erasurePublisher = this.erasurePublisher;

      // AUD-OPS-036: bridge customers/redact to the async full-erasure orchestrator. Runs even
      // when the synchronous graph erase cannot (no identity graph / customer never converted):
      // the orchestrator resolves the subject from email/phone itself and is skip-safe when the
      // subject is unknown. Fail-open inside the publisher (Shopify is acked regardless).
      const emitErasureTrigger = async (resolvedBrainId?: string): Promise<void> => {
        if (!erasurePublisher) return;
        if (!customerEmail && !customerPhone && !resolvedBrainId) return; // unaddressable
        await erasurePublisher.emitErasureRequested({
          brandId: capturedBrandId,
          subjectEmail: customerEmail,
          subjectPhone: customerPhone,
          brainId: resolvedBrainId,
          source: 'shopify.customers_redact',
          correlationId: capturedCorrelationId,
        });
      };

      const sideEffect = async (
        _brandId: string,
        _rawPgPool: pg.Pool,
        _reqId: string,
        identityReader?: { resolveBrainIdByStorefrontCustomerId(b: string, h: string): Promise<string | null>; eraseCustomer(b: string, id: string): Promise<{ erased: boolean }> },
      ): Promise<void> => {
        if (!shopifyCustomerId || !identityReader) {
          // No customer.id in payload, or no identity graph wired — nothing to erase in the
          // graph, but the async orchestrator can still act on a raw email/phone subject.
          await emitErasureTrigger();
          return;
        }

        // MEDALLION REALIGNMENT (Epic 3 / ADR-0004): resolve brain_id from the Shopify customer.id via
        // the Neo4j identity SoR (hash the storefront_customer_id with the brand salt, as the resolver
        // does), then erase (graph tombstone + PG contact_pii delete + audit).
        // Use the salt already resolved for this brand by the pipeline (ctx.saltHex → getWebhookSaltHex
        // → the single brandSaltSource: dev-derived / prod KMS-unwrapped from brand_identity_salt), NOT
        // a second direct resolveSaltHex — so the redact path resolves identically to the order path
        // and works for runtime-created prod brands (which have no IDENTITY_SALT env).
        const salt = saltHex;
        if (!salt || salt.length !== 64) {
          // Bad salt → cannot match in the graph; never crash the webhook. The async
          // orchestrator resolves the subject with its own salt path — still bridge it.
          await emitErasureTrigger();
          return;
        }
        // storefront_customer_id is hashed under identity-core's 'external_id' type (matches the resolver).
        const hash = hashIdentifier(
          normalizeIdentifier(shopifyCustomerId, 'external_id'),
          'external_id',
          salt,
        );
        const brainId = await identityReader.resolveBrainIdByStorefrontCustomerId(capturedBrandId, hash);
        if (!brainId) {
          // Customer not in our identity graph via storefront id — nothing to erase in the graph,
          // but the subject may still be linked by email/phone: let the orchestrator decide.
          await emitErasureTrigger();
          return;
        }
        await identityReader.eraseCustomer(capturedBrandId, brainId);

        // AUD-OPS-036: synchronous partial erase done (graph tombstone + contact_pii) — now
        // trigger the full ordered sequence (DEK shred / audit log / surrogate / CAPI).
        await emitErasureTrigger(brainId);

        void capturedRequestId;
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
    const mapped = mapOrderToEvent(order, saltHex, 'IN', ORDER_LIVE_V1_EVENT_NAME, identityFields);

    // HIGH (no-event-loss): NO transport replay-age gate for order webhooks. Feeding the business
    // order.updated_at into the pipeline's 5-min window rejected every Shopify retry/delay >5min
    // (Shopify retries ~48h) → permanent event loss. We return null and rely on the deterministic
    // uuidV5(brand,orderId,updated_at) event_id + Bronze MERGE for idempotency, so a late/replayed
    // delivery is deduped, never dropped.
    const ageCheckTimestampSeconds = null;

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
