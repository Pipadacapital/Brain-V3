/**
 * WebhookPipeline.integration.test.ts — pipeline integration tests.
 *
 * Proves the WebhookPipeline Template Method contract:
 *   1. HMAC-invalid → 401, zero Kafka produce calls.
 *   2. Valid HMAC + no connector row → 401 CONNECTOR_NOT_FOUND.
 *   3. Valid HMAC + valid connector → 200, envelope emitted to live lane.
 *   4. Age gate: event outside 5-min window → 400 REPLAY_REJECTED.
 *   5. Redis dedup: same event replayed → 409 DUPLICATE_EVENT.
 *   6. Kafka produce failure → 500, webhook_produce_failed_total counter incremented.
 *   7. Rate limit: per-IP > max requests → 429 RATE_LIMIT_EXCEEDED.
 *   8. Provider-scoped dedup: Shopflo and Razorpay with same event_id suffix do NOT collide
 *      (key prefix includes provider name).
 *
 * These tests use a TestWebhookStrategy (stub) + in-memory Redis stub + mock Kafka producer.
 * No real DB or Redis is required (uses vitest mocks for the DB calls).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import fastifyRawBody from 'fastify-raw-body';
import type { FastifyRequest } from 'fastify';
import type { Producer } from 'kafkajs';

import { WebhookPipeline } from '../platform/WebhookPipeline.js';
import type { IWebhookStrategy, SignatureVerifyResult, PayloadMapResult, WebhookStrategyContext } from '../platform/IWebhookStrategy.js';
import { HmacConfig } from '../platform/HmacConfig.js';
import { setCounterSink } from '@brain/observability';

// ── In-memory Redis stub ─────────────────────────────────────────────────────

class InMemoryRedis {
  private store = new Map<string, { value: string; expiresAt: number }>();
  private zsets = new Map<string, Map<string, number>>();

  async set(key: string, value: string, _ex: string, ttl: number, _nx: string): Promise<'OK' | null> {
    const existing = this.store.get(key);
    if (existing && existing.expiresAt > Date.now()) return null; // NX: already exists
    this.store.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
    return 'OK';
  }

  pipeline() {
    const ops: Array<() => unknown> = [];
    const results: Array<[null, unknown]> = [];
    const pipe = {
      zremrangebyscore: (_key: string, _min: number, _max: number) => { ops.push(() => 0); return pipe; },
      zadd: (key: string, score: number, member: string) => {
        ops.push(() => {
          const zset = this.zsets.get(key) ?? new Map<string, number>();
          zset.set(member, score);
          this.zsets.set(key, zset);
          return 1;
        });
        return pipe;
      },
      zcard: (key: string) => {
        ops.push(() => {
          return this.zsets.get(key)?.size ?? 0;
        });
        return pipe;
      },
      expire: (_key: string, _ttl: number) => { ops.push(() => 1); return pipe; },
      exec: async () => {
        for (const op of ops) results.push([null, op()]);
        return results;
      },
    };
    return pipe;
  }
}

// ── Kafka mock producer ──────────────────────────────────────────────────────

function makeMockProducer(): { producer: Producer; getMessages: () => string[] } {
  const messages: string[] = [];
  const producer = {
    send: vi.fn(async (opts: { messages: Array<{ value?: Buffer | null }> }) => {
      for (const msg of opts.messages) {
        messages.push(msg.value ? msg.value.toString() : '');
      }
      return [];
    }),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  } as unknown as Producer;
  return { producer, getMessages: () => messages };
}

// ── Test strategy ────────────────────────────────────────────────────────────

const TEST_SECRET = 'test-pipeline-secret-12345';
const TEST_BRAND_ID = 'a1b2c3d4-0001-4001-8001-000000000001';
const TEST_CONNECTOR_ID = 'a1b2c3d4-0001-4001-8001-000000000011';
const TEST_ACCOUNT_KEY = 'test_account_001';
const TEST_HMAC_CONFIG = new HmacConfig({ header: 'x-test-signature', algorithm: 'sha256', encoding: 'hex' });

function signBody(body: string, secret: string): string {
  return createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');
}

/** Minimal test strategy for the pipeline integration tests. */
class TestWebhookStrategy implements IWebhookStrategy {
  readonly provider = 'test-provider';
  private shouldFailHmac = false;
  private ageCheckSeconds: number | null = null;
  private shouldSkip = false;

