/**
 * shopifyWebhookHandler — Shopify live-event webhook receiver (B1 / ADR-LV-1..4).
 *
 * Registered at: POST /api/v1/webhooks/shopify/:topic
 *
 * SECURITY ORDER (immovable — NN-4 / ADR-LV-4):
 *   1. HMAC-first: validate X-Shopify-Hmac-Sha256 = base64(HMAC-SHA256(rawBody, clientSecret))
 *      → invalid / missing: 401, NO further processing, NO write.
 *   2. Brand resolution: resolve_connector_by_shop_domain(shopDomain from X-Shopify-Shop-Domain)
 *      → brand_id from DB row, NEVER from header/body directly.
 *      → no connector row: 401, NO write.
 *   3. Parse order → map via @brain/shopify-mapper (hashed PII only — I-S02).
 *   4. Build CollectorEventV1 envelope (incl. correlation_id).
 *   5. Produce directly to live Redpanda topic (ADR-LV-3).
 *   6. Touch connector_sync_status.last_sync_at under brand GUC (ADR-LV-10).
 *   7. 200 fast-ack (Shopify retries on non-2xx).
 *
 * D-4: X-Shopify-Shop-Domain is ONLY a lookup key (after HMAC proof).
 *       brand_id authority = the DB row. The HMAC proves the request came from
 *       the party holding the client_secret for the shop's connector.
 * D-6: event_id = uuidV5FromOrderLive(brandId, orderId, updatedAtUtcMs)
 *       → distinct per updated_at → new Bronze row per state change.
 * D-11: last_sync_at touched on every accepted event.
 * NN-2: No secret_ref / token in any response or log.
 * I-S09: clientSecret never logged.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Producer } from 'kafkajs';
import type pg from 'pg';
import { randomUUID, createHash } from 'node:crypto';

import { ShopifyHmac } from '../../domain/value-objects/ShopifyHmac.js';
import { redactShopifyPii } from '../../domain/redactPii.js';
import type { ISecretsManager } from '@brain/connector-secrets';
import {
  mapOrderToEvent,
  projectOrderStitch,
  uuidV5FromOrderLive,
  ORDER_LIVE_V1_EVENT_NAME,
  type ShopifyOrderShape,
} from '@brain/shopify-mapper';
import { CollectorEventV1Schema } from '@brain/contracts';

// ── Dependency interface ──────────────────────────────────────────────────────

export interface WebhookHandlerDeps {
  secretsManager: ISecretsManager;
  /** Raw pg.Pool (no GUC middleware) — used for SECURITY DEFINER fn call + GUC sync_status touch. */
  rawPgPool: pg.Pool;
  /** KafkaJS Producer (connected before route registration). */
  producer: Producer;
  /** Kafka live topic (e.g. 'dev.collector.event.v1'). */
  liveTopic: string;
  /** Per-brand identity salt resolver. Returns 64-char hex salt for a brandId. */
  getSaltHex: (brandId: string) => Promise<string>;
}

// ── DB row returned by resolve_connector_by_shop_domain ──────────────────────

