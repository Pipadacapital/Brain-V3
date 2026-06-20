/**
 * shopfloWebhookHandler.integration.test.ts — Track B
 *
 * Proves the §10 acceptance contract for the Shopflo webhook:
 *
 *   1. HMAC-invalid webhook → 401, zero writes (non-inert: forged-signature proof —
 *      removing the HMAC check would return 200; the production path is exercised).
 *   2. Anti-spoof: a FORGED brand_id/merchant_id in the body cannot target another
 *      brand. Brand is resolved from the DB row (resolve_shopflo_connector_by_merchant),
 *      NEVER from the body. A body carrying Brand B's merchant_id but signed with
 *      Brand A's secret fails HMAC (no matching secret) → 401, zero writes for B.
 *   3. Valid HMAC + checkout_abandoned → event emitted to the live lane for the brand
 *      resolved from the connector ROW.
 *   4. Replay — age check: occurred_at older than the 5-min window → 400.
 *   5. Replay — Redis dedup: same (checkout_id, occurred_at) within window → 409.
 *   6. Cross-brand isolation under brain_app: without the correct GUC, FORCE RLS
 *      blocks all connector rows (count === 0) — non-inert (assertBrainApp confirms
 *      we are NOT the superuser).
 *   7. resolve_shopflo_connector_by_merchant SECURITY DEFINER fn callable by brain_app
 *      → returns the correct row.
 *
 * ISOLATION (assertBrainApp):
 *   Every isolation assertion runs under brain_app (BRAIN_APP_DATABASE_URL); superuser
 *   'brain' BYPASSES RLS, so a non-brain_app isolation check would be INERT.
 *
 * RUN:
 *   cd apps/core && \
 *   BRAIN_APP_DATABASE_URL=postgres://brain_app:brain_app@localhost:5432/brain \
 *   DATABASE_URL=postgres://brain:brain@localhost:5432/brain \
 *   REDIS_URL=redis://localhost:6379 \
 *   pnpm vitest run src/modules/connector/sources/checkout/shopflo/tests/shopfloWebhookHandler.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import fastifyRawBody from 'fastify-raw-body';
import pg from 'pg';
import type { Producer } from 'kafkajs';
import { Redis } from 'ioredis';

import { registerShopfloWebhookRoutes } from '../interfaces/webhooks/shopfloWebhookHandler.js';
import { DEFAULT_SHOPFLO_SIG_HEADER } from '../domain/value-objects/ShopfloHmac.js';
import type { ISecretsManager } from '@brain/connector-secrets';

// ── Config ────────────────────────────────────────────────────────────────────

const SUPERUSER_URL =
  process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const APP_URL =
  process.env['BRAIN_APP_DATABASE_URL'] ??
  'postgres://brain_app:brain_app@localhost:5432/brain';
const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

/** Shopflo-track unique brand UUIDs (valid UUID v4 format). */
const SF_BRAND_A = 'b5f00001-0001-4001-8001-000000000001';
const SF_BRAND_B = 'b5f00002-0002-4002-8002-000000000002';
const SF_CI_A = 'b5f0c001-0001-4001-8001-000000000011';
const SF_CI_B = 'b5f0c002-0002-4002-8002-000000000022';

const SF_MERCHANT_A = 'mrc_sftest001';
const SF_MERCHANT_B = 'mrc_sftest002';

const SECRET_REF_A = 'arn:aws:secretsmanager:us-east-1:000000000000:secret:brain/connector/shopflo/a';
const SECRET_REF_B = 'arn:aws:secretsmanager:us-east-1:000000000000:secret:brain/connector/shopflo/b';

const WEBHOOK_SECRET_A = 'sf-test-webhook-secret-brand-a';
const WEBHOOK_SECRET_B = 'sf-test-webhook-secret-brand-b';
const TEST_SALT_HEX = 'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899';

// ── DB pools ──────────────────────────────────────────────────────────────────

let superPool: pg.Pool;
let appPool: pg.Pool;
let redis: Redis;

async function assertBrainApp(pool: pg.Pool): Promise<void> {
  const r = await pool.query<{ current_user: string; is_superuser: boolean }>(
    `SELECT current_user,
            (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser`,
  );
  expect(r.rows[0]!.current_user).toBe('brain_app');
  expect(r.rows[0]!.is_superuser).toBe(false);
}

// ── Kafka mock producer ───────────────────────────────────────────────────────

interface CapturedMessage {
  topic: string;
  key: string | null | undefined;
  value: string;
}

