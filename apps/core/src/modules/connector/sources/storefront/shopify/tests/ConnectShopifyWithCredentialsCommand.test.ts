/**
 * ConnectShopifyWithCredentialsCommand unit tests — the GENERIC per-brand connect path.
 *
 * Proves:
 *   1. Happy path: client-credentials exchange → shop.json verify → app creds + token bundle
 *      stored → instance saved (NN-2: secret_ref = ARN) → sync status + event → webhook URL.
 *   2. Bad credentials (Shopify 401) → ShopifyCredentialsInvalidError, nothing persisted.
 *   3. Wrong domain (not *.myshopify.com) → InvalidShopDomainError BEFORE any network call.
 *   4. Full-URL normalization (https://my-store.myshopify.com/admin → my-store.myshopify.com).
 *   5. Storefront exclusivity: a connected WooCommerce storefront → 409-class
 *      StorefrontExclusivityError BEFORE any Shopify call.
 *   6. Token-verify failure (shop.json 401) → ShopifyCredentialsInvalidError.
 *   7. The stored token bundle carries auth_method/issued/expiry metadata the refresh cron reads,
 *      and the per-brand app-creds bundle is written for the webhook HMAC resolver.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  ConnectShopifyWithCredentialsCommand,
  InvalidShopDomainError,
  ShopifyCredentialsInvalidError,
  normalizeShopDomain,
} from '../application/commands/ConnectShopifyWithCredentialsCommand.js';
import { StorefrontExclusivityError } from '../../storefront-exclusivity.js';
import { LocalSecretsManager } from '@brain/connector-secrets';
import type { IConnectorInstanceRepository } from '../domain/repositories/IConnectorInstanceRepository.js';
import type { IConnectorSyncStatusRepository } from '../domain/repositories/IConnectorSyncStatusRepository.js';
import { ConnectorInstance } from '../domain/entities/ConnectorInstance.js';
import { ConnectorSyncStatus } from '../domain/entities/ConnectorSyncStatus.js';

const BRAND_ID = '550e8400-e29b-41d4-a716-446655440000';
const SHOP_DOMAIN = 'testbrand.myshopify.com';
const CLIENT_ID = 'custom-app-client-id';
const CLIENT_SECRET = 'custom-app-client-secret';
const ACCESS_TOKEN = 'shpat_test_token_never_logged';

function makeConnectorRepo(existing: ConnectorInstance[] = []): IConnectorInstanceRepository {
  return {
    findByBrandAndProvider: vi.fn().mockResolvedValue(null),
    findById: vi.fn().mockResolvedValue(null),
    findAllByBrand: vi.fn().mockResolvedValue(existing),
    findAllByBrandAndProvider: vi.fn().mockResolvedValue([]),
    activateAccount: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockImplementation(async (inst: ConnectorInstance) => inst),
    update: vi.fn().mockImplementation(async (inst: ConnectorInstance) => inst),
  };
}

function makeSyncStatusRepo(): IConnectorSyncStatusRepository {
  const status = ConnectorSyncStatus.create({
    id: '22222222-0000-0000-0000-000000000001',
    brandId: BRAND_ID,
    connectorInstanceId: '11111111-0000-0000-0000-000000000001',
    state: 'waiting_for_data',
    lastSyncAt: null,
    lastError: null,
    updatedAt: new Date(),
  });
  return {
    findByConnectorInstanceId: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockResolvedValue(status),
    update: vi.fn().mockResolvedValue(status),
  };
}

/** fetch stub: client-credentials exchange + shop.json verify, both configurable. */
function makeFetch(opts?: {
  exchangeStatus?: number;
  verifyStatus?: number;
  expiresIn?: number;
}): typeof fetch {
  const exchangeStatus = opts?.exchangeStatus ?? 200;
  const verifyStatus = opts?.verifyStatus ?? 200;
  return vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.endsWith('/admin/oauth/access_token')) {
      return {
        ok: exchangeStatus >= 200 && exchangeStatus < 300,
        status: exchangeStatus,
        json: async () => ({ access_token: ACCESS_TOKEN, expires_in: opts?.expiresIn ?? 86399 }),
      } as Response;
    }
    if (u.includes('/shop.json')) {
      return {
        ok: verifyStatus >= 200 && verifyStatus < 300,
        status: verifyStatus,
        json: async () => ({ shop: { myshopify_domain: SHOP_DOMAIN } }),
      } as Response;
    }
    throw new Error(`unexpected fetch: ${u}`);
  }) as unknown as typeof fetch;
}

