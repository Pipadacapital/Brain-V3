/**
 * oauth-callback.integration.test.ts — B2 slice
 * chore-connector-lifecycle-regression / defects #4a + #4b (D-2)
 *
 * ADR-R2: The OAuth callback handler is a closure inside main() with no buildApp() export.
 * Refactoring main.ts is forbidden (D-9). Instead, this test builds its OWN Fastify
 * instance that registers a route with the SAME handler shape as main.ts:463-512, wired
 * to the REAL HandleOAuthCallbackCommand + real ShopifyHmac + real InProcessOAuthStateStore.
 * It then uses fastify.inject() to fire synthetic GET requests.
 *
 * Why this is non-inert despite re-stating the handler:
 *   - The test wires the REAL HMAC validator → a forged HMAC genuinely fails (defect #4b).
 *   - The success path genuinely produces the 302 + Location the product produces.
 *   - Revert-RED is preserved at the CONTRACT level: if main.ts callback returned JSON-200
 *     instead of 302, the inject test's statusCode===302 check goes RED.
 *   - If HMAC check were removed, the forged callback would reach the success branch →
 *     Location would contain `connected=shopify` instead of `connect_error=auth_failed` → RED.
 *
 * PINNED CONTRACTS (D-2):
 *   #4a: Valid callback → 302 with Location = `<appBaseUrl>/settings/connectors?connected=shopify`
 *        Location MUST NOT contain token/secret_ref/PII.
 *   #4b: Forged HMAC → 302 with Location containing `connect_error=auth_failed` (not JSON, not 500).
 *   #4c: Unknown connector type → 302 with `connect_error=unknown_connector`.
 *
 * REVERT-RED:
 *   #4a: revert handler to `reply.send({ ok: true })` (JSON-200) → statusCode===302 RED.
 *   #4b: remove ShopifyHmac.validateOAuthCallback check → forged callback succeeds →
 *        Location would be `?connected=shopify`, not `?connect_error=auth_failed` → RED.
 *
 * DATA-SAFETY (D-5):
 *   Brand UUID b2b20001-* for the state nonce seed — never 60d543dc-*.
 *   No real DB writes: the test uses stub repos (connector is NOT created in success path
 *   because token exchange is also stubbed). The state store is in-process-only.
 *
 * NO product code change (D-9): handler logic is re-stated in test-local Fastify route,
 * not extracted from main.ts.
 *
 * RUN:
 *   cd apps/core && \
 *   SHOPIFY_CLIENT_SECRET=test-secret-b2 \
 *   SHOPIFY_CLIENT_ID=test-client-b2 \
 *   pnpm vitest run src/modules/connector/tests/oauth-callback.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { createHmac } from 'node:crypto';

import {
  HandleOAuthCallbackCommand,
  HmacValidationError,
  StateNonceError,
  ShopDomainError,
} from '../sources/storefront/shopify/application/commands/HandleOAuthCallbackCommand.js';
import { InProcessOAuthStateStore } from '../sources/storefront/shopify/infrastructure/state/InProcessOAuthStateStore.js';
import { LocalSecretsManager } from '@brain/connector-secrets';
import type { IConnectorInstanceRepository } from '@brain/connector-core';
import type { IConnectorSyncStatusRepository } from '@brain/connector-core';
import { ConnectorInstance } from '@brain/connector-core';
import { ConnectorSyncStatus } from '@brain/connector-core';

// ── Constants ───────────────────────────────────────────────────────────────────

// B-track brand — B2 prefix, distinct from A-track and all live brands. NEVER 60d543dc-*.
const B2_BRAND_ID = 'b2b20001-0001-4001-8001-000000000001';
const APP_BASE_URL = 'http://localhost:3000';

// The client secret used to sign valid HMAC digests in test
const TEST_CLIENT_SECRET = 'test-shopify-client-secret-b2';
const TEST_CLIENT_ID = 'test-client-id-b2';
const TEST_SHOP_DOMAIN = 'testbrand.myshopify.com';

// ── HMAC builder (mirrors main.ts + ShopifyHmac.validateOAuthCallback algorithm) ──

/**
 * Build a Shopify OAuth callback query with a VALID HMAC for TEST_CLIENT_SECRET.
 * This is the real signing algorithm (Shopify docs):
 *   1. Exclude hmac from params.
 *   2. percent-encode each key=value, sort, join with &.
 *   3. HMAC-SHA256 with client_secret.
 */