function makeMockProducer(): { producer: Producer; getMessages: () => CapturedMessage[] } {
  const messages: CapturedMessage[] = [];
  const producer = {
    send: vi.fn(
      async (opts: {
        topic: string;
        messages: Array<{ key?: Buffer | string | null; value?: Buffer | null }>;
      }) => {
        for (const msg of opts.messages) {
          messages.push({
            topic: opts.topic,
            key: msg.key ? msg.key.toString() : null,
            value: msg.value ? msg.value.toString() : '',
          });
        }
        return [];
      },
    ),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  } as unknown as Producer;
  return { producer, getMessages: () => messages };
}

// ── ISecretsManager stub — maps secret_ref → bundle (per-brand secret) ─────────

function makeSecretsManager(): ISecretsManager {
  const store = new Map<string, Record<string, string>>([
    [SECRET_REF_A, { api_token: 'tok_a', merchant_id: SF_MERCHANT_A, webhook_secret: WEBHOOK_SECRET_A }],
    [SECRET_REF_B, { api_token: 'tok_b', merchant_id: SF_MERCHANT_B, webhook_secret: WEBHOOK_SECRET_B }],
  ]);
  return {
    getShopifyClientSecret: vi.fn().mockResolvedValue(''),
    storeShopifyToken: vi.fn(),
    getShopifyToken: vi.fn().mockResolvedValue(null),
    deleteShopifyToken: vi.fn(),
    storeSecret: vi.fn(),
    getSecret: vi.fn(async (arn: string) => store.get(arn) ?? null),
    deleteSecret: vi.fn(),
  } as unknown as ISecretsManager;
}

// ── Build Fastify test app ────────────────────────────────────────────────────

async function buildTestApp(rawPgPool: pg.Pool, producer: Producer, testRedis: Redis) {
  const app = Fastify({ logger: false });
  await app.register(fastifyRawBody as unknown as Parameters<typeof app.register>[0], {
    field: 'rawBody',
    global: false,
    encoding: false,
    runFirst: true,
  });
  registerShopfloWebhookRoutes(app, {
    secretsManager: makeSecretsManager(),
    rawPgPool,
    producer,
    liveTopic: 'test.collector.event.v1',
    getSaltHex: async (_brandId: string) => TEST_SALT_HEX,
    redis: testRedis,
  });
  await app.ready();
  return app;
}

// ── HMAC signing (HMAC-SHA256 hex — the reversible Razorpay-scheme default) ────

function signBody(body: string, secret: string): string {
  return createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');
}

// ── checkout_abandoned fixture ────────────────────────────────────────────────

function makeCheckoutAbandonedBody(opts: {
  merchantId: string;
  checkoutId?: string;
  occurredAt?: string;
  email?: string;
  phone?: string;
}): string {
  return JSON.stringify({
    merchant_id: opts.merchantId,
    event: 'checkout_abandoned',
    checkout_id: opts.checkoutId ?? `chk_${randomUUID().replace(/-/g, '')}`,
    cart_token: 'cart_sf001',
    occurred_at: opts.occurredAt ?? new Date().toISOString(),
    customer: {
      email: opts.email ?? 'shopper@example.com',
      phone: opts.phone ?? '+919812345678',
      marketing_consent: true,
    },
    line_items: [{ id: 'li_1', title: 'Widget', quantity: 2, price: '650.00' }],
    subtotal_price: '1300.00',
    total_discount: '100.00',
    total_shipping: '0.00',
    total_tax: '0.00',
    total_price: '1200.00',
    currency_code: 'INR',
  });
}

// ── Seed / cleanup ────────────────────────────────────────────────────────────

async function seedBrand(brandId: string): Promise<void> {
  const orgRes = await superPool.query<{ id: string }>('SELECT id FROM organization LIMIT 1');
  const orgId = orgRes.rows[0]?.id;
  if (!orgId) throw new Error('[SF fixture] No organization row found');
  await superPool.query(
    `INSERT INTO brand (id, organization_id, display_name, currency_code, region_code)
     VALUES ($1, $2, $3, 'INR', 'IN')
     ON CONFLICT (id) DO NOTHING`,
    [brandId, orgId, `SF Test Brand ${brandId.slice(0, 8)}`],
  );
}

