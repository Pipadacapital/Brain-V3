/**
 * ShopifyWebhookStrategy.pipeline.integration.test.ts
 *
 * Integration tests on the REAL live path: WebhookPipeline + the REAL ShopifyWebhookStrategy
 * (NOT the dead shopifyWebhookHandler). These prove the Slice-A webhook fixes:
 *
 *   CRIT-2 (HMAC keys off the real secret):
 *     The Shopify connector secret bundle stores ONLY the access token ({ value: <token> } — no
 *     `webhook_secret` key). The strategy must fall back to the injected client_secret resolver and
 *     STILL verify the HMAC. A wrong secret → 401, zero Kafka produces (fail-closed, no spoof).
 *
 *   HIGH (no-event-loss): a >5-min-old order webhook (Shopify retry/delay) is NOT rejected — the
 *     order-webhook transport replay-age gate was removed (idempotency is uuidV5 + Bronze MERGE).
 *
 *   Topic alignment: the registrar's underscore path segment ('orders_create') reverse-maps to the
 *     canonical 'orders/create' so the matcher still fires (registrar↔matcher agree).
 *
 *   Priority: an explicitly-provisioned bundle `webhook_secret` is honoured FIRST (resolver not called).
 *
 * Harness mirrors WebhookPipeline.integration.test.ts (in-memory Redis + mock Kafka + fake pg).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import Fastify from 'fastify';
import fastifyRawBody from 'fastify-raw-body';
import type { FastifyRequest } from 'fastify';
import type { Producer } from 'kafkajs';

import { WebhookPipeline } from '../platform/WebhookPipeline.js';
import { registerAllWebhookRoutes } from '../platform/registerWebhookRoutes.js';
import { ShopifyWebhookStrategy } from '../strategies/ShopifyWebhookStrategy.js';
import { setCounterSink } from '@brain/observability';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const CLIENT_SECRET = 'shopify-app-client-secret-abc123';
const SHOP_DOMAIN = 'boddactive-com.myshopify.com';
const BRAND_ID = 'a1b2c3d4-0001-4001-8001-000000000b0d';
const CONNECTOR_ID = 'a1b2c3d4-0001-4001-8001-0000000000c1';
const SALT_HEX = 'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899';

/** Shopify signs the raw body with base64(HMAC-SHA256(rawBody, client_secret)). */
function shopifyHmac(body: string, secret: string): string {
  return createHmac('sha256', secret).update(Buffer.from(body)).digest('base64');
}

function orderBody(updatedAtIso: string): string {
  return JSON.stringify({
    id: 987654321,
    created_at: updatedAtIso,
    updated_at: updatedAtIso,
    processed_at: updatedAtIso,
    currency: 'INR',
    current_total_price: '1000.00',
    financial_status: 'paid',
  });
}

// ── In-memory Redis stub (rate-limit zset + dedup set) ────────────────────────

class InMemoryRedis {
  private store = new Map<string, { value: string; expiresAt: number }>();
  private zsets = new Map<string, Map<string, number>>();

  async set(key: string, value: string, _ex: string, ttl: number, _nx: string): Promise<'OK' | null> {
    const existing = this.store.get(key);
    if (existing && existing.expiresAt > Date.now()) return null;
    this.store.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
    return 'OK';
  }

  pipeline() {
    const ops: Array<() => unknown> = [];
    const results: Array<[null, unknown]> = [];
    const pipe = {
      zremrangebyscore: () => { ops.push(() => 0); return pipe; },
      zadd: (key: string, score: number, member: string) => {
        ops.push(() => {
          const zset = this.zsets.get(key) ?? new Map<string, number>();
          zset.set(member, score);
          this.zsets.set(key, zset);
          return 1;
        });
        return pipe;
      },
      zcard: (key: string) => { ops.push(() => this.zsets.get(key)?.size ?? 0); return pipe; },
      expire: () => { ops.push(() => 1); return pipe; },
      exec: async () => { for (const op of ops) results.push([null, op()]); return results; },
    };
    return pipe;
  }
}

