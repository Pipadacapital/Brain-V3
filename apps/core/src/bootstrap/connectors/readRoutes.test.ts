/**
 * readRoutes.test.ts — GET /api/v1/connectors marketplace tile wire format.
 *
 * Test-local Fastify app with registerConnectorReadRoutes + stub repos (pattern:
 * writeRoutes.test.ts). No DB — the tiles come from the static CONNECTOR_CATALOG.
 *
 * PINNED CONTRACTS (shopify-byo-app-required Task 7):
 *   - The Shopify tile carries byo_app_required=true + byo_app_setup whose redirect_url is
 *     filled at request-build time from config.shopifyCallbackUrl (the catalog stores '').
 *   - Meta / Google Ads tiles keep byo_app_required falsy (optional-with-fallback stays).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';

import { registerConnectorReadRoutes, type RegisterConnectorReadRoutesDeps } from './readRoutes.js';

const BRAND = 'b7b70007-0007-4007-8007-000000000007';
const CALLBACK = 'https://brain.example/api/v1/oauth/callback/shopify';

let app: FastifyInstance;

interface Tile {
  id: string;
  byo_app_required?: boolean;
  byo_app_setup?: { redirect_url: string; scopes: string[]; docs_url?: string | null } | null;
}

async function getTiles(): Promise<Tile[]> {
  const res = await app.inject({ method: 'GET', url: '/api/v1/connectors' });
  expect(res.statusCode).toBe(200);
  return (JSON.parse(res.body) as { data: { tiles: Tile[] } }).data.tiles;
}

beforeAll(async () => {
  app = Fastify({ logger: false });

  const sessionPreHandler = async (req: FastifyRequest): Promise<void> => {
    (req as FastifyRequest & { auth?: unknown }).auth = {
      userId: 'u-readroutes-test',
      jti: 'jti-readroutes-test',
      brandId: BRAND,
      workspaceId: 'w-readroutes-test',
      role: 'analyst',
    };
  };

  const deps = {
    config: {
      nodeEnv: 'test',
      appBaseUrl: 'http://localhost:3000',
      shopifyCallbackUrl: CALLBACK,
      metaCallbackUrl: 'http://localhost:3001/api/v1/oauth/callback/meta',
      googleAdsCallbackUrl: 'http://localhost:3001/api/v1/oauth/callback/google_ads',
      pixelIngestBaseUrl: 'http://localhost:8787',
      kafkaEnv: 'test',
    },
    connectorRepo: { findAllByBrand: vi.fn().mockResolvedValue([]) },
    syncStatusRepo: { findByConnectorInstanceId: vi.fn().mockResolvedValue(null) },
    sessionPreHandler,
  } as unknown as RegisterConnectorReadRoutesDeps;

  registerConnectorReadRoutes(app, deps);
  await app.ready();
});

afterAll(async () => {
  await app.close().catch(() => undefined);
});

describe('GET /api/v1/connectors — BYO-app tile fields', () => {
  it('shopify tile carries byo_app_required=true + byo_app_setup with redirect_url + scopes', async () => {
    const tiles = await getTiles();
    const shopify = tiles.find((t) => t.id === 'shopify')!;
    expect(shopify.byo_app_required).toBe(true);
    expect(shopify.byo_app_setup).toBeDefined();
    expect(shopify.byo_app_setup!.redirect_url).toBe(CALLBACK);
    expect(shopify.byo_app_setup!.scopes).toContain('read_orders');
    expect(shopify.byo_app_setup!.scopes).toContain('write_pixels');
  });

  it('meta + google_ads tiles have byo_app_required falsy', async () => {
    const tiles = await getTiles();
    expect(tiles.find((t) => t.id === 'meta')!.byo_app_required).not.toBe(true);
    expect(tiles.find((t) => t.id === 'google_ads')!.byo_app_required).not.toBe(true);
  });
});
