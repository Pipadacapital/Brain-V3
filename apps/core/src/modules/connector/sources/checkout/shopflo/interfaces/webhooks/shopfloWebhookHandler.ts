/**
 * shopfloWebhookHandler — Shopflo live-event webhook receiver (Track B).
 *
 * Registered at: POST /api/v1/webhooks/shopflo
 *
 * Clone of razorpayWebhookHandler. SECURITY ORDER is immovable (NN-4 / MT-1 / C3):
 *   1. HMAC-first: raw body REQUIRED. Parse ONLY to extract merchant_id (lookup key).
 *      Resolve connector by merchant_id (SECURITY DEFINER fn) → fetch webhook_secret →
 *      validate HMAC-SHA256(rawBody, webhook_secret) against the config-driven header.
 *      Invalid/missing/no-connector → 401, NO write, NO DB touch.
 *   2. Replay protection (C3 — BEFORE any write):
 *      (a) age check on occurred_at (outside replay window → 400)
 *      (b) Redis SET NX EX on a deterministic dedup key → already-seen = 409.
 *   3. Brand resolution: brand_id is authoritative from the DB ROW (MT-1) — NEVER
 *      from the webhook body. A forged merchant_id/brand_id in the body cannot
 *      target another brand: the secret is the per-connector secret, and the brand
 *      is the row's brand. A forged body either fails HMAC (no matching secret) or,
 *      if signed with the real secret, still writes only to that connector's brand.
 *   4. Map via @brain/shopflo-mapper — field allowlist + boundary PII hash
 *      (email/phone hashed with the per-brand salt BEFORE leaving handler scope) +
 *      BIGINT minor-units money. Real payload (documented) — data_source:'real'.
 *   5. Build CollectorEventV1 → produce to liveTopic (key = brand_id) → Bronze
 *      landing is downstream (accept-before-validate). Touch sync_status → 200.
 *
 * MT-1: brand_id is authoritative from the DB row — NEVER from the webhook body.
 * NN-4: HMAC is the gating security operation.
 * C3:   Replay protection is separate from Bronze data-correctness dedup.
 * I-S02: raw PII (email/phone) never in Bronze/logs/responses — hashed at boundary.
 * I-S09: webhook_secret never logged. NN-2: secret_ref never in any response.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Producer } from 'kafkajs';
import type pg from 'pg';
import { randomUUID } from 'node:crypto';

import { ShopfloHmac } from '../../domain/value-objects/ShopfloHmac.js';
import { RedisDedupAdapter } from '../../../../payment/razorpay/infrastructure/RedisDedupAdapter.js';
import type { ISecretsManager } from '../../../../storefront/shopify/infrastructure/secrets/ISecretsManager.js';
import {
  mapShopfloCheckoutAbandoned,
  uuidV5FromShopfloCheckout,
  SHOPFLO_CHECKOUT_ABANDONED_V1_EVENT_NAME,
  type ShopfloCheckoutAbandonedPayload,
} from '@brain/shopflo-mapper';
import { CollectorEventV1Schema } from '@brain/contracts';
import type { Redis } from 'ioredis';

// ── Dependency interface ──────────────────────────────────────────────────────

export interface ShopfloWebhookHandlerDeps {
  /** Secrets Manager — provides webhook_secret from the composite credential bundle. */
  secretsManager: ISecretsManager;
  /** Raw pg.Pool — SECURITY DEFINER fn call + GUC-scoped sync_status touch. */
  rawPgPool: pg.Pool;
  /** KafkaJS Producer (connected before route registration). */
  producer: Producer;
  /** Kafka live topic (e.g. 'dev.collector.event.v1'). */
  liveTopic: string;
  /** Per-brand identity salt resolver. Returns 64-char hex salt for a brandId. */
  getSaltHex: (brandId: string) => Promise<string>;
  /** ioredis client for replay dedup (C3). */
  redis: Redis;
}

// ── DB row returned by resolve_shopflo_connector_by_merchant ─────────────────