function makeCommand(overrides?: {
  connectorRepo?: IConnectorInstanceRepository;
  fetchImpl?: typeof fetch;
  appEnv?: string;
  secretsManager?: LocalSecretsManager;
  emitEvent?: ReturnType<typeof vi.fn>;
  syncStatusRepo?: IConnectorSyncStatusRepository;
}) {
  const secretsManager = overrides?.secretsManager ?? new LocalSecretsManager();
  const connectorRepo = overrides?.connectorRepo ?? makeConnectorRepo();
  const syncStatusRepo = overrides?.syncStatusRepo ?? makeSyncStatusRepo();
  const emitEvent = overrides?.emitEvent ?? vi.fn().mockResolvedValue(undefined);
  const fetchImpl = overrides?.fetchImpl ?? makeFetch();
  const cmd = new ConnectShopifyWithCredentialsCommand(
    secretsManager,
    connectorRepo,
    syncStatusRepo,
    emitEvent,
    overrides?.appEnv ?? 'development', // dev → webhook registration is a stubbed no-op
    'https://api.brain.example',
    fetchImpl,
    () => new Date('2026-07-12T00:00:00Z'),
  );
  return { cmd, secretsManager, connectorRepo, syncStatusRepo, emitEvent, fetchImpl };
}

describe('normalizeShopDomain', () => {
  it('accepts a bare domain unchanged (lowercased)', () => {
    expect(normalizeShopDomain('My-Store.MyShopify.com')).toBe('my-store.myshopify.com');
  });
  it('strips scheme, path, query, port and whitespace from a full URL', () => {
    expect(normalizeShopDomain(' https://my-store.myshopify.com/admin?x=1 ')).toBe('my-store.myshopify.com');
    expect(normalizeShopDomain('http://my-store.myshopify.com:443/')).toBe('my-store.myshopify.com');
  });
});

