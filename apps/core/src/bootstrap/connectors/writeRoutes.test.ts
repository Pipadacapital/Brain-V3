/**
 * writeRoutes.test.ts — POST /api/v1/connectors BYO-app enforcement (Shopify).
 *
 * Builds a test-local Fastify app with registerConnectorWriteRoutes and mock deps
 * (pattern: oauth-callback.integration.test.ts). The OAuth dispatch table is a global
 * registry — stub shopify/meta dispatches are registered idempotently and echo the
 * resolved clientId into the oauth_url, which is what proves the route stored +
 * resolved the brand's own app credentials (not the env app).
 *
 * PINNED CONTRACTS (shopify-byo-app-required Task 4, updated for the client-credentials
 * connect — owner requirement 2026-07-12):
 *   - Shopify connect WITHOUT client_id+client_secret and NO shared env app →
 *     400 MISSING_SHOPIFY_CREDENTIALS (never a silent initiate against the shared env app).
 *   - Shopify connect WITH creds → 200 kind:'credential' via the bespoke
 *     ConnectShopifyWithCredentialsCommand (client-credentials exchange, no OAuth redirect).
 *   - Meta keeps optional-with-fallback behavior (no byoAppRequired) — regression guard.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { resetAllConfigCaches } from '@brain/config';
import type { ISecretsManager } from '@brain/connector-secrets';

// Route-level test: the bespoke client-credentials command is unit-tested in
// ConnectShopifyWithCredentialsCommand.test.ts — here it is stubbed so the route's wire
// contract can be pinned without a live token exchange. Error classes stay real.
const shopifyCredsConnect = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock(
  '../../modules/connector/sources/storefront/shopify/application/commands/ConnectShopifyWithCredentialsCommand.js',
  async (importOriginal) => {
    const actual = await importOriginal<
      typeof import('../../modules/connector/sources/storefront/shopify/application/commands/ConnectShopifyWithCredentialsCommand.js')
    >();
    return {
      ...actual,
      ConnectShopifyWithCredentialsCommand: class {
        execute = shopifyCredsConnect.execute;
      },
    };
  },
);

import { registerConnectorWriteRoutes, type RegisterConnectorWriteRoutesDeps } from './writeRoutes.js';
import { registerOAuthDispatch } from '../../modules/connector/catalog/dispatch.js';

const BRAND = 'b4b40004-0004-4004-8004-000000000004';

// ── In-memory ISecretsManager (name derivation mirrors appSecretName) ─────────

function makeInMemorySecrets(): ISecretsManager {
  const store = new Map<string, Record<string, string>>();
  return {
    storeSecret: vi.fn(async (brandId: string, ref: { connectorType: string; subKey?: string }, credential: Record<string, string>) => {
      const name = `brain/connector/${ref.connectorType}/${brandId}`;
      store.set(name, credential);
      return { arn: `arn:test:${name}`, name };
    }),
    getSecret: vi.fn(async (nameOrArn: string) => store.get(nameOrArn.replace(/^arn:test:/, '')) ?? null),
    putSecretValue: vi.fn(),
    deleteSecret: vi.fn(),
    storeShopifyToken: vi.fn(),
    getShopifyClientSecret: vi.fn(),
    deleteShopifyToken: vi.fn(),
    getShopifyToken: vi.fn(),
  } as unknown as ISecretsManager;
}

// ── Test-local Fastify app ─────────────────────────────────────────────────────

let app: FastifyInstance;

async function buildTestApp(): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false });

  // Stub dispatches (registerOAuthDispatch is idempotent — safe overwrite for tests).
  // Both mirror the real commands' contract: no clientId → OAUTH_NOT_CONFIGURED (503).
  registerOAuthDispatch('shopify', {
    initiate: async ({ shopDomain, clientId }) => {
      if (!shopDomain) {
        throw Object.assign(new Error('shop_domain is required for shopify OAuth'), { code: 'MISSING_SHOP_DOMAIN' });
      }
      if (!clientId) {
        throw Object.assign(new Error('Shopify OAuth is not configured'), { code: 'OAUTH_NOT_CONFIGURED' });
      }
      return {
        oauth_url: `https://${shopDomain}/admin/oauth/authorize?client_id=${encodeURIComponent(clientId)}&scope=read_orders`,
      };
    },
  });
  registerOAuthDispatch('meta', {
    initiate: async ({ clientId }) => {
      if (!clientId) {
        throw Object.assign(new Error('Meta OAuth is not configured'), { code: 'OAUTH_NOT_CONFIGURED' });
      }
      return { oauth_url: `https://www.facebook.com/v19.0/dialog/oauth?client_id=${encodeURIComponent(clientId)}` };
    },
  });

  // Session stub: populates req.auth (manager role, verified brand context).
  const sessionPreHandler = async (req: FastifyRequest): Promise<void> => {
    (req as FastifyRequest & { auth?: unknown }).auth = {
      userId: 'u-writeroutes-test',
      jti: 'jti-writeroutes-test',
      brandId: BRAND,
      workspaceId: 'w-writeroutes-test',
      role: 'manager',
    };
  };

  const deps = {
    config: {
      nodeEnv: 'test',
      appBaseUrl: 'http://localhost:3000',
      shopifyCallbackUrl: 'http://localhost:3001/api/v1/oauth/callback/shopify',
      metaCallbackUrl: 'http://localhost:3001/api/v1/oauth/callback/meta',
      googleAdsCallbackUrl: 'http://localhost:3001/api/v1/oauth/callback/google_ads',
      pixelIngestBaseUrl: 'http://localhost:8787',
      kafkaEnv: 'test',
    },
    rawPgPool: { connect: vi.fn() },
    connectorRepo: { save: vi.fn(), update: vi.fn(), findById: vi.fn() },
    syncStatusRepo: { save: vi.fn(), update: vi.fn() },
    connectorSecretsManager: makeInMemorySecrets(),
    emitEvent: vi.fn().mockResolvedValue(undefined),
    auditWriter: { append: vi.fn().mockResolvedValue(undefined) },
    authService: { isEmailVerified: vi.fn().mockResolvedValue(true) },
    sessionPreHandler,
    oauthCommands: {
      initiateOAuth: { execute: vi.fn() },
      initiateMetaOAuth: { execute: vi.fn() },
      handleMetaCallback: { execute: vi.fn() },
      initiateGoogleAdsOAuth: { execute: vi.fn() },
      handleGoogleAdsCallback: { execute: vi.fn() },
    },
  } as unknown as RegisterConnectorWriteRoutesDeps;

  registerConnectorWriteRoutes(instance, deps);
  await instance.ready();
  return instance;
}

beforeAll(async () => {
  // resolveBrandOAuthClientId's env fallback calls loadCoreConfig(), whose schema requires
  // DATABASE_URL. Provide a deterministic value (no DB is opened) and re-parse fresh.
  process.env['DATABASE_URL'] ??= 'postgres://brain:brain@localhost:5432/brain';
  // The shared-env-app OAuth fallback is gated on SHOPIFY_CLIENT_ID — unset it so the
  // no-credentials case deterministically hits 400 MISSING_SHOPIFY_CREDENTIALS.
  delete process.env['SHOPIFY_CLIENT_ID'];
  resetAllConfigCaches();
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close().catch(() => undefined);
});

// ── BYO-required: Shopify ──────────────────────────────────────────────────────

describe('POST /api/v1/connectors — Shopify BYO-app required', () => {
  it('POST { type:"shopify" } without credentials + no env app → 400 MISSING_SHOPIFY_CREDENTIALS', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/connectors',
      payload: { type: 'shopify', shop_domain: 'demo.myshopify.com' },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error?.code).toBe('MISSING_SHOPIFY_CREDENTIALS');
  });

  it('POST { type:"shopify" } with client_id + client_secret → 200 credential connect (no OAuth redirect)', async () => {
    shopifyCredsConnect.execute.mockResolvedValueOnce({
      connectorInstanceId: 'ci-shopify-byo-test',
      shopDomain: 'demo.myshopify.com',
      webhookUrl: 'http://localhost:3001/api/v1/webhooks/platform/shopify',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/connectors',
      payload: {
        type: 'shopify',
        shop_domain: 'demo.myshopify.com',
        credentials: { client_id: 'brand-app-id', client_secret: 'brand-app-secret' },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data?.kind).toBe('credential');
    expect(body.data?.connected).toBe(true);
    expect(body.data?.connector_instance_id).toBe('ci-shopify-byo-test');
    // The brand's OWN creds reach the client-credentials exchange — never the env app.
    expect(shopifyCredsConnect.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        brandId: BRAND,
        shopDomain: 'demo.myshopify.com',
        clientId: 'brand-app-id',
        clientSecret: 'brand-app-secret',
      }),
    );
  });

  it('POST { type:"meta" } without credentials still initiates (env fallback allowed)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/connectors',
      payload: { type: 'meta' },
    });
    // Regression guard: Meta keeps the optional-with-fallback behavior.
    expect([200, 503]).toContain(res.statusCode); // 503 only if env unset; 200 with env
  });
});