// ── Mock Kafka producer ──────────────────────────────────────────────────────

function makeMockProducer(): { producer: Producer; getMessages: () => string[] } {
  const messages: string[] = [];
  const producer = {
    send: vi.fn(async (opts: { messages: Array<{ value?: Buffer | null }> }) => {
      for (const msg of opts.messages) messages.push(msg.value ? msg.value.toString() : '');
      return [];
    }),
  } as unknown as Producer;
  return { producer, getMessages: () => messages };
}

// ── Fake rawPgPool: resolver returns the Bodd connector row ───────────────────

function makeFakePool(connectorRow: { connector_instance_id: string; brand_id: string; secret_ref: string } | null) {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('resolve_connector_by_shop_domain')) {
        return { rows: connectorRow ? [connectorRow] : [] };
      }
      return { rows: [] };
    }),
    connect: vi.fn(async () => ({
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    })),
  };
}

/**
 * Secrets manager whose getSecret returns the REAL Shopify shape: { value: <token> } — i.e. NO
 * webhook_secret key. Forces the strategy onto the client_secret resolver (CRIT-2). When
 * `bundleWebhookSecret` is supplied, getSecret returns it to exercise the bundle-wins priority.
 */
function makeFakeSecretsManager(bundleWebhookSecret?: string) {
  const bundle = bundleWebhookSecret ? { webhook_secret: bundleWebhookSecret } : { value: 'shpat_access_token_only' };
  return {
    getSecret: vi.fn().mockResolvedValue(bundle),
    getShopifyClientSecret: vi.fn().mockResolvedValue(CLIENT_SECRET),
    storeSecret: vi.fn(),
    deleteSecret: vi.fn(),
    storeShopifyToken: vi.fn(),
    getShopifyToken: vi.fn().mockResolvedValue(null),
    deleteShopifyToken: vi.fn(),
    putSecretValue: vi.fn(),
  };
}

// ── Build a test app on the REAL Shopify route shape (x-wh-topic injection) ────

