/**
 * woocommerceWebhookHandler — WooCommerce real-time order webhook receiver (storefront).
 *
 * Registered at: POST /api/v1/webhooks/woocommerce
 *
 * Mirrors shopfloWebhookHandler. SECURITY ORDER is immovable (NN-4 / MT-1):
 *   1. HMAC-first: raw body REQUIRED. The store base URL comes from the X-WC-Webhook-Source header
 *      (NOT the body). Resolve connector by site (SECURITY DEFINER fn) → fetch webhook_secret →
 *      validate base64 HMAC-SHA256(rawBody, webhook_secret) against X-WC-Webhook-Signature.
 *      Invalid/missing/no-connector → 401, NO write, NO DB touch.
 *   2. Topic gate: only order.created / order.updated are processed (others fast-ack).
 *   3. Brand resolution: brand_id is authoritative from the DB ROW (MT-1) — NEVER from the body.
 *   4. Map via @brain/woocommerce-mapper → the SHARED order.live.v1 canonical event (PII hashed at
 *      the boundary with the per-brand salt). Reuses the existing order→ledger + silver_order_state
 *      pipeline — zero new downstream code.
 *   5. Build CollectorEventV1 → produce to liveTopic (key=brand_id). Redis dedup on the
 *      deterministic event_id (idempotent restatement). Touch sync_status → 200.
 *
 * Real-time complement to the woocommerce-orders-repull backfill job (Slice 1). The event_id is the
 * SAME uuidV5FromOrderLive used by the backfill, so a webhook + a later backfill of the same order
 * state collapse to one Bronze row (I-ST04).
 *
 * I-S02: raw PII (email/phone) never in Bronze/logs — hashed at the mapper boundary.
 * I-S09: webhook_secret never logged. NN-2: secret_ref never in any response.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Producer } from 'kafkajs';
import type pg from 'pg';
import { randomUUID } from 'node:crypto';

import { incrementCounter } from '@brain/observability';
import { WooCommerceHmac } from '../../domain/value-objects/WooCommerceHmac.js';
import { RedisDedupAdapter } from '../../../../payment/razorpay/infrastructure/RedisDedupAdapter.js';
import type { ISecretsManager } from '@brain/connector-secrets';
import {
  mapWooOrderToEvent,
  uuidV5FromOrderLive,
  ORDER_LIVE_V1_EVENT_NAME,
  type WooOrderShape,
} from '@brain/woocommerce-mapper';
import { CollectorEventV1Schema } from '@brain/contracts';
import type { Redis } from 'ioredis';

export interface WooCommerceWebhookHandlerDeps {
  secretsManager: ISecretsManager;
  rawPgPool: pg.Pool;
  producer: Producer;
  liveTopic: string;
  getSaltHex: (brandId: string) => Promise<string>;
  redis: Redis;
  /** Region for phone normalization (default 'IN'). */
  regionCode?: string;
}

interface WooConnectorDispatchRow {
  connector_instance_id: string;
  brand_id: string;
  secret_ref: string;
}

/** WooCommerce order topics we process into the canonical order.live.v1 event. */
const ORDER_TOPICS = new Set(['order.created', 'order.updated']);