interface ConnectorDispatchRow {
  connector_instance_id: string;
  brand_id: string;
  shop_domain: string;
  secret_ref: string;
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerShopifyWebhookRoutes(
  fastify: FastifyInstance,
  deps: WebhookHandlerDeps,
): void {
  const { secretsManager, rawPgPool, producer, liveTopic, getSaltHex } = deps;

  fastify.post(
    '/api/v1/webhooks/shopify/:topic',
    {
      config: { rawBody: true },
    },
    async (
      req: FastifyRequest<{
        Params: { topic: string };
        Headers: {
          'x-shopify-hmac-sha256'?: string;
          'x-shopify-shop-domain'?: string;
        };
      }>,
      reply: FastifyReply,
    ) => {
      const requestId = (req.id as string) ?? randomUUID();
      const correlationId =
        (req.headers['x-correlation-id'] as string | undefined) ?? requestId;

      // ── Step 1: HMAC-first (NN-4 / ADR-LV-4) ──────────────────────────────
      const hmacHeader = req.headers['x-shopify-hmac-sha256'] ?? '';
      const rawBody = (req as FastifyRequest & { rawBody?: Buffer }).rawBody;

      if (!rawBody) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'RAW_BODY_MISSING', message: 'Raw body not available' },
        });
      }

      // clientSecret is the Shopify app client_secret — also the webhook HMAC key.
      // I-S09: never log this value.
      const clientSecret = await secretsManager.getShopifyClientSecret();
      const hmacValid = ShopifyHmac.validateWebhook(rawBody, hmacHeader, clientSecret);
      if (!hmacValid) {
        req.log?.warn({ request_id: requestId }, '[webhook] HMAC invalid — rejecting');
        return reply.code(401).send({
          request_id: requestId,
          error: { code: 'HMAC_INVALID', message: 'Webhook authentication failed' },
        });
      }

      // ── Step 2: Brand resolution via SECURITY DEFINER fn (D-4) ───────────
      // The X-Shopify-Shop-Domain header is used ONLY as a lookup key.
      // brand_id comes from the DB row — never from the header.
      const shopDomain = req.headers['x-shopify-shop-domain'] ?? '';
      if (!shopDomain) {
        req.log?.warn({ request_id: requestId }, '[webhook] missing x-shopify-shop-domain');
        return reply.code(401).send({
          request_id: requestId,
          error: { code: 'NO_SHOP_DOMAIN', message: 'Webhook authentication failed' },
        });
      }

      let connectorRow: ConnectorDispatchRow | null = null;
      try {
        // resolve_connector_by_shop_domain is SECURITY DEFINER — runs as 'brain',
        // bypasses FORCE RLS. No GUC needed at this step (we don't know the brand yet).
        const result = await rawPgPool.query<ConnectorDispatchRow>(
          `SELECT connector_instance_id, brand_id, shop_domain, secret_ref
           FROM resolve_connector_by_shop_domain($1)`,
          [shopDomain],
        );
        connectorRow = result.rows[0] ?? null;
      } catch (dbErr) {
        req.log?.error({ request_id: requestId, err: dbErr }, '[webhook] connector lookup failed');
        return reply.code(500).send({
          request_id: requestId,
          error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
        });
      }

      if (!connectorRow) {
        req.log?.warn(
          { request_id: requestId, shop_domain: shopDomain },
          '[webhook] no connector for shop — rejecting',
        );
        return reply.code(401).send({
          request_id: requestId,
          error: { code: 'CONNECTOR_NOT_FOUND', message: 'Webhook authentication failed' },
        });
      }

      // brand_id is authoritative from the DB row (never from header/body — D-4 / MT-1)
      const brandId = connectorRow.brand_id;
      const connectorInstanceId = connectorRow.connector_instance_id;
      const topic = req.params.topic;

      // ── Raw-webhook archive (structure-visible, PII-safe) ─────────────────
      // Persist the RAW BODY SHAPE (PII leaves masked — I-S02) so operators can
      // inspect "what did Shopify actually send". Runs for EVERY topic (incl.
      // non-order), only AFTER HMAC + brand resolution so it is authenticated and
      // tenant-scoped. Fire-and-forget — must never block or fail the 200 ack.
      archiveRawWebhook(rawPgPool, brandId, topic, rawBody, req.body, correlationId, requestId).catch(
        (archiveErr) => {
          req.log?.warn(
            { request_id: requestId, err: archiveErr },
            '[webhook] raw-archive write failed (non-fatal)',
          );
        },
      );

      // ── Step 3: Parse + map order (hashed PII only — I-S02) ───────────────
      // Only process order events. Non-order topics → 200 fast-ack (no-op).
      const ORDER_TOPICS = new Set([
        'orders/create',
        'orders/updated',
        'orders/paid',
        'orders/fulfilled',
        'orders/cancelled',
      ]);

      if (!ORDER_TOPICS.has(topic)) {
        // Accept and discard non-order webhook topics (future topics land here safely).
        req.log?.info(
          { request_id: requestId, topic },
          '[webhook] non-order topic — fast-ack without processing',
        );
        return reply.code(200).send({ request_id: requestId, received: true });
      }

      const body = req.body as Record<string, unknown>;
      // Shopify wraps the order under the resource key for some topics, or at root.
      const orderRaw = (body['order'] as Record<string, unknown> | undefined) ?? body;

      // Validate required fields before mapping
      if (typeof orderRaw['id'] !== 'number' && typeof orderRaw['id'] !== 'string') {
        req.log?.warn({ request_id: requestId, topic }, '[webhook] order body missing id — discarding');
        return reply.code(200).send({ request_id: requestId, received: true });
      }

      const order = orderRaw as unknown as ShopifyOrderShape;
      // SEC-LV-L1: guard the state-change timestamp. Shopify always sends updated_at in practice,
      // but if all three date fields are missing/unparseable, new Date(undefined).getTime() is NaN —
      // which would poison the event_id (uuidV5FromOrderLive) and break per-state-change dedup.
      // A dateless order is a malformed webhook: fast-ack 200 and discard (same as the id check above).
      const updatedAt = order.updated_at ?? order.processed_at ?? order.created_at;
      const updatedAtUtcMs = updatedAt ? new Date(updatedAt).getTime() : NaN;
      if (Number.isNaN(updatedAtUtcMs)) {
        req.log?.warn(
          { request_id: requestId, topic },
          '[webhook] order missing/unparseable date — discarding',
        );
        return reply.code(200).send({ request_id: requestId, received: true });
      }

      // ── Step 4: Build CollectorEventV1 envelope ────────────────────────────
      // event_id = uuidV5FromOrderLive(brandId, orderId, updatedAtUtcMs) (D-6 / ADR-LV-6)
      const orderId = String(order.id);
      const eventId = uuidV5FromOrderLive(brandId, orderId, updatedAtUtcMs);

      let saltHex: string;
      try {
        saltHex = await getSaltHex(brandId);
      } catch (saltErr) {
        req.log?.error(
          { request_id: requestId, brand_id: brandId },
          '[webhook] salt fetch failed — cannot hash PII safely',
        );
        return reply.code(500).send({
          request_id: requestId,
          error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
        });
      }

      // mapOrderToEvent hashes PII before returning — raw email/phone never leave this scope (I-S02)
      const mapped = mapOrderToEvent(order, saltHex, 'IN', ORDER_LIVE_V1_EVENT_NAME);

      const envelope = CollectorEventV1Schema.parse({
        schema_version: '1' as const,
        event_id: eventId,
        brand_id: brandId, // from connector row, NEVER from header/body (D-4 / MT-1)
        correlation_id: correlationId,
        event_name: mapped.event_name,
        occurred_at: mapped.occurred_at,
        ingested_at: new Date().toISOString(),
        properties: mapped.properties as unknown as Record<string, unknown>,
      });

      // ── Step 5: Produce to live Redpanda topic (ADR-LV-3 / D-3) ──────────
      // Direct produce — same durability profile as the backfill's direct produce.
      // Partition key = brand_id (tenant partition isolation).
      try {
        await producer.send({
          topic: liveTopic,
          messages: [
            {
              key: brandId,
              value: Buffer.from(JSON.stringify(envelope)),
              headers: {
                correlation_id: Buffer.from(correlationId),
                event_name: Buffer.from(ORDER_LIVE_V1_EVENT_NAME),
              },
            },
          ],
        });
      } catch (kafkaErr) {
        req.log?.error(
          { request_id: requestId, event_id: eventId },
          '[webhook] Kafka produce failed',
        );
        // Return 500 so Shopify retries — do NOT fast-ack on a failed produce.
        return reply.code(500).send({
          request_id: requestId,
          error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
        });
      }

      req.log?.info(
        {
          request_id: requestId,
          event_id: eventId,
          brand_id: brandId,
          topic: liveTopic,
          order_id: orderId,
        },
        '[webhook] event produced to live lane',
      );

      // ── Step 6: Touch connector_sync_status.last_sync_at (ADR-LV-10 / D-11) ─
      // Fire-and-forget: do not let a sync_status update failure block the 200 ack.
      // Uses a single transaction with GUC set (txn-local) before the UPDATE.
      touchSyncStatus(rawPgPool, brandId, connectorInstanceId, requestId, req).catch(
        (syncErr) => {
          req.log?.warn(
            { request_id: requestId, err: syncErr },
            '[webhook] sync_status touch failed (non-fatal)',
          );
        },
      );

      // ── Step 6b: Deterministic cart-stitch upsert (feat-journey-touchpoint §3) ─
      // Read brain_anon_id (+ utm / click_ids) BACK from the order note_attributes
      // (D-5 — never inferred) and upsert connector_journey_stitch_map by
      // (brand_id, order_id). Idempotent on webhook re-delivery (PK upsert). Fire-and-forget
      // (never block the 200 ack). Only writes when the anon key was actually present.
      const stitch = projectOrderStitch(order);
      if (stitch.stitchedAnonId) {
        upsertStitchMap(rawPgPool, brandId, orderId, stitch, requestId).catch((stitchErr) => {
          req.log?.warn(
            { request_id: requestId, err: stitchErr },
            '[webhook] cart-stitch upsert failed (non-fatal)',
          );
        });
      }

      // ── Step 7: 200 fast-ack ───────────────────────────────────────────────
      // Shopify retries on non-2xx. We ack quickly after successful Kafka produce.
      return reply.code(200).send({ request_id: requestId, received: true });
    },
  );
}