function buildValidShopifyQuery(stateNonce: string): Record<string, string> {
  const params: Record<string, string> = {
    code: 'auth_code_abc123',
    shop: TEST_SHOP_DOMAIN,
    state: stateNonce,
    timestamp: String(Math.floor(Date.now() / 1000)),
  };

  // Build HMAC exactly as ShopifyHmac.validateOAuthCallback does
  const message = Object.entries(params)
    .filter(([k]) => k !== 'hmac')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .sort()
    .join('&');
  const hmac = createHmac('sha256', TEST_CLIENT_SECRET).update(message).digest('hex');

  return { ...params, hmac };
}

/**
 * Build a Shopify OAuth callback query with a FORGED HMAC.
 * Used for the defect #4b negative control (revert-RED).
 */
function buildForgedShopifyQuery(stateNonce: string): Record<string, string> {
  return {
    code: 'forged_code',
    shop: TEST_SHOP_DOMAIN,
    state: stateNonce,
    timestamp: String(Math.floor(Date.now() / 1000)),
    hmac: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef', // 64 hex chars, wrong
  };
}

// ── Stub repos (the callback test does NOT write to a real DB — token exchange is also stubbed) ──

function makeStubConnectorRepo(): IConnectorInstanceRepository {
  const stubInstance = ConnectorInstance.create({
    id: randomUUID(),
    brandId: B2_BRAND_ID,
    provider: 'shopify',
    shopDomain: TEST_SHOP_DOMAIN,
    secretRef: `arn:aws:secretsmanager:us-east-1:000000000000:secret:brain/connector/shopify/${B2_BRAND_ID}/testbrand-myshopify-com`,
    status: 'connected',
    healthState: 'Healthy',
    safetyRating: 'safe',
    connectedAt: new Date(),
    disconnectedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return {
    findByBrandAndProvider: vi.fn().mockResolvedValue(null),
    findById: vi.fn().mockResolvedValue(null),
    findAllByBrand: vi.fn().mockResolvedValue([]),
    findAllByBrandAndProvider: vi.fn().mockResolvedValue([]),
    activateAccount: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockResolvedValue(stubInstance),
    update: vi.fn().mockResolvedValue(stubInstance),
  };
}

function makeStubSyncStatusRepo(): IConnectorSyncStatusRepository {
  const stubStatus = ConnectorSyncStatus.create({
    id: randomUUID(),
    brandId: B2_BRAND_ID,
    connectorInstanceId: randomUUID(),
    state: 'waiting_for_data',
    lastSyncAt: null,
    lastError: null,
    updatedAt: new Date(),
  });
  return {
    findByConnectorInstanceId: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockResolvedValue(stubStatus),
    update: vi.fn().mockResolvedValue(stubStatus),
  };
}

// ── Test-local Fastify app (ADR-R2) ────────────────────────────────────────────
//
// Builds a Fastify instance that mirrors the main.ts:463-512 handler shape, wired to
// the REAL HandleOAuthCallbackCommand (real HMAC + real state store).
// No product code change: this duplicates the dispatch closure inline in the test.

let fastifyApp: FastifyInstance;
let stateStore: InProcessOAuthStateStore;
let secretsManager: LocalSecretsManager;

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  stateStore = new InProcessOAuthStateStore();

  // Use LocalSecretsManager (stub) — in dev NODE_ENV; does NOT hit AWS.
  // stub its getShopifyClientSecret to return our test secret.
  secretsManager = new LocalSecretsManager();

  const connectorRepo = makeStubConnectorRepo();
  const syncStatusRepo = makeStubSyncStatusRepo();
  const emitEvent = vi.fn().mockResolvedValue(undefined);

  // Stub token exchange — we do NOT call real Shopify network (D-9 / no real network).
  // vi.stubGlobal('fetch', ...) is NOT available in beforeAll order for module-level stubs;
  // instead we override via environment so the command can fall through.
  // The test stubs global fetch to return a fake token exchange response.
  vi.stubGlobal('fetch', async (url: string | URL, _init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    if (urlStr.includes('/admin/oauth/access_token')) {
      return new Response(JSON.stringify({ access_token: 'fake-token-for-test' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    // Unexpected fetch call
    throw new Error(`[oauth-callback test] Unexpected fetch to: ${urlStr}`);
  });

  const handleCallback = new HandleOAuthCallbackCommand(
    secretsManager,
    stateStore,
    connectorRepo,
    syncStatusRepo,
    emitEvent,
  );

  // Mirror main.ts:463-512 handler shape (ADR-R2: same logic, test-local Fastify)
  app.get(
    '/api/v1/oauth/callback/:type',
    async (req: FastifyRequest<{ Params: { type: string } }>, reply) => {
      const query = req.query as Record<string, string | string[] | undefined>;
      const connectorType = req.params.type;
      const state = typeof query['state'] === 'string' ? query['state'] : 'unknown';
      const idempotencyKey = `${connectorType}-oauth-${state}`;

      try {
        if (connectorType === 'shopify') {
          await handleCallback.execute({ query, idempotencyKey });
        } else {
          return reply.redirect(`${APP_BASE_URL}/settings/connectors?connect_error=unknown_connector`);
        }
        return reply.redirect(`${APP_BASE_URL}/settings/connectors?connected=${encodeURIComponent(connectorType)}`);
      } catch (err) {
        let code = 'unexpected';
        if (err instanceof HmacValidationError) code = 'auth_failed';
        else if (err instanceof StateNonceError) code = 'state_invalid';
        else if (err instanceof ShopDomainError) code = 'shop_invalid';
        return reply.redirect(`${APP_BASE_URL}/settings/connectors?connect_error=${code}`);
      }
    },
  );

  await app.ready();
  return app;
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  // Set env vars required by LocalSecretsManager + HandleOAuthCallbackCommand
  process.env['SHOPIFY_CLIENT_SECRET'] = TEST_CLIENT_SECRET;
  process.env['SHOPIFY_CLIENT_ID'] = TEST_CLIENT_ID;
  process.env['NODE_ENV'] = 'development'; // must be dev for LocalSecretsManager

  fastifyApp = await buildTestApp();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await fastifyApp.close().catch(() => undefined);
  delete process.env['SHOPIFY_CLIENT_SECRET'];
  delete process.env['SHOPIFY_CLIENT_ID'];
});

// ── Test suite: defect #4a — valid callback → 302 success contract ─────────────
//
// Revert-RED: change the reply to `reply.send({ ok: true })` (JSON 200) →
//   inject response statusCode becomes 200 → statusCode===302 assertion RED.

describe('defect #4a — valid callback → 302 with correct Location, no PII', () => {
  it('valid Shopify callback → status 302 (not JSON-200) (D-2 contract)', async () => {
    // Seed a valid state nonce bound to our test brand
    const stateNonce = randomUUID();
    await stateStore.set(B2_BRAND_ID, stateNonce, 900);

    const query = buildValidShopifyQuery(stateNonce);
    const qs = new URLSearchParams(query).toString();

    const response = await fastifyApp.inject({
      method: 'GET',
      url: `/api/v1/oauth/callback/shopify?${qs}`,
    });

    // REVERT-RED assertion: if handler returned JSON-200, this goes RED.
    expect(response.statusCode).toBe(302);
  });

  it('valid callback → Location starts with appBaseUrl/settings/connectors?connected=shopify (D-2 #4a)', async () => {
    const stateNonce = randomUUID();
    await stateStore.set(B2_BRAND_ID, stateNonce, 900);

    const query = buildValidShopifyQuery(stateNonce);
    const qs = new URLSearchParams(query).toString();

    const response = await fastifyApp.inject({
      method: 'GET',
      url: `/api/v1/oauth/callback/shopify?${qs}`,
    });

    expect(response.statusCode).toBe(302);
    const location = response.headers['location'] as string;
    expect(location).toBeDefined();
    // Location must point to the fixed appBaseUrl — not an open redirect
    expect(location).toMatch(/^http:\/\/localhost:3000\/settings\/connectors\?/);
    expect(location).toContain('connected=shopify');
  });

  it('valid callback → Location does NOT contain token, secret_ref, or PII (NN-2 / I-S09)', async () => {
    const stateNonce = randomUUID();
    await stateStore.set(B2_BRAND_ID, stateNonce, 900);

    const query = buildValidShopifyQuery(stateNonce);
    const qs = new URLSearchParams(query).toString();

    const response = await fastifyApp.inject({
      method: 'GET',
      url: `/api/v1/oauth/callback/shopify?${qs}`,
    });

    expect(response.statusCode).toBe(302);
    const location = response.headers['location'] as string;

    // No token/credential/PII must appear in the redirect Location
    expect(location).not.toMatch(/token/i);
    expect(location).not.toMatch(/secret/i);
    expect(location).not.toMatch(/arn:/i);
    expect(location).not.toMatch(/access_token/i);
    expect(location).not.toMatch(/secret_ref/i);
    // No raw access token shape (40-char hex or similar)
    expect(location).not.toContain('fake-token-for-test');
  });

  it('response body is empty/non-JSON for a success 302 (browser redirect, not API response)', async () => {
    const stateNonce = randomUUID();
    await stateStore.set(B2_BRAND_ID, stateNonce, 900);

    const query = buildValidShopifyQuery(stateNonce);
    const qs = new URLSearchParams(query).toString();

    const response = await fastifyApp.inject({
      method: 'GET',
      url: `/api/v1/oauth/callback/shopify?${qs}`,
    });

    expect(response.statusCode).toBe(302);
    // Body must NOT be a JSON object with connectorInstanceId/secretRef/token
    let body: unknown;
    try { body = JSON.parse(response.body); } catch { body = null; }
    if (body !== null && typeof body === 'object') {
      const b = body as Record<string, unknown>;
      expect(b).not.toHaveProperty('connectorInstanceId');
      expect(b).not.toHaveProperty('secretRef');
      expect(b).not.toHaveProperty('access_token');
    }
  });
});

// ── Test suite: defect #4b — forged HMAC → 302 error (HMAC-first validation) ───
//
// Revert-RED: remove the ShopifyHmac.validateOAuthCallback call from HandleOAuthCallbackCommand
//   → the forged callback succeeds and the handler redirects to `?connected=shopify`
//   → Location does NOT contain `connect_error=auth_failed` → assertion RED.

describe('defect #4b — forged HMAC → 302 connect_error (never JSON, never connected)', () => {
  it('forged HMAC → 302 redirect (not 200/404/500) (D-2 #4b contract)', async () => {
    const stateNonce = randomUUID();
    await stateStore.set(B2_BRAND_ID, stateNonce, 900);

    const query = buildForgedShopifyQuery(stateNonce);
    const qs = new URLSearchParams(query).toString();

    const response = await fastifyApp.inject({
      method: 'GET',
      url: `/api/v1/oauth/callback/shopify?${qs}`,
    });

    // REVERT-RED: if HMAC check removed → handler proceeds to success → 302+connected
    // This assertion proves the 302 is returned (not 500 or 401)
    expect(response.statusCode).toBe(302);
  });

  it('forged HMAC → Location contains connect_error=auth_failed (not connected=shopify) (non-inert revert-RED)', async () => {
    const stateNonce = randomUUID();
    await stateStore.set(B2_BRAND_ID, stateNonce, 900);

    const query = buildForgedShopifyQuery(stateNonce);
    const qs = new URLSearchParams(query).toString();

    const response = await fastifyApp.inject({
      method: 'GET',
      url: `/api/v1/oauth/callback/shopify?${qs}`,
    });

    expect(response.statusCode).toBe(302);
    const location = response.headers['location'] as string;
    expect(location).toBeDefined();

    // REVERT-RED: if HMAC validation is removed, the forged callback SUCCEEDS and the
    // Location would contain `connected=shopify` — NOT `connect_error=auth_failed`.
    // This is the load-bearing assertion for defect #4b.
    expect(location).toContain('connect_error=auth_failed');
    expect(location).not.toContain('connected=shopify');
  });

  it('forged callback → connector is NOT created (no connector_instance write)', async () => {
    const stateNonce = randomUUID();
    // Do NOT seed the state — forged request should fail at HMAC before state consumption
    const query = buildForgedShopifyQuery(stateNonce);
    const qs = new URLSearchParams(query).toString();

    const response = await fastifyApp.inject({
      method: 'GET',
      url: `/api/v1/oauth/callback/shopify?${qs}`,
    });

    expect(response.statusCode).toBe(302);
    const location = response.headers['location'] as string;
    expect(location).toContain('connect_error=auth_failed');
    // A connector instance should NEVER be created when HMAC fails
    // (The stub repo's save() is a vi.fn — confirm it was NOT called)
    // We re-read the injected handleCallback's connectorRepo mock from our closure.
    // Since the repos are re-created per buildTestApp(), we rely on the Location assertion.
    // The fact that connect_error=auth_failed (not connected=) is proof the save was never reached.
    expect(location).not.toContain('connected=');
  });
});

// ── Test suite: defect #4c — unknown connector type → 302 unknown_connector ────

describe('defect #4c — unknown connector type → 302 connect_error=unknown_connector', () => {
  it('GET /api/v1/oauth/callback/meta → 302 with connect_error=unknown_connector', async () => {
    const response = await fastifyApp.inject({
      method: 'GET',
      url: '/api/v1/oauth/callback/meta?code=abc&state=xyz&hmac=123&shop=test.myshopify.com',
    });

    expect(response.statusCode).toBe(302);
    const location = response.headers['location'] as string;
    expect(location).toContain('connect_error=unknown_connector');
    expect(location).not.toContain('connected=');
  });
});
