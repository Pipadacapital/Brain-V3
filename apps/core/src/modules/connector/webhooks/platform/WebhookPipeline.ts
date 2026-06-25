/**
 * WebhookPipeline — Template Method for all inbound webhook providers.
 *
 * COMMON STEPS (this class, immovable order — NN-4):
 *   1. Capture raw body.
 *   2. signatureVerify (Strategy) — HMAC-first gate. Any failure → 401, no write.
 *   3. Brand resolution from DB (SECURITY DEFINER fn via rawPgPool).
 *   4. Raw archive write (fire-and-forget, all 4 providers).
 *   5. Age-window gate + Redis dedup (provider-scoped key prefix).
 *   6. payloadMap (Strategy) — parse + PII hash.
 *   7. Idempotent Kafka produce (partition key = brand_id).
 *   8. Provider side-effects (e.g. map-table upsert).
 *   9. Touch connector_sync_status.
 *  10. 200 fast-ack.
 *
 * OBSERVABILITY (ADR-009):
 *   - OTel span 'webhook.ingest' with brand_id + correlation_id + provider.
 *   - webhook_produce_failed_total counter on Kafka produce failure.
 *   - connector_auth_rejected_total counter on HMAC failure.
 *
 * RATE LIMITING:
 *   - Per-IP sliding-window via Redis (ZRANGEBYSCORE / ZADD). Fail-open on Redis error.
 *   - Applied before body parsing (cheapest rejection path).
 *
 * PER-PROVIDER BITS (Strategy):
 *   - signatureVerify (HmacConfig.validateWebhook + lookup key extraction).
 *   - payloadMap (PII hash at boundary, CollectorEventV1 shape, dedup key).
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Producer } from 'kafkajs';
import type pg from 'pg';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';

import type { ISecretsManager } from '@brain/connector-secrets';
import { CollectorEventV1Schema } from '@brain/contracts';
import { incrementCounter, startSpan, injectKafkaTraceContext } from '@brain/observability';

import type { IWebhookStrategy, WebhookIdentityReader } from './IWebhookStrategy.js';
import { ProviderRedisDedupAdapter } from '../infrastructure/ProviderRedisDedupAdapter.js';
import { RawArchiveRepository } from '../infrastructure/RawArchiveRepository.js';

// ── Per-IP sliding-window rate-limit ──────────────────────────────────────────

// intentional: module-level constants read at import time. Fields exist in @brain/config
// (WEBHOOK_IP_RATE_LIMIT_MAX/_WINDOW_SECONDS) but loadCoreConfig() validates the WHOLE schema
// (incl. required DATABASE_URL) and process.exit(1)s on failure — calling it at module-load would
// crash unit imports that don't set full env. Left raw to preserve zero import-time behaviour change.
const IP_RATE_LIMIT_MAX = parseInt(process.env['WEBHOOK_IP_RATE_LIMIT_MAX'] ?? '60', 10);
const IP_RATE_LIMIT_WINDOW_SECONDS = parseInt(process.env['WEBHOOK_IP_RATE_LIMIT_WINDOW_SECONDS'] ?? '60', 10);

/**
 * Per-IP sliding-window rate-limit using Redis sorted-set.
 * Key: 'webhook:ratelimit:<provider>:<ip>'
 * Sorted set member = requestId (unique per call), score = now_ms.
 * Returns true if over the limit. Fail-open on Redis error.
 */
async function checkIpRateLimit(
  redis: Redis,
  provider: string,
  ip: string,
): Promise<boolean> {
  const key = `webhook:ratelimit:${provider}:${ip}`;
  const now = Date.now();
  const windowStart = now - IP_RATE_LIMIT_WINDOW_SECONDS * 1000;
  try {
    const pipeline = redis.pipeline();
    pipeline.zremrangebyscore(key, 0, windowStart);           // evict stale
    pipeline.zadd(key, now, `${now}-${Math.random()}`);      // add this request
    pipeline.zcard(key);                                       // count within window
    pipeline.expire(key, IP_RATE_LIMIT_WINDOW_SECONDS + 5);   // TTL
    const results = await pipeline.exec();
    const cardResult = results?.[2];
    const count = (cardResult?.[1] as number | null) ?? 0;
    return count > IP_RATE_LIMIT_MAX;
  } catch {
    return false; // fail-open
  }
}