interface ShopfloConnectorDispatchRow {
  connector_instance_id: string;
  brand_id: string;
  secret_ref: string; // ARN to fetch composite credential bundle from Secrets Manager
}

// ── Raw Shopflo webhook envelope shape (parsed ONLY to extract merchant_id) ──

interface ShopfloWebhookEnvelope {
  merchant_id?: string; // lookup key for connector resolution (NOT brand authority)
  event?: string; // e.g. 'checkout_abandoned'
  checkout_id?: string; // used for the deterministic dedup key
  occurred_at?: string; // ISO-8601 — used for the replay age check + dedup key
  [key: string]: unknown;
}

/** Replay window for Shopflo events (mirrors the Razorpay 5-min age gate). */
const SHOPFLO_REPLAY_WINDOW_SECONDS = 5 * 60;

// ── Route registration ────────────────────────────────────────────────────────

export function registerShopfloWebhookRoutes(
  fastify: FastifyInstance,
  deps: ShopfloWebhookHandlerDeps,
): void {
  const { secretsManager, rawPgPool, producer, liveTopic, getSaltHex, redis } = deps;
  const dedupAdapter = new RedisDedupAdapter(redis);
  const sigHeaderName = ShopfloHmac.signatureHeaderName();

  fastify.post(
    '/api/v1/webhooks/shopflo',
    {
      config: { rawBody: true },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const requestId = (req.id as string) ?? randomUUID();
      const correlationId =
        (req.headers['x-correlation-id'] as string | undefined) ?? requestId;

      // ── Step 1: HMAC-first (NN-4) ────────────────────────────────────────
      // Raw body is REQUIRED — without it we cannot validate the signature.
      const rawBody = (req as FastifyRequest & { rawBody?: Buffer }).rawBody;
      if (!rawBody) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'RAW_BODY_MISSING', message: 'Raw body not available' },
        });
      }

      const signatureHeader = (req.headers[sigHeaderName] as string | undefined) ?? '';

      // Parse ONLY to extract merchant_id for the per-connector secret lookup.
      // No write occurs between parse and HMAC validation.
      let envelope: ShopfloWebhookEnvelope;
      try {
        envelope = JSON.parse(rawBody.toString('utf8')) as ShopfloWebhookEnvelope;
      } catch {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_JSON', message: 'Webhook body is not valid JSON' },
        });
      }

      const merchantId = typeof envelope.merchant_id === 'string' ? envelope.merchant_id : '';
      if (!merchantId) {
        req.log?.warn({ request_id: requestId }, '[shopflo-webhook] missing merchant_id — rejecting');
        return reply.code(401).send({
          request_id: requestId,
          error: { code: 'HMAC_INVALID', message: 'Webhook authentication failed' },
        });
      }

      // Resolve connector by merchant_id → secret_ref + brand_id (from the DB ROW).
      // resolve_shopflo_connector_by_merchant is SECURITY DEFINER (migration 0030).
      let connectorRow: ShopfloConnectorDispatchRow | null = null;
      try {
        const result = await rawPgPool.query<ShopfloConnectorDispatchRow>(
          `SELECT connector_instance_id, brand_id, secret_ref
           FROM resolve_shopflo_connector_by_merchant($1)`,
          [merchantId],
        );
        connectorRow = result.rows[0] ?? null;
      } catch (dbErr) {
        req.log?.error(
          { request_id: requestId, err: dbErr },
          '[shopflo-webhook] connector lookup failed',
        );
        return reply.code(500).send({
          request_id: requestId,
          error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
        });
      }

      if (!connectorRow) {
        req.log?.warn(
          { request_id: requestId },
          '[shopflo-webhook] no connector for merchant — rejecting',
        );
        return reply.code(401).send({
          request_id: requestId,
          error: { code: 'HMAC_INVALID', message: 'Webhook authentication failed' },
        });
      }

      // Fetch composite credential bundle → extract webhook_secret.
      // I-S09: never log the secret_ref or the bundle contents.
      let webhookSecret: string;
      try {
        const creds = await secretsManager.getSecret(connectorRow.secret_ref);
        if (!creds || !creds['webhook_secret']) {
          req.log?.warn(
            { request_id: requestId },
            '[shopflo-webhook] webhook_secret missing from credentials — rejecting',
          );
          return reply.code(401).send({
            request_id: requestId,
            error: { code: 'HMAC_INVALID', message: 'Webhook authentication failed' },
          });
        }
        webhookSecret = creds['webhook_secret'];
      } catch (secretErr) {
        req.log?.error(
          { request_id: requestId, err: secretErr },
          '[shopflo-webhook] secret fetch failed',
        );
        return reply.code(500).send({
          request_id: requestId,
          error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
        });
      }

      // Validate HMAC against the raw body bytes with the resolved per-connector secret.
      const hmacValid = ShopfloHmac.validateWebhook(rawBody, signatureHeader, webhookSecret);
      if (!hmacValid) {
        req.log?.warn(
          { request_id: requestId },
          '[shopflo-webhook] HMAC invalid — rejecting (NN-4)',
        );
        return reply.code(401).send({
          request_id: requestId,
          error: { code: 'HMAC_INVALID', message: 'Webhook authentication failed' },
        });
      }

      // ── Step 3: Brand resolution — authoritative from connector ROW (MT-1) ─
      // brand_id is from the DB row resolved above — NEVER from the webhook body.
      const brandId = connectorRow.brand_id;
      const connectorInstanceId = connectorRow.connector_instance_id;
      const eventName = typeof envelope.event === 'string' ? envelope.event : '';

      // Only checkout_abandoned is handled in Slice 1; unknown events fast-ack.
      if (eventName !== 'checkout_abandoned') {
        req.log?.info(
          { request_id: requestId, event_name: eventName },
          '[shopflo-webhook] unknown event type — fast-ack without processing',
        );
        return reply.code(200).send({ request_id: requestId, received: true });
      }

      // ── Step 2: Replay protection (C3) ───────────────────────────────────
      // Shopflo gives no event-id → deterministic dedup key = uuidV5 over
      // (brandId, checkout_id, occurred_at). Replay-safe + brand-scoped.
      const checkoutId = typeof envelope.checkout_id === 'string' ? envelope.checkout_id : '';
      const occurredAt = typeof envelope.occurred_at === 'string' ? envelope.occurred_at : '';
      if (!checkoutId || !occurredAt) {
        req.log?.warn(
          { request_id: requestId, brand_id: brandId },
          '[shopflo-webhook] missing checkout_id or occurred_at — rejecting',
        );
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'REPLAY_REJECTED', message: 'checkout_id or occurred_at missing' },
        });
      }

      // (a) Age check — reject events older than the replay window.
      const occurredAtMs = Date.parse(occurredAt);
      if (Number.isNaN(occurredAtMs)) {
        req.log?.warn(
          { request_id: requestId, brand_id: brandId },
          '[shopflo-webhook] invalid occurred_at — rejecting',
        );
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'REPLAY_REJECTED', message: 'occurred_at is not a valid timestamp' },
        });
      }
      const ageSeconds = Math.floor((Date.now() - occurredAtMs) / 1000);
      if (ageSeconds > SHOPFLO_REPLAY_WINDOW_SECONDS) {
        req.log?.warn(
          { request_id: requestId, brand_id: brandId },
          '[shopflo-webhook] event older than replay window — rejecting (C3)',
        );
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'REPLAY_REJECTED', message: 'Event too old — outside replay window' },
        });
      }

      // event_id = uuidV5(brandId, checkout_id, occurred_at) — also the Bronze key + dedup key.
      const bronzeEventId = uuidV5FromShopfloCheckout(brandId, checkoutId, occurredAt);

      // (b) Redis dedup (SET NX EX) on the deterministic event_id.
      const isDuplicate = await dedupAdapter.isDuplicate(bronzeEventId);
      if (isDuplicate) {
        req.log?.warn(
          { request_id: requestId, brand_id: brandId },
          '[shopflo-webhook] duplicate event — rejecting (C3 Redis dedup)',
        );
        return reply.code(409).send({
          request_id: requestId,
          error: { code: 'DUPLICATE_EVENT', message: 'Event already processed' },
        });
      }

      // ── Step 4: Map — allowlist + boundary PII hash + minor-units money ──
      // Hash email/phone with the per-brand salt BEFORE they leave handler scope (I-S02).
      let saltHex: string;
      try {
        saltHex = await getSaltHex(brandId);
      } catch (saltErr) {
        req.log?.error(
          { request_id: requestId, brand_id: brandId, err: saltErr },
          '[shopflo-webhook] salt fetch failed — cannot hash PII safely',
        );
        return reply.code(500).send({
          request_id: requestId,
          error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
        });
      }

      // dataSource='real' — the live HMAC-verified webhook is REAL (documented payload).
      const mapped = mapShopfloCheckoutAbandoned(
        envelope as unknown as ShopfloCheckoutAbandonedPayload,
        brandId,
        saltHex,
        'IN',
        'real',
      );

      // ── Step 5: Build CollectorEventV1 → produce to live lane → Bronze ───
      const collectorEnvelope = CollectorEventV1Schema.parse({
        schema_version: '1' as const,
        event_id: bronzeEventId,
        brand_id: brandId, // from connector row — NEVER from body (MT-1)
        correlation_id: correlationId,
        event_name: SHOPFLO_CHECKOUT_ABANDONED_V1_EVENT_NAME,
        occurred_at: mapped.occurred_at,
        ingested_at: new Date().toISOString(),
        properties: mapped.properties as unknown as Record<string, unknown>,
      });

      try {
        await producer.send({
          topic: liveTopic,
          messages: [
            {
              key: brandId, // partition key = brand_id (tenant isolation)
              value: Buffer.from(JSON.stringify(collectorEnvelope)),
              headers: {
                correlation_id: Buffer.from(correlationId),
                event_name: Buffer.from(SHOPFLO_CHECKOUT_ABANDONED_V1_EVENT_NAME),
              },
            },
          ],
        });
      } catch (kafkaErr) {
        req.log?.error(
          { request_id: requestId, brand_id: brandId, err: kafkaErr },
          '[shopflo-webhook] Kafka produce failed — returning 500 so Shopflo retries',
        );
        return reply.code(500).send({
          request_id: requestId,
          error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
        });
      }

      req.log?.info(
        {
          request_id: requestId,
          brand_id: brandId,
          event_id: bronzeEventId,
          event_name: SHOPFLO_CHECKOUT_ABANDONED_V1_EVENT_NAME,
        },
        '[shopflo-webhook] checkout_abandoned emitted to live lane',
      );

      // ── Step 6: Touch sync_status (non-fatal) → 200 fast-ack ─────────────
      touchSyncStatus(rawPgPool, brandId, connectorInstanceId, requestId, req).catch((syncErr) => {
        req.log?.warn(
          { request_id: requestId, err: syncErr },
          '[shopflo-webhook] sync_status touch failed (non-fatal)',
        );
      });

      return reply.code(200).send({ request_id: requestId, received: true });
    },
  );
}

// ── connector_sync_status touch ───────────────────────────────────────────────

/**
 * Touch connector_sync_status.last_sync_at + state='connected' under brand GUC.
 * Fire-and-forget — does not block the 200 fast-ack.
 * Mirrors razorpayWebhookHandler.ts:449.
 */
async function touchSyncStatus(
  rawPgPool: pg.Pool,
  brandId: string,
  connectorInstanceId: string,
  _requestId: string,
  _log: { log?: { warn: (obj: object, msg: string) => void } },
): Promise<void> {
  const client = await rawPgPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_brand_id', $1, true)`, [brandId]);
    await client.query(
      `UPDATE connector_sync_status
       SET state = 'connected', last_sync_at = NOW(), updated_at = NOW()
       WHERE brand_id = $1 AND connector_instance_id = $2`,
      [brandId, connectorInstanceId],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