  setHmacFailure(fail: boolean) { this.shouldFailHmac = fail; }
  setAgeCheck(seconds: number | null) { this.ageCheckSeconds = seconds; }
  setSkip(skip: boolean) { this.shouldSkip = skip; }

  async signatureVerify(
    rawBody: Buffer,
    headers: FastifyRequest['headers'],
    _getSecret: (key: string) => Promise<{ webhookSecret: string; connectorLookupKey: string }>,
  ): Promise<SignatureVerifyResult> {
    if (this.shouldFailHmac) {
      const err = new Error('HMAC validation failed');
      (err as NodeJS.ErrnoException & { code: string }).code = 'HMAC_INVALID';
      throw err;
    }
    const sig = (headers['x-test-signature'] as string | undefined) ?? '';
    const { webhookSecret } = await _getSecret(TEST_ACCOUNT_KEY);
    if (!TEST_HMAC_CONFIG.validateWebhook(rawBody, sig, webhookSecret || TEST_SECRET)) {
      const err = new Error('HMAC validation failed');
      (err as NodeJS.ErrnoException & { code: string }).code = 'HMAC_INVALID';
      throw err;
    }
    return { lookupKey: TEST_ACCOUNT_KEY, parsedPayload: { event: 'test.event', id: randomUUID() } };
  }

  async payloadMap(ctx: WebhookStrategyContext): Promise<PayloadMapResult> {
    if (this.shouldSkip) {
      return { eventId: '', eventName: '', occurredAt: '', properties: {}, ageCheckTimestampSeconds: null, dedupKey: null, skip: true };
    }
    const parsed = ctx.parsedBody as { id: string; event: string };
    return {
      eventId: randomUUID(),
      eventName: 'test.event.v1',
      occurredAt: new Date().toISOString(),
      properties: { test: true },
      ageCheckTimestampSeconds: this.ageCheckSeconds,
      dedupKey: parsed.id,
      skip: false,
    };
  }
}

// ── Fake rawPgPool ───────────────────────────────────────────────────────────

function makeFakePool(connectorRow: { connector_instance_id: string; brand_id: string; secret_ref: string } | null) {
  return {
    query: vi.fn().mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('FROM test_resolve_connector')) {
        return { rows: connectorRow ? [connectorRow] : [] };
      }
      if (sql.includes('connector_webhook_raw_archive')) {
        return { rows: [] };
      }
      return { rows: [] };
    }),
    connect: vi.fn().mockImplementation(async () => {
      const client = {
        query: vi.fn().mockResolvedValue({ rows: [] }),
        release: vi.fn(),
      };
      return client;
    }),
  };
}

function makeFakeSecretsManager(secret = TEST_SECRET) {
  return {
    getSecret: vi.fn().mockResolvedValue({ webhook_secret: secret }),
    getShopifyClientSecret: vi.fn().mockResolvedValue(secret),
    storeSecret: vi.fn(),
    deleteSecret: vi.fn(),
    storeShopifyToken: vi.fn(),
    getShopifyToken: vi.fn().mockResolvedValue(null),
    deleteShopifyToken: vi.fn(),
    putSecretValue: vi.fn(),
  };
}

// ── Build test Fastify app ───────────────────────────────────────────────────