// ── DB row returned by any resolve_<provider>_connector_by_<key> fn ──────────

export interface ConnectorDispatchRow {
  connector_instance_id: string;
  brand_id: string;
  secret_ref: string;
  shop_domain?: string;
}

// ── Pipeline dependencies ─────────────────────────────────────────────────────

export interface WebhookPipelineDeps {
  secretsManager: ISecretsManager;
  rawPgPool: pg.Pool;
  producer: Producer;
  liveTopic: string;
  getSaltHex: (brandId: string) => Promise<string>;
  redis: Redis;
  regionCode?: string;
  /** MEDALLION REALIGNMENT (Epic 3 / ADR-0004): Neo4j identity reader for GDPR redact side-effects. */
  identityReader?: WebhookIdentityReader;
}

// ── Route config per provider ─────────────────────────────────────────────────

export interface WebhookRouteConfig {
  /** URL path — may include params (e.g. '/api/v1/webhooks/shopify/:topic'). */
  path: string;
  /**
   * Resolve fn SQL: the SECURITY DEFINER function name + $1 param shape.
   * Called as `SELECT connector_instance_id, brand_id, secret_ref FROM <fn>($1)`.
   */
  resolverFn: string;
  /**
   * How to extract the resolver argument from the request (after raw body is available).
   * Returns null if the arg cannot be determined (→ 401).
   */
  resolverArg: (req: FastifyRequest, parsedBody: unknown) => string | null;
  /**
   * How to extract the topic label for the raw archive (provider-specific).
   * Returns 'unknown' if not determinable.
   */
  topicLabel: (req: FastifyRequest, parsedBody: unknown) => string;
}

// ── WebhookPipeline ───────────────────────────────────────────────────────────

export class WebhookPipeline {
  private readonly dedupAdapter: ProviderRedisDedupAdapter;
  private readonly archiveRepo: RawArchiveRepository;

  constructor(
    private readonly strategy: IWebhookStrategy,
    private readonly routeConfig: WebhookRouteConfig,
    private readonly deps: WebhookPipelineDeps,
  ) {
    this.dedupAdapter = new ProviderRedisDedupAdapter(deps.redis, strategy.provider);
    this.archiveRepo = new RawArchiveRepository(deps.rawPgPool);
  }

  /**
   * Register this pipeline as a POST route on the Fastify instance.
   * Uses the path from routeConfig.
   */
  register(fastify: FastifyInstance): void {
    const { path } = this.routeConfig;
    const self = this;
    fastify.post(path, { config: { rawBody: true } }, async (req, reply) => {
      return self.handleRequest(req, reply);
    });
  }

  /**
   * Public entry point for the pipeline handler.
   * Can be called directly from a wrapping Fastify route (e.g. the Shopify topic-injection route).
   */
  async handleRequest(req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    return this.handle(req, reply);
  }

  // ── Template Method ─────────────────────────────────────────────────────────

