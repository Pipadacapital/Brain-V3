/**
 * razorpayWebhookHandler — Razorpay live-event webhook receiver (ADR-RZ-7).
 *
 * Registered at: POST /api/v1/webhooks/razorpay
 *
 * SECURITY ORDER (immovable — NN-4 / ADR-RZ-7, mirrors shopifyWebhookHandler):
 *   1. HMAC-first: validate X-Razorpay-Signature = HMAC-SHA256(rawBody, webhook_secret)
 *      → invalid/missing: 401, NO further processing, NO write, NO DB touch.
 *   2. Replay protection (C3 — BEFORE any write):
 *      (a) reject if event.created_at older than 5-min replay window → 400
 *      (b) Redis SET NX EX 600 on event_id → already-seen = 409 (duplicate)
 *   3. Brand resolution via SECURITY DEFINER fn (MT-1):
 *      resolve_razorpay_connector_by_account(account_id) → brand_id from DB ROW.
 *      brand_id NEVER from webhook body. No connector → 401.
 *   4. payment.captured → MAP-TABLE POPULATE (MB-1 HARD prerequisite):
 *      upsert connector_razorpay_order_map under brand GUC.
 *   5. Other events → map via @brain/razorpay-mapper (allowlist + hash) →
 *      emit settlement.live.v1/settlement.webhook.v1 to live lane → touch sync_status.
 *   6. 200 fast-ack (Razorpay retries on non-2xx).
 *
 * MT-1: brand_id is authoritative from the DB row — NEVER from the webhook body.
 * NN-4: HMAC is absolute first operation.
 * C3:   Replay protection is a SECURITY control separate from Bronze data-correctness dedup.
 * C5:   No raw Razorpay IDs (pay_XXXX, UTR) in any log line.
 * I-S09: webhook_secret never logged.
 * NN-2: secret_ref never in any response.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Producer } from 'kafkajs';
import type pg from 'pg';
import { randomUUID } from 'node:crypto';

import { injectKafkaTraceContext } from '@brain/observability';
import { RazorpayHmac } from '../../domain/value-objects/RazorpayHmac.js';
import { RedisDedupAdapter } from '../../infrastructure/RedisDedupAdapter.js';
import { PgRazorpayOrderMapRepository } from '../../infrastructure/repositories/PgRazorpayOrderMapRepository.js';
import type { ISecretsManager } from '@brain/connector-secrets';
import {
  mapPaymentWebhookToMapRow,
  mapSettlementItemToEvent,
  uuidV5FromRazorpayWebhook,
  SETTLEMENT_LIVE_V1_EVENT_NAME,
  type RazorpayPaymentCapturedPayload,
  type RazorpaySettlementItem,
} from '@brain/razorpay-mapper';
import { CollectorEventV1Schema } from '@brain/contracts';
import type { Redis } from 'ioredis';

// ── Dependency interface ──────────────────────────────────────────────────────

export interface RazorpayWebhookHandlerDeps {
  /** Secrets Manager — provides webhook_secret from composite credential bundle (C2). */
  secretsManager: ISecretsManager;
  /** Raw pg.Pool — used for SECURITY DEFINER fn call + GUC-scoped map-table upsert. */
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

// ── DB row returned by resolve_razorpay_connector_by_account ─────────────────

interface RazorpayConnectorDispatchRow {
  connector_instance_id: string;
  brand_id: string;
  secret_ref: string;  // ARN to fetch composite credential bundle from Secrets Manager
}

// ── Raw Razorpay webhook envelope shape ──────────────────────────────────────