export function registerWooCommerceWebhookRoutes(
  fastify: FastifyInstance,
  deps: WooCommerceWebhookHandlerDeps,
): void {
  const { secretsManager, rawPgPool, producer, liveTopic, getSaltHex, redis } = deps;
  const regionCode = deps.regionCode ?? 'IN';
  const dedupAdapter = new RedisDedupAdapter(redis);
  const sigHeaderName = WooCommerceHmac.signatureHeaderName();

  fastify.post(
    '/api/v1/webhooks/woocommerce',
    { config: { rawBody: true } },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const requestId = (req.id as string) ?? randomUUID();
      const correlationId = (req.headers['x-correlation-id'] as string | undefined) ?? requestId;

      // ── Step 1: HMAC-first (NN-4) ────────────────────────────────────────
      const rawBody = (req as FastifyRequest & { rawBody?: Buffer }).rawBody;
      if (!rawBody) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'RAW_BODY_MISSING', message: 'Raw body not available' },
        });
      }

      const signatureHeader = (req.headers[sigHeaderName] as string | undefined) ?? '';
      // The store base URL — the connector lookup key (NOT brand authority).
      const sourceUrl = (req.headers['x-wc-webhook-source'] as string | undefined)?.trim() ?? '';
      // WooCommerce sends a trailing slash on the source; normalize both sides at resolve time.
      const normalizedSource = sourceUrl.replace(/\/+$/, '');
      if (!normalizedSource) {
        return reply.code(401).send({
          request_id: requestId,
          error: { code: 'HMAC_INVALID', message: 'Webhook authentication failed' },
        });
      }

      // Resolve connector by site → secret_ref + brand_id (from the DB ROW, MT-1).
      let connectorRow: WooConnectorDispatchRow | null = null;
      try {
        const result = await rawPgPool.query<WooConnectorDispatchRow>(
          `SELECT connector_instance_id, brand_id, secret_ref
           FROM resolve_woocommerce_connector_by_site($1)`,
          [normalizedSource],
        );
        connectorRow = result.rows[0] ?? null;
      } catch (dbErr) {
        req.log?.error({ request_id: requestId, err: dbErr }, '[woocommerce-webhook] connector lookup failed');
        return reply.code(500).send({
          request_id: requestId,
          error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
        });
      }

      if (!connectorRow) {
        req.log?.warn({ request_id: requestId }, '[woocommerce-webhook] no connector for site — rejecting');
        return reply.code(401).send({
          request_id: requestId,
          error: { code: 'HMAC_INVALID', message: 'Webhook authentication failed' },
        });
      }

      // Fetch composite credential bundle → webhook_secret (I-S09: never logged).
      let webhookSecret: string;
      try {
        const creds = await secretsManager.getSecret(connectorRow.secret_ref);
        if (!creds || !creds['webhook_secret']) {
          incrementCounter('connector_auth_rejected_total', { provider: 'woocommerce' });
          req.log?.warn({ request_id: requestId }, '[woocommerce-webhook] webhook_secret missing — rejecting');
          return reply.code(401).send({
            request_id: requestId,
            error: { code: 'HMAC_INVALID', message: 'Webhook authentication failed' },
          });
        }
        webhookSecret = creds['webhook_secret'];
      } catch (secretErr) {
        req.log?.error({ request_id: requestId, err: secretErr }, '[woocommerce-webhook] secret fetch failed');
        return reply.code(500).send({
          request_id: requestId,
          error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
        });
      }

      const hmacValid = WooCommerceHmac.validateWebhook(rawBody, signatureHeader, webhookSecret);
      if (!hmacValid) {
        incrementCounter('connector_auth_rejected_total', { provider: 'woocommerce' });
        req.log?.warn({ request_id: requestId }, '[woocommerce-webhook] HMAC invalid — rejecting (NN-4)');
        return reply.code(401).send({
          request_id: requestId,
          error: { code: 'HMAC_INVALID', message: 'Webhook authentication failed' },
        });
      }

      // ── Step 2: Topic gate ───────────────────────────────────────────────
      const topic = (req.headers['x-wc-webhook-topic'] as string | undefined)?.trim() ?? '';
      if (!ORDER_TOPICS.has(topic)) {
        // Non-order topics (product/customer/coupon) — accept & discard in this slice.
        return reply.code(200).send({ request_id: requestId, received: true });
      }

      // ── Step 3: Brand from connector ROW (MT-1) ──────────────────────────
      const brandId = connectorRow.brand_id;
      const connectorInstanceId = connectorRow.connector_instance_id;

      // Parse the order resource body.
      let order: WooOrderShape;
      try {
        order = JSON.parse(rawBody.toString('utf8')) as WooOrderShape;
      } catch {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_JSON', message: 'Webhook body is not valid JSON' },
        });
      }
      if (order.id === undefined || order.id === null || String(order.id).length === 0) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_PAYLOAD', message: 'Order id missing' },
        });
      }

      // ── Step 4: Map → order.live.v1 (PII hashed at boundary) ─────────────
      let saltHex: string;
      try {
        saltHex = await getSaltHex(brandId);
      } catch (saltErr) {
        req.log?.error({ request_id: requestId, brand_id: brandId, err: saltErr }, '[woocommerce-webhook] salt fetch failed');
        return reply.code(500).send({
          request_id: requestId,
          error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
        });
      }

      let mapped;
      try {
        mapped = mapWooOrderToEvent(order, brandId, saltHex, regionCode, 'real');
      } catch (mapErr) {
        req.log?.error({ request_id: requestId, brand_id: brandId, err: mapErr }, '[woocommerce-webhook] map failed');
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_PAYLOAD', message: 'Order could not be mapped' },
        });
      }

      const orderId = String(order.id);
      const updatedAtMs = Date.parse(mapped.occurred_at);
      const eventId = uuidV5FromOrderLive(brandId, orderId, updatedAtMs);

      // Redis dedup on the deterministic event_id (idempotent restatement; Bronze PK also dedups).
      const isDuplicate = await dedupAdapter.isDuplicate(eventId);
      if (isDuplicate) {
        return reply.code(200).send({ request_id: requestId, received: true, deduped: true });
      }

      // ── Step 5: Build CollectorEventV1 → produce to live lane ────────────
      const collectorEnvelope = CollectorEventV1Schema.parse({
        schema_version: '1' as const,
        event_id: eventId,
        brand_id: brandId, // from connector row — NEVER from body (MT-1)
        correlation_id: correlationId,
        event_name: ORDER_LIVE_V1_EVENT_NAME,
        occurred_at: mapped.occurred_at,
        ingested_at: new Date().toISOString(),
        properties: mapped.properties as unknown as Record<string, unknown>,
      });

      try {
        await producer.send({
          topic: liveTopic,
          messages: [
            {
              key: brandId,
              value: Buffer.from(JSON.stringify(collectorEnvelope)),
              headers: {
                correlation_id: Buffer.from(correlationId),
                event_name: Buffer.from(ORDER_LIVE_V1_EVENT_NAME),
              },
            },
          ],
        });
      } catch (kafkaErr) {
        req.log?.error({ request_id: requestId, brand_id: brandId, err: kafkaErr }, '[woocommerce-webhook] Kafka produce failed');
        return reply.code(500).send({
          request_id: requestId,
          error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
        });
      }

      req.log?.info(
        { request_id: requestId, brand_id: brandId, event_id: eventId, topic },
        '[woocommerce-webhook] order emitted to live lane',
      );

      // ── Step 6: Touch sync_status (non-fatal) → 200 ──────────────────────
      touchSyncStatus(rawPgPool, brandId, connectorInstanceId).catch((syncErr) => {
        req.log?.warn({ request_id: requestId, err: syncErr }, '[woocommerce-webhook] sync_status touch failed (non-fatal)');
      });

      return reply.code(200).send({ request_id: requestId, received: true });
    },
  );
}

async function touchSyncStatus(
  rawPgPool: pg.Pool,
  brandId: string,
  connectorInstanceId: string,
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