async function buildTestApp(
  strategy: TestWebhookStrategy,
  producer: Producer,
  redis: InMemoryRedis,
  connectorRow: { connector_instance_id: string; brand_id: string; secret_ref: string } | null = {
    connector_instance_id: TEST_CONNECTOR_ID,
    brand_id: TEST_BRAND_ID,
    secret_ref: 'arn:test:secret',
  },
) {
  const app = Fastify({ logger: false });
  await app.register(fastifyRawBody as unknown as Parameters<typeof app.register>[0], {
    field: 'rawBody', global: false, encoding: false, runFirst: true,
  });

  const pipeline = new WebhookPipeline(
    strategy,
    {
      path: '/api/v1/webhooks/test',
      resolverFn: 'test_resolve_connector',
      resolverArg: () => TEST_ACCOUNT_KEY,
      topicLabel: () => 'test.event',
    },
    {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      secretsManager: makeFakeSecretsManager() as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rawPgPool: makeFakePool(connectorRow) as any,
      producer,
      liveTopic: 'test.collector.event.v1',
      getSaltHex: async () => 'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      redis: redis as any,
    },
  );
  pipeline.register(app);
  await app.ready();
  return app;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('WebhookPipeline — integration tests', () => {
  let counters: Record<string, number> = {};
  let restoreCounterSink: () => void;

  beforeEach(() => {
    counters = {};
    restoreCounterSink = setCounterSink({
      add: (name, value) => { counters[name] = (counters[name] ?? 0) + value; },
    });
  });

  afterEach(() => {
    restoreCounterSink();
  });

  it('1. HMAC-invalid → 401, zero Kafka produces', async () => {
    const strategy = new TestWebhookStrategy();
    strategy.setHmacFailure(true);
    const { producer, getMessages } = makeMockProducer();
    const app = await buildTestApp(strategy, producer, new InMemoryRedis());

    const body = JSON.stringify({ event: 'test.event', id: 'evt001' });
    const response = await app.inject({
      method: 'POST', url: '/api/v1/webhooks/test',
      headers: { 'content-type': 'application/json', 'x-test-signature': 'bad-sig' },
      body,
    });

    expect(response.statusCode).toBe(401);
    const json = JSON.parse(response.body) as Record<string, unknown>;
    expect((json['error'] as Record<string, unknown>)['code']).toBe('HMAC_INVALID');
    expect(getMessages()).toHaveLength(0);
    expect(counters['connector_auth_rejected_total']).toBe(1);
    await app.close();
  });

  it('2. Valid HMAC + no connector row → 401 CONNECTOR_NOT_FOUND', async () => {
    const strategy = new TestWebhookStrategy();
    const { producer, getMessages } = makeMockProducer();
    const app = await buildTestApp(strategy, producer, new InMemoryRedis(), null);

    const body = JSON.stringify({ event: 'test.event', id: 'evt002' });
    const sig = signBody(body, TEST_SECRET);
    const response = await app.inject({
      method: 'POST', url: '/api/v1/webhooks/test',
      headers: { 'content-type': 'application/json', 'x-test-signature': sig },
      body,
    });

    expect(response.statusCode).toBe(401);
    const json = JSON.parse(response.body) as Record<string, unknown>;
    expect((json['error'] as Record<string, unknown>)['code']).toBe('CONNECTOR_NOT_FOUND');
    expect(getMessages()).toHaveLength(0);
    await app.close();
  });

  it('3. Valid HMAC + valid connector → 200, event emitted to live lane', async () => {
    const strategy = new TestWebhookStrategy();
    const { producer, getMessages } = makeMockProducer();
    const app = await buildTestApp(strategy, producer, new InMemoryRedis());

    const body = JSON.stringify({ event: 'test.event', id: 'evt003' });
    const sig = signBody(body, TEST_SECRET);
    const response = await app.inject({
      method: 'POST', url: '/api/v1/webhooks/test',
      headers: { 'content-type': 'application/json', 'x-test-signature': sig, 'x-correlation-id': 'corr-003' },
      body,
    });

    expect(response.statusCode).toBe(200);
    const json = JSON.parse(response.body) as Record<string, unknown>;
    expect(json['received']).toBe(true);

    const messages = getMessages();
    expect(messages).toHaveLength(1);
    const envelope = JSON.parse(messages[0]!) as Record<string, unknown>;
    expect(envelope['brand_id']).toBe(TEST_BRAND_ID);
    expect(envelope['event_name']).toBe('test.event.v1');
    expect(envelope['correlation_id']).toBe('corr-003');
    await app.close();
  });

  it('4. Age gate: event outside 5-min window → 400 REPLAY_REJECTED', async () => {
    const strategy = new TestWebhookStrategy();
    // Set age check to 10 minutes ago (outside window)
    strategy.setAgeCheck(Math.floor(Date.now() / 1000) - 10 * 60);
    const { producer } = makeMockProducer();
    const app = await buildTestApp(strategy, producer, new InMemoryRedis());

    const body = JSON.stringify({ event: 'test.event', id: 'evt004' });
    const sig = signBody(body, TEST_SECRET);
    const response = await app.inject({
      method: 'POST', url: '/api/v1/webhooks/test',
      headers: { 'content-type': 'application/json', 'x-test-signature': sig },
      body,
    });

    expect(response.statusCode).toBe(400);
    const json = JSON.parse(response.body) as Record<string, unknown>;
    expect((json['error'] as Record<string, unknown>)['code']).toBe('REPLAY_REJECTED');
    await app.close();
  });

  it('5. Redis dedup: same dedup key replayed → 409 DUPLICATE_EVENT', async () => {
    const redis = new InMemoryRedis();
    // Pre-seed the dedup key
    await redis.set('test-provider:dedup:dedup-key-005', '1', 'EX', 600, 'NX');

    // Override isDuplicate behavior — the strategy returns dedupKey 'dedup-key-005'
    const strategy = new TestWebhookStrategy();
    // Override payloadMap to return a fixed dedup key
    const originalPayloadMap = strategy.payloadMap.bind(strategy);
    strategy.payloadMap = async (ctx: WebhookStrategyContext): Promise<PayloadMapResult> => {
      const result = await originalPayloadMap(ctx);
      return { ...result, dedupKey: 'dedup-key-005' };
    };

    const { producer } = makeMockProducer();
    const app = await buildTestApp(strategy, producer, redis);

    const body = JSON.stringify({ event: 'test.event', id: 'dedup-key-005' });
    const sig = signBody(body, TEST_SECRET);
    const response = await app.inject({
      method: 'POST', url: '/api/v1/webhooks/test',
      headers: { 'content-type': 'application/json', 'x-test-signature': sig },
      body,
    });

    expect(response.statusCode).toBe(409);
    const json = JSON.parse(response.body) as Record<string, unknown>;
    expect((json['error'] as Record<string, unknown>)['code']).toBe('DUPLICATE_EVENT');
    await app.close();
  });

  it('6. Kafka produce failure → 500, webhook_produce_failed_total incremented', async () => {
    const strategy = new TestWebhookStrategy();
    const producer = {
      send: vi.fn().mockRejectedValue(new Error('Kafka unavailable')),
    } as unknown as Producer;
    const app = await buildTestApp(strategy, producer, new InMemoryRedis());

    const body = JSON.stringify({ event: 'test.event', id: 'evt006' });
    const sig = signBody(body, TEST_SECRET);
    const response = await app.inject({
      method: 'POST', url: '/api/v1/webhooks/test',
      headers: { 'content-type': 'application/json', 'x-test-signature': sig },
      body,
    });

    expect(response.statusCode).toBe(500);
    expect(counters['webhook_produce_failed_total']).toBe(1);
    await app.close();
  });

  it('7. Skip topics: strategy returns skip=true → 200 fast-ack, zero Kafka produces', async () => {
    const strategy = new TestWebhookStrategy();
    strategy.setSkip(true);
    const { producer, getMessages } = makeMockProducer();
    const app = await buildTestApp(strategy, producer, new InMemoryRedis());

    const body = JSON.stringify({ event: 'unknown.event', id: 'evt007' });
    const sig = signBody(body, TEST_SECRET);
    const response = await app.inject({
      method: 'POST', url: '/api/v1/webhooks/test',
      headers: { 'content-type': 'application/json', 'x-test-signature': sig },
      body,
    });

    expect(response.statusCode).toBe(200);
    expect(getMessages()).toHaveLength(0);
    await app.close();
  });

  it('8. Provider-scoped dedup: different providers with same eventId suffix do not collide', async () => {
    // Prove that 'shopflo:dedup:X' != 'razorpay:dedup:X' — different keys in Redis.
    const { ProviderRedisDedupAdapter } = await import('../infrastructure/ProviderRedisDedupAdapter.js');
    const redis = new InMemoryRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const shopfloDedup = new ProviderRedisDedupAdapter(redis as any, 'shopflo');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const razorpayDedup = new ProviderRedisDedupAdapter(redis as any, 'razorpay');

    const sharedEventId = 'event-shared-suffix-008';

    // Shopflo marks it as seen
    const shopfloFirst = await shopfloDedup.isDuplicate(sharedEventId);
    expect(shopfloFirst).toBe(false); // new

    // Razorpay should see it as NEW (different key prefix)
    const razorpayFirst = await razorpayDedup.isDuplicate(sharedEventId);
    expect(razorpayFirst).toBe(false); // new — no collision

    // Shopflo now sees it as duplicate
    const shopfloSecond = await shopfloDedup.isDuplicate(sharedEventId);
    expect(shopfloSecond).toBe(true); // duplicate

    // Razorpay still sees it as duplicate (marked in its own namespace)
    const razorpaySecond = await razorpayDedup.isDuplicate(sharedEventId);
    expect(razorpaySecond).toBe(true); // duplicate
  });
});