// ── connector_webhook_raw_archive write ─────────────────────────────────────────

/**
 * Archive the raw webhook body in structure-visible, PII-safe form (0050 / I-S02).
 *
 * - body_sha256 = sha256 of the ORIGINAL raw bytes (integrity + dedup key). Identical
 *   re-delivery → ON CONFLICT DO NOTHING (idempotent); a state change ships a different
 *   body → a new row, preserving the shape history.
 * - redacted_body = redactShopifyPii(parsed) — every key/shape kept, PII leaves masked.
 *   Raw email/phone/address NEVER reach the DB.
 * - Writes under the brand GUC in a txn (FORCE RLS), same pattern as touchSyncStatus.
 */
async function archiveRawWebhook(
  rawPgPool: pg.Pool,
  brandId: string,
  topic: string,
  rawBody: Buffer,
  parsedBody: unknown,
  correlationId: string,
  _requestId: string,
): Promise<void> {
  const bodySha256 = createHash('sha256').update(rawBody).digest('hex');
  const redacted = redactShopifyPii(parsedBody);
  const client = await rawPgPool.connect();
  try {
    await client.query('BEGIN');
    // GUC txn-local: required for connector_webhook_raw_archive FORCE RLS (NN-1 / 0050).
    await client.query(`SET LOCAL app.current_brand_id = $1`, [brandId]);
    await client.query(
      `INSERT INTO connector_webhook_raw_archive
         (brand_id, source, topic, body_sha256, received_at, correlation_id, redacted_body)
       VALUES ($1, 'shopify', $2, $3, NOW(), $4, $5)
       ON CONFLICT (brand_id, topic, body_sha256) DO NOTHING`,
      [brandId, topic, bodySha256, correlationId, JSON.stringify(redacted)],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// ── connector_sync_status touch ───────────────────────────────────────────────

/**
 * Touch connector_sync_status.last_sync_at + state='connected' under brand GUC.
 * Uses a raw pg client (not the GUC-middleware pool) so we can set the GUC manually
 * in a txn before the UPDATE.
 *
 * The UPSERT semantics: insert if absent (first webhook after connect), update if exists.
 */
async function touchSyncStatus(
  rawPgPool: pg.Pool,
  brandId: string,
  connectorInstanceId: string,
  requestId: string,
  log: { log?: { warn: (obj: object, msg: string) => void } },
): Promise<void> {
  const client = await rawPgPool.connect();
  try {
    await client.query('BEGIN');
    // GUC txn-local: required for connector_sync_status FORCE RLS (E-4 / ADR-LV-4)
    await client.query(`SET LOCAL app.current_brand_id = $1`, [brandId]);
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

// ── connector_journey_stitch_map upsert (feat-journey-touchpoint §3) ────────────

/**
 * Deterministic cart-stitch upsert (D-5): persist brain_anon_id (+ utm / click_ids)
 * read BACK from the order under the brand GUC. Idempotent on (brand_id, order_id) —
 * webhook re-delivery re-writes the same row (no new rows). brain_id is left NULL here
 * (honest — the identity-graph resolution is a follow-on; NULL = anon not yet linked).
 */
async function upsertStitchMap(
  rawPgPool: pg.Pool,
  brandId: string,
  orderId: string,
  stitch: { stitchedAnonId: string | null; clickIds: unknown; utms: unknown },
  _requestId: string,
): Promise<void> {
  if (!stitch.stitchedAnonId) return;
  const client = await rawPgPool.connect();
  try {
    await client.query('BEGIN');
    // GUC txn-local: required for connector_journey_stitch_map FORCE RLS (NN-1 / 0031).
    await client.query(`SET LOCAL app.current_brand_id = $1`, [brandId]);
    await client.query(
      `INSERT INTO connector_journey_stitch_map
         (brand_id, order_id, stitched_anon_id, click_ids, utms)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (brand_id, order_id) DO UPDATE
         SET stitched_anon_id = EXCLUDED.stitched_anon_id,
             click_ids        = EXCLUDED.click_ids,
             utms             = EXCLUDED.utms`,
      [
        brandId,
        orderId,
        stitch.stitchedAnonId,
        stitch.clickIds ? JSON.stringify(stitch.clickIds) : null,
        stitch.utms ? JSON.stringify(stitch.utms) : null,
      ],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