async function seedShopfloConnector(
  connectorInstanceId: string,
  brandId: string,
  merchantId: string,
  secretRef: string,
): Promise<void> {
  await superPool.query(
    `INSERT INTO connector_instance
       (id, brand_id, provider, status, shop_domain, secret_ref,
        shopflo_merchant_id, health_state, safety_rating,
        connected_at, created_at, updated_at)
     VALUES ($1, $2, 'shopflo', 'connected', '',
             $3, $4, 'Healthy', 'safe', NOW(), NOW(), NOW())
     ON CONFLICT (id) DO NOTHING`,
    [connectorInstanceId, brandId, secretRef, merchantId],
  );
  await superPool.query(
    `INSERT INTO connector_sync_status
       (id, brand_id, connector_instance_id, state, updated_at)
     VALUES ($1, $2, $3, 'connected', NOW())
     ON CONFLICT (brand_id, connector_instance_id) DO NOTHING`,
    [randomUUID(), brandId, connectorInstanceId],
  );
}

async function cleanupSF(): Promise<void> {
  const brandIds = [SF_BRAND_A, SF_BRAND_B];
  const ph = brandIds.map((_, i) => `$${i + 1}`).join(', ');
  await superPool.query(`DELETE FROM connector_sync_status WHERE brand_id IN (${ph})`, brandIds).catch(() => undefined);
  await superPool.query(`DELETE FROM connector_cursor WHERE brand_id IN (${ph})`, brandIds).catch(() => undefined);
  await superPool.query(`DELETE FROM connector_instance WHERE brand_id IN (${ph})`, brandIds).catch(() => undefined);
  await superPool.query(`DELETE FROM brand WHERE id IN (${ph})`, brandIds).catch(() => undefined);
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  superPool = new pg.Pool({ connectionString: SUPERUSER_URL, max: 3 });
  appPool = new pg.Pool({ connectionString: APP_URL, max: 3 });
  redis = new Redis(REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 1 });

  await superPool.query('SELECT 1');
  await appPool.query('SELECT 1');

  await cleanupSF();
  await seedBrand(SF_BRAND_A);
  await seedBrand(SF_BRAND_B);
  await seedShopfloConnector(SF_CI_A, SF_BRAND_A, SF_MERCHANT_A, SECRET_REF_A);
  await seedShopfloConnector(SF_CI_B, SF_BRAND_B, SF_MERCHANT_B, SECRET_REF_B);
});

afterAll(async () => {
  await cleanupSF();
  await superPool.end().catch(() => undefined);
  await appPool.end().catch(() => undefined);
  await redis.quit().catch(() => undefined);
});

// ─────────────────────────────────────────────────────────────────────────────