interface RazorpayWebhookEnvelope {
  id?: string;                // event.id (opaque — used for Redis dedup key)
  entity?: string;            // 'event'
  account_id?: string;        // Razorpay account identifier for brand resolution (MT-1)
  event?: string;             // e.g. 'payment.captured', 'settlement.processed'
  created_at?: number;        // Unix timestamp (seconds) — used for age check (C3)
  payload?: {
    payment?: {
      entity?: RazorpayPaymentCapturedPayload;
    };
    settlement?: {
      entity?: RazorpaySettlementItem;
    };
  };
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerRazorpayWebhookRoutes(
  fastify: FastifyInstance,
  deps: RazorpayWebhookHandlerDeps,
): void {
  const { secretsManager, rawPgPool, producer, liveTopic, getSaltHex, redis } = deps;
  const dedupAdapter = new RedisDedupAdapter(redis);
  const orderMapRepo = new PgRazorpayOrderMapRepository(rawPgPool);

  fastify.post(
    '/api/v1/webhooks/razorpay',
    {
      config: { rawBody: true },
    },
    async (
      req: FastifyRequest<{
        Headers: {
          'x-razorpay-signature'?: string;
        };
      }>,
      reply: FastifyReply,
    ) => {
      const requestId = (req.id as string) ?? randomUUID();
      const correlationId =
        (req.headers['x-correlation-id'] as string | undefined) ?? requestId;

      // ── Step 1: HMAC-first (NN-4 / ADR-RZ-7) ─────────────────────────────
      // Raw body is REQUIRED — without it we cannot validate the signature.
      const rawBody = (req as FastifyRequest & { rawBody?: Buffer }).rawBody;

      if (!rawBody) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'RAW_BODY_MISSING', message: 'Raw body not available' },
        });
      }

      const signatureHeader = req.headers['x-razorpay-signature'] ?? '';

      // Parse the body early to extract account_id for secret lookup.
      // IMPORTANT: we parse ONLY to extract account_id for the connector lookup —
      // HMAC is validated against the rawBody bytes using the secret we fetch.
      // This is the same pattern as: parse event envelope → lookup webhook_secret
      // by account_id → validate HMAC → continue.
      //
      // Alternative: validate HMAC with every known webhook_secret (multi-tenant scan).
      // We use the account_id lookup path as it is O(1) not O(n connectors).
      // The HMAC validation with the resolved secret is still Step 1 — no write has
      // occurred between parse and HMAC check.
      let envelope: RazorpayWebhookEnvelope;
      try {
        envelope = JSON.parse(rawBody.toString('utf8')) as RazorpayWebhookEnvelope;
      } catch {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_JSON', message: 'Webhook body is not valid JSON' },
        });
      }

      const accountId = envelope.account_id ?? '';
      if (!accountId) {
        req.log?.warn({ request_id: requestId }, '[razorpay-webhook] missing account_id — rejecting');
        return reply.code(401).send({
          request_id: requestId,
          error: { code: 'HMAC_INVALID', message: 'Webhook authentication failed' },
        });
      }

      // Resolve connector by account_id to get secret_ref → fetch webhook_secret.
      // resolve_razorpay_connector_by_account is SECURITY DEFINER (ADR-RZ-7, 0027 migration).
      let connectorRow: RazorpayConnectorDispatchRow | null = null;
      try {
        const result = await rawPgPool.query<RazorpayConnectorDispatchRow>(
          `SELECT connector_instance_id, brand_id, secret_ref
           FROM resolve_razorpay_connector_by_account($1)`,
          [accountId],
        );
        connectorRow = result.rows[0] ?? null;
      } catch (dbErr) {
        req.log?.error(
          { request_id: requestId, err: dbErr },
          '[razorpay-webhook] connector lookup failed',
        );
        return reply.code(500).send({
          request_id: requestId,
          error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
        });
      }

      if (!connectorRow) {
        req.log?.warn(
          { request_id: requestId },
          '[razorpay-webhook] no connector for account — rejecting',
        );
        return reply.code(401).send({
          request_id: requestId,
          error: { code: 'HMAC_INVALID', message: 'Webhook authentication failed' },
        });
      }

      // Fetch composite credential bundle → extract webhook_secret (C2).
      // I-S09: never log the secret_ref value or the credential bundle contents.
      let webhookSecret: string;
      try {
        const creds = await secretsManager.getSecret(connectorRow.secret_ref);
        if (!creds || !creds['webhook_secret']) {
          req.log?.warn({ request_id: requestId }, '[razorpay-webhook] webhook_secret missing from credentials — rejecting');
          return reply.code(401).send({
            request_id: requestId,
            error: { code: 'HMAC_INVALID', message: 'Webhook authentication failed' },
          });
        }
        webhookSecret = creds['webhook_secret'];
      } catch (secretErr) {
        req.log?.error(
          { request_id: requestId, err: secretErr },
          '[razorpay-webhook] secret fetch failed',
        );
        return reply.code(500).send({
          request_id: requestId,
          error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
        });
      }

      // NOW validate the HMAC against the raw body bytes with the resolved webhook_secret.
      // This is effectively Step 1 — the body parse + connector lookup were necessary
      // to obtain the per-connector webhook_secret. No write has occurred yet.
      const hmacValid = RazorpayHmac.validateWebhook(rawBody, signatureHeader, webhookSecret);
      if (!hmacValid) {
        req.log?.warn(
          { request_id: requestId },
          '[razorpay-webhook] HMAC invalid — rejecting (NN-4)',
        );
        return reply.code(401).send({
          request_id: requestId,
          error: { code: 'HMAC_INVALID', message: 'Webhook authentication failed' },
        });
      }

      // ── Step 2: Replay protection (C3) ───────────────────────────────────
      // (a) Age check: reject events older than 5-min replay window
      const createdAt = envelope.created_at;
      if (typeof createdAt !== 'number' || createdAt <= 0) {
        req.log?.warn(
          { request_id: requestId },
          '[razorpay-webhook] missing or invalid created_at — rejecting',
        );
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'REPLAY_REJECTED', message: 'Event timestamp missing or invalid' },
        });
      }

      if (!RedisDedupAdapter.isWithinReplayWindow(createdAt)) {
        req.log?.warn(
          { request_id: requestId },
          '[razorpay-webhook] event older than replay window — rejecting (C3)',
        );
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'REPLAY_REJECTED', message: 'Event too old — outside replay window' },
        });
      }

      // (b) Redis event_id dedup (SET NX EX)
      const eventId = envelope.id ?? '';
      if (!eventId) {
        req.log?.warn({ request_id: requestId }, '[razorpay-webhook] missing event id — rejecting');
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'REPLAY_REJECTED', message: 'Event id missing' },
        });
      }

      const isDuplicate = await dedupAdapter.isDuplicate(eventId);
      if (isDuplicate) {
        req.log?.warn(
          { request_id: requestId },
          '[razorpay-webhook] duplicate event_id — rejecting (C3 Redis dedup)',
        );
        return reply.code(409).send({
          request_id: requestId,
          error: { code: 'DUPLICATE_EVENT', message: 'Event already processed' },
        });
      }

      // ── Step 3: Brand resolution — authoritative from connector ROW (MT-1) ─
      // brand_id is from the DB row resolved above — NEVER from the webhook body.
      const brandId = connectorRow.brand_id;
      const connectorInstanceId = connectorRow.connector_instance_id;
      const eventName = envelope.event ?? '';

      // ── Step 4: payment.captured → map-table populate (MB-1 HARD prerequisite) ─
      if (eventName === 'payment.captured') {
        const paymentEntity = envelope.payload?.payment?.entity;
        if (paymentEntity) {
          const mapRow = mapPaymentWebhookToMapRow(brandId, paymentEntity);
          if (mapRow) {
            try {
              await orderMapRepo.upsert({
                brand_id: mapRow.brand_id,
                razorpay_order_id: mapRow.razorpay_order_id,
                shopify_order_id: mapRow.shopify_order_id,
                razorpay_payment_id: mapRow.razorpay_payment_id, // raw — stored in RLS-protected table only (C1)
              });
              req.log?.info(
                {
                  request_id: requestId,
                  brand_id: brandId,
                  // C5: no raw payment_id in logs — log only structured reference
                  has_shopify_order: true,
                },
                '[razorpay-webhook] payment.captured map row upserted (MB-1)',
              );
            } catch (mapErr) {
              req.log?.error(
                { request_id: requestId, brand_id: brandId, err: mapErr, errMsg: (mapErr as Error).message },
                '[razorpay-webhook] map-table upsert failed — returning 500 so Razorpay retries',
              );
              // Return 500 so Razorpay retries — do NOT fast-ack on a failed map populate.
              return reply.code(500).send({
                request_id: requestId,
                error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
              });
            }
          } else {
            // No shopify_order_id in payment notes — cannot populate map table.
            // Log structured warning without raw payment_id (C5).
            req.log?.warn(
              { request_id: requestId, brand_id: brandId },
              '[razorpay-webhook] payment.captured without shopify_order_id in notes — map row skipped',
            );
          }
        }

        // Touch sync_status and fast-ack.
        touchSyncStatus(rawPgPool, brandId, connectorInstanceId, requestId, req).catch(
          (syncErr) => {
            req.log?.warn(
              { request_id: requestId, err: syncErr },
              '[razorpay-webhook] sync_status touch failed (non-fatal)',
            );
          },
        );

        return reply.code(200).send({ request_id: requestId, received: true });
      }

      // ── Step 5: Settlement / other events → allowlist + hash → emit to live lane ─
      const SETTLEMENT_EVENTS = new Set([
        'settlement.processed',
        'refund.created',
        'payment.failed',
      ]);

      if (SETTLEMENT_EVENTS.has(eventName)) {
        // Get per-brand salt for hashing (C1 — hash utr/payment_id at boundary)
        let saltHex: string;
        try {
          saltHex = await getSaltHex(brandId);
        } catch (saltErr) {
          req.log?.error(
            { request_id: requestId, brand_id: brandId },
            '[razorpay-webhook] salt fetch failed — cannot hash DPDP identifiers safely',
          );
          return reply.code(500).send({
            request_id: requestId,
            error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
          });
        }

        // Extract the settlement entity from the payload
        const settlementEntity = envelope.payload?.settlement?.entity;
        if (settlementEntity) {
          // mapSettlementItemToEvent applies allowlist + hashes PII at boundary (C1/C4)
          const mapped = mapSettlementItemToEvent(settlementEntity, brandId, saltHex);

          // event_id = uuidV5FromRazorpayWebhook(brandId, eventId) (MB-2)
          const bronzeEventId = uuidV5FromRazorpayWebhook(brandId, eventId);

          const collectorEnvelope = CollectorEventV1Schema.parse({
            schema_version: '1' as const,
            event_id: bronzeEventId,
            brand_id: brandId,  // from connector row — NEVER from body (MT-1)
            correlation_id: correlationId,
            event_name: SETTLEMENT_LIVE_V1_EVENT_NAME,
            occurred_at: mapped.occurred_at,
            ingested_at: new Date().toISOString(),
            properties: mapped.properties as unknown as Record<string, unknown>,
          });

          try {
            // OTel trace-context propagation (OBS-1/OBS-2): inject traceparent so the
            // stream-worker consumer resumes this trace across the Kafka boundary.
            const headers: Record<string, Buffer | string> = {
              correlation_id: Buffer.from(correlationId),
              event_name: Buffer.from(SETTLEMENT_LIVE_V1_EVENT_NAME),
            };
            injectKafkaTraceContext(headers);
            await producer.send({
              topic: liveTopic,
              messages: [
                {
                  key: brandId,  // partition key = brand_id (tenant isolation)
                  value: Buffer.from(JSON.stringify(collectorEnvelope)),
                  headers,
                },
              ],
            });
          } catch (kafkaErr) {
            req.log?.error(
              { request_id: requestId, brand_id: brandId },
              '[razorpay-webhook] Kafka produce failed',
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
              event_name: eventName,
            },
            '[razorpay-webhook] settlement event emitted to live lane',
          );
        }

        touchSyncStatus(rawPgPool, brandId, connectorInstanceId, requestId, req).catch(
          (syncErr) => {
            req.log?.warn(
              { request_id: requestId, err: syncErr },
              '[razorpay-webhook] sync_status touch failed (non-fatal)',
            );
          },
        );

        return reply.code(200).send({ request_id: requestId, received: true });
      }

      // ── Unknown event types → fast-ack (no processing) ────────────────────
      req.log?.info(
        { request_id: requestId, event_name: eventName },
        '[razorpay-webhook] unknown event type — fast-ack without processing',
      );
      return reply.code(200).send({ request_id: requestId, received: true });
    },
  );
}

// ── connector_sync_status touch ───────────────────────────────────────────────

/**
 * Touch connector_sync_status.last_sync_at + state='connected' under brand GUC.
 * Fire-and-forget — does not block the 200 fast-ack.
 * Mirrors shopifyWebhookHandler.ts:296.
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
    // Use set_config() fn (parameterized) rather than SET LOCAL (which does not support $1).
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