  private async handle(req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    const requestId = (req.id as string) ?? randomUUID();
    const correlationId = (req.headers['x-correlation-id'] as string | undefined) ?? requestId;
    const provider = this.strategy.provider;

    // ── Rate limit (per-IP, sliding-window, cheapest path first) ──────────────
    const ip = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
    const overLimit = await checkIpRateLimit(this.deps.redis, provider, ip);
    if (overLimit) {
      req.log?.warn({ request_id: requestId, provider, ip }, '[webhook] rate limit exceeded');
      return reply.code(429).send({
        request_id: requestId,
        error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests' },
      });
    }

    // OTel span (webhook.ingest) — brand_id unknown until brand is resolved below.
    // We start the span with a placeholder and fill in brand_id once resolved.
    const span = startSpan('webhook.ingest', {
      brandId: 'unresolved',
      correlationId,
      serviceName: 'core',
    });
    span.setAttribute('webhook.provider', provider);
    span.setAttribute('request.id', requestId);

    try {
      // ── Step 1: Raw body ─────────────────────────────────────────────────────
      const rawBody = (req as FastifyRequest & { rawBody?: Buffer }).rawBody;
      if (!rawBody) {
        span.end();
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'RAW_BODY_MISSING', message: 'Raw body not available' },
        });
      }

      // ── Step 2: HMAC-first (Strategy) — NN-4 ────────────────────────────────
      let verifyResult: Awaited<ReturnType<IWebhookStrategy['signatureVerify']>>;
      try {
        verifyResult = await this.strategy.signatureVerify(
          rawBody,
          req.headers,
          async (lookupKey) => {
            // Fetch the connector row by the provider-specific lookup key.
            // resolve_<provider>_connector_by_<key> is SECURITY DEFINER (bypasses RLS)
            // so we can resolve without knowing the brand yet.
            const result = await this.deps.rawPgPool.query<ConnectorDispatchRow>(
              `SELECT connector_instance_id, brand_id, secret_ref
               FROM ${this.routeConfig.resolverFn}($1)`,
              [lookupKey],
            );
            const row = result.rows[0] ?? null;
            if (!row) return { webhookSecret: '', connectorLookupKey: lookupKey };
            // Fetch webhook_secret from Secrets Manager (I-S09: never logged).
            const creds = await this.deps.secretsManager.getSecret(row.secret_ref);
            if (!creds || !creds['webhook_secret']) {
              incrementCounter('connector_auth_rejected_total', { provider });
              return { webhookSecret: '', connectorLookupKey: lookupKey };
            }
            return { webhookSecret: creds['webhook_secret'], connectorLookupKey: lookupKey };
          },
        );
      } catch (err) {
        const code = (err as { code?: string }).code ?? 'HMAC_INVALID';
        incrementCounter('connector_auth_rejected_total', { provider });
        req.log?.warn({ request_id: requestId, provider, code }, '[webhook] auth failed');
        span.setAttribute('webhook.auth_failure', code);
        span.end();
        const httpStatus = code === 'INVALID_JSON' ? 400 : 401;
        return reply.code(httpStatus).send({
          request_id: requestId,
          error: { code, message: 'Webhook authentication failed' },
        });
      }

      // ── Step 3: Brand resolution from DB (MT-1) ──────────────────────────────
      // Resolve connector row by the provider-specific lookup key.
      // brand_id is authoritative from the DB row — NEVER from header/body (D-4 / MT-1).
      let connectorRow: ConnectorDispatchRow | null = null;
      try {
        const result = await this.deps.rawPgPool.query<ConnectorDispatchRow>(
          `SELECT connector_instance_id, brand_id, secret_ref
           FROM ${this.routeConfig.resolverFn}($1)`,
          [verifyResult.lookupKey],
        );
        connectorRow = result.rows[0] ?? null;
      } catch (dbErr) {
        req.log?.error({ request_id: requestId, err: dbErr, provider }, '[webhook] connector lookup failed');
        span.recordException(dbErr instanceof Error ? dbErr : new Error(String(dbErr)));
        span.end();
        return reply.code(500).send({
          request_id: requestId,
          error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
        });
      }

      if (!connectorRow) {
        req.log?.warn({ request_id: requestId, provider }, '[webhook] no connector — rejecting');
        incrementCounter('connector_auth_rejected_total', { provider });
        span.end();
        return reply.code(401).send({
          request_id: requestId,
          error: { code: 'CONNECTOR_NOT_FOUND', message: 'Webhook authentication failed' },
        });
      }

      const brandId = connectorRow.brand_id;
      const connectorInstanceId = connectorRow.connector_instance_id;
      span.setAttribute('brand_id', brandId);
      span.setAttribute('connector.instance_id', connectorInstanceId);

      // ── Step 4: Raw archive (fire-and-forget, all providers — NN-1 / I-S02) ──
      // The strategy provides a redacted body (PII leaves masked) via the payloadMap result;
      // at this stage we archive the minimal shape pre-map. Callers must supply the
      // topic label for archive categorisation.
      const topicLabel = this.routeConfig.topicLabel(req, verifyResult.parsedPayload);
      this.archiveRepo
        .write({
          brandId,
          provider,
          topic: topicLabel,
          rawBody,
          redactedBody: verifyResult.parsedPayload ?? {}, // strategy may pre-parse for us
          correlationId,
        })
        .catch((archiveErr: unknown) => {
          req.log?.warn(
            { request_id: requestId, provider, err: archiveErr },
            '[webhook] raw-archive write failed (non-fatal)',
          );
        });

      // ── Steps 5–7: payloadMap (Strategy) ─────────────────────────────────────
      let saltHex: string;
      try {
        saltHex = await this.deps.getSaltHex(brandId);
      } catch (saltErr) {
        req.log?.error({ request_id: requestId, brand_id: brandId }, '[webhook] salt fetch failed');
        span.recordException(saltErr instanceof Error ? saltErr : new Error(String(saltErr)));
        span.end();
        return reply.code(500).send({
          request_id: requestId,
          error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
        });
      }

      let mapped: Awaited<ReturnType<IWebhookStrategy['payloadMap']>>;
      try {
        mapped = await this.strategy.payloadMap({
          rawBody,
          headers: req.headers,
          parsedBody: verifyResult.parsedPayload,
          brandId,
          saltHex,
          regionCode: this.deps.regionCode ?? 'IN',
          correlationId,
          requestId,
        });
      } catch (mapErr) {
        const code = (mapErr as { code?: string }).code ?? 'INVALID_PAYLOAD';
        req.log?.warn({ request_id: requestId, brand_id: brandId, code }, '[webhook] payloadMap failed');
        span.end();
        return reply.code(400).send({
          request_id: requestId,
          error: { code, message: (mapErr as Error).message ?? 'Payload mapping failed' },
        });
      }

      // Fast-ack non-order / unknown topics (skip = true from Strategy).
      if (mapped.skip) {
        span.setAttribute('webhook.skipped', true);
        span.end();
        return reply.code(200).send({ request_id: requestId, received: true });
      }

      // ── Age-window gate (C3) ──────────────────────────────────────────────────
      if (mapped.ageCheckTimestampSeconds !== null) {
        if (typeof mapped.ageCheckTimestampSeconds !== 'number' || mapped.ageCheckTimestampSeconds <= 0) {
          span.end();
          return reply.code(400).send({
            request_id: requestId,
            error: { code: 'REPLAY_REJECTED', message: 'Event timestamp missing or invalid' },
          });
        }
        if (!ProviderRedisDedupAdapter.isWithinReplayWindow(mapped.ageCheckTimestampSeconds)) {
          req.log?.warn({ request_id: requestId, provider }, '[webhook] event outside replay window — C3');
          span.end();
          return reply.code(400).send({
            request_id: requestId,
            error: { code: 'REPLAY_REJECTED', message: 'Event too old — outside replay window' },
          });
        }
      }

      // ── Redis dedup (C3) ──────────────────────────────────────────────────────
      const dedupKey = mapped.dedupKey ?? mapped.eventId;
      const isDuplicate = await this.dedupAdapter.isDuplicate(dedupKey);
      if (isDuplicate) {
        req.log?.warn({ request_id: requestId, provider }, '[webhook] duplicate event — C3 Redis dedup');
        span.end();
        return reply.code(409).send({
          request_id: requestId,
          error: { code: 'DUPLICATE_EVENT', message: 'Event already processed' },
        });
      }

      // ── Build CollectorEventV1 envelope ───────────────────────────────────────
      const envelope = CollectorEventV1Schema.parse({
        schema_version: '1' as const,
        event_id: mapped.eventId,
        brand_id: brandId, // from connector row — NEVER from header/body (MT-1)
        correlation_id: correlationId,
        event_name: mapped.eventName,
        occurred_at: mapped.occurredAt,
        ingested_at: new Date().toISOString(),
        properties: mapped.properties,
      });

      // ── Idempotent Kafka produce (ADR-LV-3) ──────────────────────────────────
      // Partition key = brand_id (tenant isolation). Fail → 500 so provider retries.
      try {
        // OTel trace-context propagation (OBS-1/OBS-2): inject traceparent so the
        // stream-worker consumer resumes this trace across the Kafka boundary.
        const headers: Record<string, Buffer | string> = {
          correlation_id: Buffer.from(correlationId),
          event_name: Buffer.from(mapped.eventName),
        };
        injectKafkaTraceContext(headers);
        await this.deps.producer.send({
          topic: this.deps.liveTopic,
          messages: [
            {
              key: brandId,
              value: Buffer.from(JSON.stringify(envelope)),
              headers,
            },
          ],
        });
      } catch (kafkaErr) {
        incrementCounter('webhook_produce_failed_total', { provider });
        req.log?.error(
          { request_id: requestId, brand_id: brandId, event_id: mapped.eventId, provider },
          '[webhook] Kafka produce failed — returning 500 so provider retries',
        );
        span.recordException(kafkaErr instanceof Error ? kafkaErr : new Error(String(kafkaErr)));
        span.end();
        return reply.code(500).send({
          request_id: requestId,
          error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
        });
      }

      req.log?.info(
        { request_id: requestId, brand_id: brandId, event_id: mapped.eventId, provider, topic: this.deps.liveTopic },
        '[webhook] event produced to live lane',
      );

      // ── Provider side-effects (e.g. map-table upsert, cart-stitch) ─────────────
      if (mapped.sideEffect) {
        const sideEffect = mapped.sideEffect;
        if (mapped.throwOnSideEffectError) {
          // Blocking side-effect (Razorpay MB-1 map-table — fail 500 so Razorpay retries)
          try {
            await sideEffect(brandId, this.deps.rawPgPool, requestId, this.deps.identityReader);
          } catch (seErr) {
            req.log?.error(
              { request_id: requestId, brand_id: brandId, provider, err: seErr },
              '[webhook] side-effect failed — returning 500 so provider retries',
            );
            span.recordException(seErr instanceof Error ? seErr : new Error(String(seErr)));
            span.end();
            return reply.code(500).send({
              request_id: requestId,
              error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
            });
          }
        } else {
          // Fire-and-forget (cart-stitch, etc.)
          sideEffect(brandId, this.deps.rawPgPool, requestId, this.deps.identityReader).catch((seErr: unknown) => {
            req.log?.warn(
              { request_id: requestId, provider, err: seErr },
              '[webhook] side-effect failed (non-fatal)',
            );
          });
        }
      }

      // ── Touch connector_sync_status (D-11 / ADR-LV-10) ───────────────────────
      this.touchSyncStatus(brandId, connectorInstanceId, requestId).catch((syncErr: unknown) => {
        req.log?.warn(
          { request_id: requestId, provider, err: syncErr },
          '[webhook] sync_status touch failed (non-fatal)',
        );
      });

      span.setAttribute('webhook.event_id', mapped.eventId);
      span.setAttribute('webhook.event_name', mapped.eventName);
      span.end();

      // ── 200 fast-ack ─────────────────────────────────────────────────────────
      return reply.code(200).send({ request_id: requestId, received: true });
    } catch (err) {
      // Catch-all for unexpected errors — never expose internals (NN-2).
      req.log?.error({ request_id: requestId, provider, err }, '[webhook] unexpected error');
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      span.end();
      return reply.code(500).send({
        request_id: requestId,
        error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
      });
    }
  }

  // ── connector_sync_status touch ─────────────────────────────────────────────

  private async touchSyncStatus(
    brandId: string,
    connectorInstanceId: string,
    _requestId: string,
  ): Promise<void> {
    const client = await this.deps.rawPgPool.connect();
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
}