describe('Shopflo webhook receiver — Track B integration', () => {
  it('HMAC-invalid webhook → 401, zero messages emitted (non-inert)', async () => {
    const { producer, getMessages } = makeMockProducer();
    const app = await buildTestApp(superPool, producer, redis);

    const body = makeCheckoutAbandonedBody({ merchantId: SF_MERCHANT_A });
    const badSig = signBody(body, 'wrong-secret-absolutely-not-valid');

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/shopflo',
      headers: { 'content-type': 'application/json', [DEFAULT_SHOPFLO_SIG_HEADER]: badSig },
      body,
    });

    expect(response.statusCode).toBe(401);
    const json = JSON.parse(response.body) as Record<string, unknown>;
    expect((json['error'] as Record<string, unknown>)['code']).toBe('HMAC_INVALID');
    expect(getMessages()).toHaveLength(0);

    await app.close();
  });

  it('forged-brand body (Brand B merchant_id) signed with Brand A secret → 401, no write for B (anti-spoof)', async () => {
    const { producer, getMessages } = makeMockProducer();
    const app = await buildTestApp(superPool, producer, redis);

    // Body claims Brand B's merchant_id but is signed with Brand A's secret.
    // Resolution picks Brand B's connector (→ Brand B's webhook_secret), against which
    // the Brand-A signature fails → 401. A forged body cannot write to another brand.
    const body = makeCheckoutAbandonedBody({ merchantId: SF_MERCHANT_B });
    const sigWithASecret = signBody(body, WEBHOOK_SECRET_A);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/shopflo',
      headers: { 'content-type': 'application/json', [DEFAULT_SHOPFLO_SIG_HEADER]: sigWithASecret },
      body,
    });

    expect(response.statusCode).toBe(401);
    expect(getMessages()).toHaveLength(0);

    await app.close();
  });

  it('valid HMAC + checkout_abandoned → event emitted with brand_id from connector ROW', async () => {
    const { producer, getMessages } = makeMockProducer();
    const app = await buildTestApp(superPool, producer, redis);

    const body = makeCheckoutAbandonedBody({ merchantId: SF_MERCHANT_A });
    const sig = signBody(body, WEBHOOK_SECRET_A);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/shopflo',
      headers: { 'content-type': 'application/json', [DEFAULT_SHOPFLO_SIG_HEADER]: sig },
      body,
    });

    expect(response.statusCode).toBe(200);
    const msgs = getMessages();
    expect(msgs).toHaveLength(1);
    // Partition key = brand_id resolved from the ROW (MT-1).
    expect(msgs[0]!.key).toBe(SF_BRAND_A);
    const envelope = JSON.parse(msgs[0]!.value) as Record<string, unknown>;
    expect(envelope['brand_id']).toBe(SF_BRAND_A);
    expect(envelope['event_name']).toBe('shopflo.checkout_abandoned.v1');
    // Raw PII must NOT be present in the emitted envelope (I-S02 — hashed at boundary).
    const props = envelope['properties'] as Record<string, unknown>;
    expect(props['customer_email_hash']).toBeTruthy();
    expect(JSON.stringify(envelope)).not.toContain('shopper@example.com');
    expect(JSON.stringify(envelope)).not.toContain('+919812345678');
    // Money is BIGINT-as-string minor units.
    expect(props['total_price_minor']).toBe('120000');
    expect(props['data_source']).toBe('real');

    await app.close();
  });

  it('occurred_at older than the 5-min replay window → 400 REPLAY_REJECTED', async () => {
    const { producer } = makeMockProducer();
    const app = await buildTestApp(superPool, producer, redis);

    const stale = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    const body = makeCheckoutAbandonedBody({ merchantId: SF_MERCHANT_A, occurredAt: stale });
    const sig = signBody(body, WEBHOOK_SECRET_A);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/shopflo',
      headers: { 'content-type': 'application/json', [DEFAULT_SHOPFLO_SIG_HEADER]: sig },
      body,
    });

    expect(response.statusCode).toBe(400);
    expect((JSON.parse(response.body).error as Record<string, unknown>)['code']).toBe('REPLAY_REJECTED');

    await app.close();
  });

  it('same (checkout_id, occurred_at) replayed within window → 409 DUPLICATE_EVENT', async () => {
    const { producer } = makeMockProducer();
    const app = await buildTestApp(superPool, producer, redis);

    const checkoutId = `chk_dedup_${randomUUID().replace(/-/g, '')}`;
    const occurredAt = new Date().toISOString();
    const body = makeCheckoutAbandonedBody({ merchantId: SF_MERCHANT_A, checkoutId, occurredAt });
    const sig = signBody(body, WEBHOOK_SECRET_A);

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/shopflo',
      headers: { 'content-type': 'application/json', [DEFAULT_SHOPFLO_SIG_HEADER]: sig },
      body,
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/shopflo',
      headers: { 'content-type': 'application/json', [DEFAULT_SHOPFLO_SIG_HEADER]: sig },
      body,
    });
    expect(second.statusCode).toBe(409);
    expect((JSON.parse(second.body).error as Record<string, unknown>)['code']).toBe('DUPLICATE_EVENT');

    await app.close();
  });

  it('cross-brand isolation: brain_app without GUC sees 0 connector_instance rows (non-inert FORCE RLS)', async () => {
    await assertBrainApp(appPool);

    const noGuc = await appPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM connector_instance`,
    );
    expect(parseInt(noGuc.rows[0]!.count, 10)).toBe(0);

    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_brand_id', $1, true)`, [SF_BRAND_A]);
      const result = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM connector_instance WHERE provider = 'shopflo'`,
      );
      await client.query('COMMIT');
      // Brand A GUC → only Brand A's shopflo connector visible (exactly 1).
      expect(parseInt(result.rows[0]!.count, 10)).toBe(1);
    } finally {
      client.release();
    }
  });

  it('resolve_shopflo_connector_by_merchant SECURITY DEFINER fn callable by brain_app → correct row', async () => {
    await assertBrainApp(appPool);

    const result = await appPool.query<{
      connector_instance_id: string;
      brand_id: string;
      secret_ref: string;
    }>(
      `SELECT connector_instance_id, brand_id, secret_ref
       FROM resolve_shopflo_connector_by_merchant($1)`,
      [SF_MERCHANT_A],
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.connector_instance_id).toBe(SF_CI_A);
    expect(result.rows[0]!.brand_id).toBe(SF_BRAND_A);
    expect(result.rows[0]!.secret_ref).toBe(SECRET_REF_A);
  });
});