describe('ConnectShopifyWithCredentialsCommand', () => {
  it('happy path: connects, stores app creds + token bundle, saves instance, emits event', async () => {
    const { cmd, secretsManager, connectorRepo, syncStatusRepo, emitEvent } = makeCommand();

    const result = await cmd.execute({
      brandId: BRAND_ID,
      shopDomain: `https://${SHOP_DOMAIN}/`,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      idempotencyKey: 'idem-1',
    });

    expect(result.status).toBe('connected');
    expect(result.shopDomain).toBe(SHOP_DOMAIN);
    expect(result.webhookUrl).toBe('https://api.brain.example/api/v1/webhooks/shopify');

    // Instance saved with an ARN secret_ref (NN-2) + client_credentials provider_config.
    const saved = (connectorRepo.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ConnectorInstance;
    expect(saved.secretRef).toMatch(/^arn:aws:secretsmanager:/);
    expect(saved.provider).toBe('shopify');
    expect(saved.shopDomain).toBe(SHOP_DOMAIN);
    expect(saved.providerConfig).toMatchObject({ shop_domain: SHOP_DOMAIN, auth_method: 'client_credentials' });

    // The per-brand APP creds bundle exists (webhook HMAC resolver + refresh cron read it).
    const appCreds = await secretsManager.getSecret(`brain/connector/shopify_app/${BRAND_ID}`);
    expect(appCreds).toMatchObject({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET });

    // The token bundle carries the refresh metadata (auth_method / issued / expires).
    const bundle = await secretsManager.getSecret(saved.secretRef);
    expect(bundle).toMatchObject({
      access_token: ACCESS_TOKEN,
      shop_domain: SHOP_DOMAIN,
      auth_method: 'client_credentials',
      access_token_issued_at: '2026-07-12T00:00:00.000Z',
    });
    expect(Date.parse(bundle!['access_token_expires_at']!)).toBeGreaterThan(
      Date.parse('2026-07-12T00:00:00Z'),
    );

    // Bundle-aware token read: getShopifyToken unwraps the JSON bundle to the bare token.
    await expect(secretsManager.getShopifyToken(saved.secretRef)).resolves.toBe(ACCESS_TOKEN);

    expect(syncStatusRepo.save).toHaveBeenCalledOnce();
    expect(emitEvent).toHaveBeenCalledWith(
      'connector.connected',
      expect.objectContaining({
        brand_id: BRAND_ID,
        provider: 'shopify',
        shop_domain: SHOP_DOMAIN,
        auth_method: 'client_credentials',
      }),
    );
    // I-S09: the event payload never carries credentials or the token.
    const eventPayload = (emitEvent as ReturnType<typeof vi.fn>).mock.calls[0]![1] as Record<string, unknown>;
    expect(JSON.stringify(eventPayload)).not.toContain(CLIENT_SECRET);
    expect(JSON.stringify(eventPayload)).not.toContain(ACCESS_TOKEN);
  });

  it('bad credentials (exchange 401) → ShopifyCredentialsInvalidError, nothing persisted', async () => {
    const { cmd, connectorRepo, emitEvent, secretsManager } = makeCommand({
      fetchImpl: makeFetch({ exchangeStatus: 401 }),
    });

    await expect(
      cmd.execute({
        brandId: BRAND_ID,
        shopDomain: SHOP_DOMAIN,
        clientId: CLIENT_ID,
        clientSecret: 'wrong-secret',
        idempotencyKey: 'idem-2',
      }),
    ).rejects.toThrow(ShopifyCredentialsInvalidError);

    expect(connectorRepo.save).not.toHaveBeenCalled();
    expect(emitEvent).not.toHaveBeenCalled();
    await expect(secretsManager.getSecret(`brain/connector/shopify_app/${BRAND_ID}`)).resolves.toBeNull();
  });

  it('token verification failure (shop.json 401) → ShopifyCredentialsInvalidError', async () => {
    const { cmd, connectorRepo } = makeCommand({ fetchImpl: makeFetch({ verifyStatus: 401 }) });

    await expect(
      cmd.execute({
        brandId: BRAND_ID,
        shopDomain: SHOP_DOMAIN,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        idempotencyKey: 'idem-3',
      }),
    ).rejects.toThrow(ShopifyCredentialsInvalidError);
    expect(connectorRepo.save).not.toHaveBeenCalled();
  });

  it('wrong domain → InvalidShopDomainError with NO network call', async () => {
    const fetchImpl = makeFetch();
    const { cmd } = makeCommand({ fetchImpl });

    await expect(
      cmd.execute({
        brandId: BRAND_ID,
        shopDomain: 'https://www.not-shopify.com',
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        idempotencyKey: 'idem-4',
      }),
    ).rejects.toThrow(InvalidShopDomainError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('storefront exclusivity: connected WooCommerce → StorefrontExclusivityError before any Shopify call', async () => {
    const woo = ConnectorInstance.create({
      id: '33333333-0000-0000-0000-000000000001',
      brandId: BRAND_ID,
      provider: 'woocommerce',
      shopDomain: 'https://ulinen.example',
      secretRef: 'arn:aws:secretsmanager:us-east-1:000000000000:secret:brain/connector/woocommerce/x',
      status: 'connected',
      healthState: 'Healthy',
      safetyRating: 'safe',
      connectedAt: new Date(),
      disconnectedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const fetchImpl = makeFetch();
    const { cmd } = makeCommand({ connectorRepo: makeConnectorRepo([woo]), fetchImpl });

    await expect(
      cmd.execute({
        brandId: BRAND_ID,
        shopDomain: SHOP_DOMAIN,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        idempotencyKey: 'idem-5',
      }),
    ).rejects.toThrow(StorefrontExclusivityError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