async function buildApp(opts: {
  producer: Producer;
  connectorRow?: { connector_instance_id: string; brand_id: string; secret_ref: string } | null;
  bundleWebhookSecret?: string;
  resolveHmacSecret?: (shopDomain: string) => Promise<string>;
}) {
  const app = Fastify({ logger: false });
  await app.register(fastifyRawBody as unknown as Parameters<typeof app.register>[0], {
    field: 'rawBody', global: false, encoding: false, runFirst: true,
  });

  const resolver = opts.resolveHmacSecret ?? (async () => CLIENT_SECRET);

  const pipeline = new WebhookPipeline(
    new ShopifyWebhookStrategy(resolver),
    {
      path: '/api/v1/webhooks/shopify/:topic',
      resolverFn: 'resolve_connector_by_shop_domain',
      resolverArg: (req: FastifyRequest) => (req.headers['x-shopify-shop-domain'] as string | undefined) ?? '',
      topicLabel: (req: FastifyRequest) => (req.params as { topic?: string }).topic ?? 'unknown',
    },
    {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      secretsManager: makeFakeSecretsManager(opts.bundleWebhookSecret) as any,
      rawPgPool: makeFakePool(
        opts.connectorRow === undefined
          ? { connector_instance_id: CONNECTOR_ID, brand_id: BRAND_ID, secret_ref: 'arn:test:shopify' }
          : opts.connectorRow,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ) as any,
      producer: opts.producer,
      liveTopic: 'collector.event.v1',
      getSaltHex: async () => SALT_HEX,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      redis: new InMemoryRedis() as any,
    },
  );

  // Mirror registerWebhookRoutes: inject the URL :topic as x-wh-topic before the pipeline runs.
  app.post('/api/v1/webhooks/shopify/:topic', { config: { rawBody: true } }, async (req, reply) => {
    (req.headers as Record<string, string>)['x-wh-topic'] = (req.params as { topic: string }).topic ?? '';
    return pipeline.handleRequest(req, reply);
  });
  await app.ready();
  return app;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ShopifyWebhookStrategy × WebhookPipeline — live path (Slice A)', () => {
  let counters: Record<string, number> = {};
  let restore: () => void;

  beforeEach(() => {
    counters = {};
    restore = setCounterSink({ add: (name, value) => { counters[name] = (counters[name] ?? 0) + value; } });
  });
  afterEach(() => restore());

  it('CRIT-2: bundle has NO webhook_secret → verifies via client_secret resolver → 200 + order.live.v1 produced', async () => {
    const { producer, getMessages } = makeMockProducer();
    const app = await buildApp({ producer });

    const body = orderBody(new Date().toISOString());
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/shopify/orders_create',
      headers: {
        'content-type': 'application/json',
        'x-shopify-shop-domain': SHOP_DOMAIN,
        'x-shopify-topic': 'orders/create',
        'x-shopify-hmac-sha256': shopifyHmac(body, CLIENT_SECRET),
      },
      body,
    });

    expect(res.statusCode).toBe(200);
    const messages = getMessages();
    expect(messages).toHaveLength(1);
    const envelope = JSON.parse(messages[0]!) as Record<string, unknown>;
    expect(envelope['brand_id']).toBe(BRAND_ID);
    expect(envelope['event_name']).toBe('order.live.v1');
    await app.close();
  });

  it('CRIT-2 fail-closed: wrong secret → 401 HMAC_INVALID, zero produces', async () => {
    const { producer, getMessages } = makeMockProducer();
    const app = await buildApp({ producer });

    const body = orderBody(new Date().toISOString());
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/shopify/orders_create',
      headers: {
        'content-type': 'application/json',
        'x-shopify-shop-domain': SHOP_DOMAIN,
        'x-shopify-topic': 'orders/create',
        'x-shopify-hmac-sha256': shopifyHmac(body, 'the-wrong-secret'),
      },
      body,
    });

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error.code).toBe('HMAC_INVALID');
    expect(getMessages()).toHaveLength(0);
    // NOTE: the pipeline's getSecret callback ALSO increments this counter when the bundle lacks a
    // webhook_secret key (now the norm for Shopify, which verifies via the client_secret resolver), so
    // a rejected Shopify webhook can count >1. The security-critical facts are the 401 + zero produces.
    expect(counters['connector_auth_rejected_total']).toBeGreaterThanOrEqual(1);
    await app.close();
  });

  it('HIGH no-event-loss: a >5-min-old order webhook is NOT replay-rejected → 200 + produced', async () => {
    const { producer, getMessages } = makeMockProducer();
    const app = await buildApp({ producer });

    // updated_at one hour ago — under the OLD gate this would be REPLAY_REJECTED (window 300s).
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const body = orderBody(oneHourAgo);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/shopify/orders_updated',
      headers: {
        'content-type': 'application/json',
        'x-shopify-shop-domain': SHOP_DOMAIN,
        'x-shopify-topic': 'orders/updated',
        'x-shopify-hmac-sha256': shopifyHmac(body, CLIENT_SECRET),
      },
      body,
    });

    expect(res.statusCode).toBe(200);
    expect(getMessages()).toHaveLength(1);
    await app.close();
  });

  it('Topic alignment: underscore path segment (no X-Shopify-Topic) reverse-maps → order event fires', async () => {
    const { producer, getMessages } = makeMockProducer();
    const app = await buildApp({ producer });

    const body = orderBody(new Date().toISOString());
    // Registrar address path is 'orders_create'; simulate Shopify omitting X-Shopify-Topic — the
    // strategy must reverse-map the underscore form to the canonical 'orders/create' and still fire.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/shopify/orders_create',
      headers: {
        'content-type': 'application/json',
        'x-shopify-shop-domain': SHOP_DOMAIN,
        'x-shopify-hmac-sha256': shopifyHmac(body, CLIENT_SECRET),
      },
      body,
    });

    expect(res.statusCode).toBe(200);
    expect(getMessages()).toHaveLength(1);
    expect((JSON.parse(getMessages()[0]!) as Record<string, unknown>)['event_name']).toBe('order.live.v1');
    await app.close();
  });

  it('Priority: an explicit bundle webhook_secret is honoured FIRST (resolver not consulted)', async () => {
    const { producer, getMessages } = makeMockProducer();
    const BUNDLE_SECRET = 'explicit-bundle-webhook-secret';
    const resolver = vi.fn(async () => CLIENT_SECRET);
    const app = await buildApp({ producer, bundleWebhookSecret: BUNDLE_SECRET, resolveHmacSecret: resolver });

    const body = orderBody(new Date().toISOString());
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/shopify/orders_create',
      headers: {
        'content-type': 'application/json',
        'x-shopify-shop-domain': SHOP_DOMAIN,
        'x-shopify-topic': 'orders/create',
        'x-shopify-hmac-sha256': shopifyHmac(body, BUNDLE_SECRET), // signed with the BUNDLE secret
      },
      body,
    });

    expect(res.statusCode).toBe(200);
    expect(getMessages()).toHaveLength(1);
    expect(resolver).not.toHaveBeenCalled(); // bundle secret short-circuited the resolver
    await app.close();
  });

  // ── BYO-required (shopify-byo-app-required Task 6): the DEFAULT resolver built inside
  // registerAllWebhookRoutes must REFUSE the env app secret when the catalog says byoAppRequired.
  // This goes through registerAllWebhookRoutes (not an injected resolver) on purpose.
  it('byoAppRequired: brand has no stored app secret → env-signed HMAC fails 401 (env NOT consulted)', async () => {
    const { producer, getMessages } = makeMockProducer();
    const app = Fastify({ logger: false });
    await app.register(fastifyRawBody as unknown as Parameters<typeof app.register>[0], {
      field: 'rawBody', global: false, encoding: false, runFirst: true,
    });

    const secretsManager = {
      getSecret: vi.fn().mockResolvedValue(null), // no per-brand shopify_app bundle
      getShopifyClientSecret: vi.fn().mockResolvedValue('env-secret'), // env fallback exists
      storeSecret: vi.fn(),
      deleteSecret: vi.fn(),
      storeShopifyToken: vi.fn(),
      getShopifyToken: vi.fn().mockResolvedValue(null),
      deleteShopifyToken: vi.fn(),
      putSecretValue: vi.fn(),
    };

    registerAllWebhookRoutes(app, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      secretsManager: secretsManager as any,
      rawPgPool: makeFakePool(
        { connector_instance_id: CONNECTOR_ID, brand_id: BRAND_ID, secret_ref: 'arn:test:shopify' },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ) as any,
      producer,
      liveTopic: 'collector.event.v1',
      getSaltHex: async () => SALT_HEX,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      redis: new InMemoryRedis() as any,
      // NO shopifyHmacSecretResolver override — the default (catalog-driven) resolver is under test.
    });
    await app.ready();

    // A webhook signed with the ENV secret — the receiver must REFUSE it for byoAppRequired.
    const body = orderBody(new Date().toISOString());
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/shopify/orders_create',
      headers: {
        'content-type': 'application/json',
        'x-shopify-shop-domain': SHOP_DOMAIN,
        'x-shopify-topic': 'orders/create',
        'x-shopify-hmac-sha256': shopifyHmac(body, 'env-secret'),
      },
      body,
    });

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error.code).toBe('HMAC_INVALID');
    // The env app secret was NEVER fetched — BYO-required skips the fallback entirely.
    expect(secretsManager.getShopifyClientSecret).not.toHaveBeenCalled();
    expect(getMessages()).toHaveLength(0);
    await app.close();
  });
});
