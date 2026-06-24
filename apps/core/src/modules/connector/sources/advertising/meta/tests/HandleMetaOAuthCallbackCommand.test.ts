/**
 * HandleMetaOAuthCallbackCommand unit tests (feat-ad-connectors Track 1 / ADR-AD-2).
 *
 * Acceptance items proven here (05-architecture §6):
 *   1. brand-from-state, NEVER-from-body — a forged brand_id query param has no effect (anti-spoof).
 *   2. token NEVER in the result, NEVER persisted to PG as a token (only the ARN secret_ref).
 *   3. invalid/expired/reused state nonce → MetaStateNonceError (no connector created).
 *   4. NO HMAC step — there is no client-secret-signature gate (the nonce IS the auth).
 *
 * Revert-RED: if the command read brand_id from the query, the forged-body test would see
 * ATTACKER_BRAND_ID on the saved instance → RED.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  HandleMetaOAuthCallbackCommand,
  MetaStateNonceError,
} from '../application/commands/HandleMetaOAuthCallbackCommand.js';
import { InProcessOAuthStateStore } from '../../../storefront/shopify/infrastructure/state/InProcessOAuthStateStore.js';
import { LocalSecretsManager } from '@brain/connector-secrets';
import type { IConnectorInstanceRepository } from '@brain/connector-core';
import type { IConnectorSyncStatusRepository } from '@brain/connector-core';
import { ConnectorInstance } from '@brain/connector-core';
import { ConnectorSyncStatus } from '@brain/connector-core';

const REAL_BRAND_ID = '550e8400-e29b-41d4-a716-446655440000';
const ATTACKER_BRAND_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const TOKEN_VALUE = 'EAABmeta_secret_access_token_value';

function makeConnectorRepo(brandId: string): IConnectorInstanceRepository {
  const base = ConnectorInstance.create({
    id: '11111111-0000-0000-0000-000000000001',
    brandId,
    provider: 'meta',
    shopDomain: '', // ads connectors have no shop domain
    secretRef: 'arn:aws:secretsmanager:us-east-1:000000000000:secret:brain/connector/meta/test',
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
    save: vi.fn().mockResolvedValue(base),
    update: vi.fn().mockResolvedValue(base),
  };
}

function makeSyncStatusRepo(): IConnectorSyncStatusRepository {
  const status = ConnectorSyncStatus.create({
    id: '22222222-0000-0000-0000-000000000001',
    brandId: REAL_BRAND_ID,
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

/** Stub Graph API: token exchange returns a token; /me/adaccounts returns one account. */
function stubMetaFetch(token = TOKEN_VALUE) {
  vi.stubGlobal('fetch', async (url: string | URL) => {
    const u = typeof url === 'string' ? url : url.toString();
    if (u.includes('/oauth/access_token')) {
      return new Response(JSON.stringify({ access_token: token }), { status: 200 });
    }
    if (u.includes('/me/adaccounts')) {
      return new Response(JSON.stringify({ data: [{ id: 'act_123456', account_id: '123456' }] }), {
        status: 200,
      });
    }
    throw new Error(`[meta test] unexpected fetch: ${u}`);
  });
}

describe('HandleMetaOAuthCallbackCommand', () => {
  beforeEach(() => {
    process.env['NODE_ENV'] = 'development';
    process.env['META_APP_ID'] = 'test-meta-app-id';
    process.env['META_APP_SECRET'] = 'test-meta-app-secret';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('derives brandId from the server-stored state record, IGNORING a forged brand_id query param (D-1 anti-spoof)', async () => {
    const stateStore = new InProcessOAuthStateStore();
    const secretsMgr = new LocalSecretsManager();
    const connectorRepo = makeConnectorRepo(REAL_BRAND_ID);
    const syncStatusRepo = makeSyncStatusRepo();
    const emitEvent = vi.fn().mockResolvedValue(undefined);
    stubMetaFetch();

    const cmd = new HandleMetaOAuthCallbackCommand(
      secretsMgr,
      stateStore,
      connectorRepo,
      syncStatusRepo,
      emitEvent,
    );

    const stateNonce = 'meta-state-nonce-1';
    // Bind REAL_BRAND_ID into the server-side record at init time.
    await stateStore.set(REAL_BRAND_ID, stateNonce, 900);

    // Forged callback: attacker appends brand_id to the query. It MUST be ignored.
    const query = {
      code: 'auth_code_meta',
      state: stateNonce,
      brand_id: ATTACKER_BRAND_ID,
    };

    const result = await cmd.execute({ query, idempotencyKey: 'idem-meta-1' });

    const saveMock = connectorRepo.save as ReturnType<typeof vi.fn>;
    expect(saveMock).toHaveBeenCalledOnce();
    const saved = saveMock.mock.calls[0]![0] as ConnectorInstance;
    expect(saved.brandId).toBe(REAL_BRAND_ID);
    expect(saved.brandId).not.toBe(ATTACKER_BRAND_ID);
    expect(saved.provider).toBe('meta');
    expect(result.brandId).toBe(REAL_BRAND_ID);
    expect(emitEvent).toHaveBeenCalledWith(
      'connector.connected',
      expect.objectContaining({ brand_id: REAL_BRAND_ID, provider: 'meta' }),
    );
  });

  it('stores the Meta ad-account NAME in provider_config for each account (UI label, Gap B)', async () => {
    const stateStore = new InProcessOAuthStateStore();
    const secretsMgr = new LocalSecretsManager();
    const connectorRepo = makeConnectorRepo(REAL_BRAND_ID);
    const syncStatusRepo = makeSyncStatusRepo();
    const emitEvent = vi.fn().mockResolvedValue(undefined);

    // Two accounts, each with a human name — the field the UI labels its sub-cards with.
    vi.stubGlobal('fetch', async (url: string | URL) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('/oauth/access_token')) {
        return new Response(JSON.stringify({ access_token: TOKEN_VALUE }), { status: 200 });
      }
      if (u.includes('/me/adaccounts')) {
        // the request MUST ask for the name field
        expect(u).toContain('name');
        return new Response(
          JSON.stringify({
            data: [
              { id: 'act_111', account_id: '111', name: 'Acme Prospecting' },
              { id: 'act_222', account_id: '222', name: 'Acme Retargeting' },
            ],
          }),
          { status: 200 },
        );
      }
      throw new Error(`[meta test] unexpected fetch: ${u}`);
    });

    const cmd = new HandleMetaOAuthCallbackCommand(secretsMgr, stateStore, connectorRepo, syncStatusRepo, emitEvent);
    const stateNonce = 'meta-state-names';
    await stateStore.set(REAL_BRAND_ID, stateNonce, 900);
    await cmd.execute({ query: { code: 'auth_code_meta', state: stateNonce }, idempotencyKey: 'idem-names' });

    const saveMock = connectorRepo.save as ReturnType<typeof vi.fn>;
    expect(saveMock).toHaveBeenCalledTimes(2); // one instance per account (Gap B)
    const saved = saveMock.mock.calls.map((c) => c[0] as ConnectorInstance);
    const byKey = new Map(saved.map((s) => [s.accountKey, s.providerConfig as Record<string, unknown>]));
    expect(byKey.get('act_111')).toMatchObject({ ad_account_id: 'act_111', ad_account_name: 'Acme Prospecting' });
    expect(byKey.get('act_222')).toMatchObject({ ad_account_id: 'act_222', ad_account_name: 'Acme Retargeting' });
  });

  it('does NOT expose the access token in the result and never emits it (NN-2 / I-S09)', async () => {
    const stateStore = new InProcessOAuthStateStore();
    const secretsMgr = new LocalSecretsManager();
    const connectorRepo = makeConnectorRepo(REAL_BRAND_ID);
    const syncStatusRepo = makeSyncStatusRepo();
    const emitEvent = vi.fn().mockResolvedValue(undefined);
    stubMetaFetch();

    const cmd = new HandleMetaOAuthCallbackCommand(
      secretsMgr,
      stateStore,
      connectorRepo,
      syncStatusRepo,
      emitEvent,
    );

    const stateNonce = 'meta-state-nonce-2';
    await stateStore.set(REAL_BRAND_ID, stateNonce, 900);
    const result = await cmd.execute({
      query: { code: 'auth_code_meta', state: stateNonce },
      idempotencyKey: 'idem-meta-2',
    });

    expect(result).not.toHaveProperty('access_token');
    expect(JSON.stringify(result)).not.toContain(TOKEN_VALUE);
    // The emitted event payload must not contain the token.
    const emittedPayload = (emitEvent as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(JSON.stringify(emittedPayload)).not.toContain(TOKEN_VALUE);
    // secret_ref persisted on the saved instance is an ARN, not the token.
    const saved = (connectorRepo.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ConnectorInstance;
    expect(saved.secretRef).toMatch(/^arn:aws:/);
    expect(saved.secretRef).not.toContain(TOKEN_VALUE);
  });

  it('throws MetaStateNonceError for an unknown/expired state and creates no connector', async () => {
    const stateStore = new InProcessOAuthStateStore();
    const secretsMgr = new LocalSecretsManager();
    const connectorRepo = makeConnectorRepo(REAL_BRAND_ID);
    const syncStatusRepo = makeSyncStatusRepo();
    const emitEvent = vi.fn().mockResolvedValue(undefined);
    stubMetaFetch();

    const cmd = new HandleMetaOAuthCallbackCommand(
      secretsMgr,
      stateStore,
      connectorRepo,
      syncStatusRepo,
      emitEvent,
    );

    await expect(
      cmd.execute({ query: { code: 'x', state: 'nonexistent' }, idempotencyKey: 'idem-meta-3' }),
    ).rejects.toThrow(MetaStateNonceError);
    expect(connectorRepo.save).not.toHaveBeenCalled();
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it('state nonce is single-use — a replayed callback fails (NN-4)', async () => {
    const stateStore = new InProcessOAuthStateStore();
    const secretsMgr = new LocalSecretsManager();
    const connectorRepo = makeConnectorRepo(REAL_BRAND_ID);
    const syncStatusRepo = makeSyncStatusRepo();
    const emitEvent = vi.fn().mockResolvedValue(undefined);
    stubMetaFetch();

    const cmd = new HandleMetaOAuthCallbackCommand(
      secretsMgr,
      stateStore,
      connectorRepo,
      syncStatusRepo,
      emitEvent,
    );

    const stateNonce = 'meta-state-single-use';
    await stateStore.set(REAL_BRAND_ID, stateNonce, 900);
    await cmd.execute({ query: { code: 'c', state: stateNonce }, idempotencyKey: 'idem-a' });
    // Second consume of the same nonce → rejected.
    await expect(
      cmd.execute({ query: { code: 'c', state: stateNonce }, idempotencyKey: 'idem-b' }),
    ).rejects.toThrow(MetaStateNonceError);
  });

  it('connects even when ad_account_id cannot be resolved (honest null)', async () => {
    const stateStore = new InProcessOAuthStateStore();
    const secretsMgr = new LocalSecretsManager();
    const connectorRepo = makeConnectorRepo(REAL_BRAND_ID);
    const syncStatusRepo = makeSyncStatusRepo();
    const emitEvent = vi.fn().mockResolvedValue(undefined);
    // adaccounts endpoint returns 403 → adAccountId resolves to null.
    vi.stubGlobal('fetch', async (url: string | URL) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('/oauth/access_token')) {
        return new Response(JSON.stringify({ access_token: TOKEN_VALUE }), { status: 200 });
      }
      return new Response('forbidden', { status: 403 });
    });

    const setAdAccountId = vi.fn().mockResolvedValue(undefined);
    const cmd = new HandleMetaOAuthCallbackCommand(
      secretsMgr,
      stateStore,
      connectorRepo,
      syncStatusRepo,
      emitEvent,
      setAdAccountId,
    );

    const stateNonce = 'meta-state-no-account';
    await stateStore.set(REAL_BRAND_ID, stateNonce, 900);
    const result = await cmd.execute({
      query: { code: 'c', state: stateNonce },
      idempotencyKey: 'idem-na',
    });
    expect(result.adAccountId).toBeNull();
    expect(result.status).toBe('connected');
    // setAdAccountId must NOT be called when there's nothing to persist.
    expect(setAdAccountId).not.toHaveBeenCalled();
  });

  it('never puts the app secret or access token in a request URL (SEC-AD-H1 / SEC-AD-M1)', async () => {
    const stateStore = new InProcessOAuthStateStore();
    const secretsMgr = new LocalSecretsManager();
    const connectorRepo = makeConnectorRepo(REAL_BRAND_ID);
    const syncStatusRepo = makeSyncStatusRepo();
    const emitEvent = vi.fn().mockResolvedValue(undefined);

    // Capture every (url, init) the command issues.
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : url.toString();
      calls.push({ url: u, init });
      if (u.includes('/oauth/access_token')) {
        return new Response(JSON.stringify({ access_token: TOKEN_VALUE }), { status: 200 });
      }
      if (u.includes('/me/adaccounts')) {
        return new Response(JSON.stringify({ data: [{ id: 'act_123' }] }), { status: 200 });
      }
      throw new Error(`[meta test] unexpected fetch: ${u}`);
    });

    const cmd = new HandleMetaOAuthCallbackCommand(
      secretsMgr,
      stateStore,
      connectorRepo,
      syncStatusRepo,
      emitEvent,
    );
    const stateNonce = 'meta-state-url-hygiene';
    await stateStore.set(REAL_BRAND_ID, stateNonce, 900);
    await cmd.execute({ query: { code: 'auth_code_meta', state: stateNonce }, idempotencyKey: 'idem-url' });

    const tokenExchange = calls.find((c) => c.url.includes('/oauth/access_token'))!;
    // SEC-AD-H1: POST with the secret in the BODY, NEVER in the URL.
    expect(tokenExchange.init?.method).toBe('POST');
    expect(tokenExchange.url).not.toContain('test-meta-app-secret');
    expect(tokenExchange.url).not.toContain('client_secret');
    expect(String(tokenExchange.init?.body)).toContain('test-meta-app-secret');

    const adAccounts = calls.find((c) => c.url.includes('/me/adaccounts'))!;
    // SEC-AD-M1: token rides the Authorization header, never the query string.
    expect(adAccounts.url).not.toContain(TOKEN_VALUE);
    expect(adAccounts.url).not.toContain('access_token=');
    const authHeader = (adAccounts.init?.headers as Record<string, string> | undefined)?.['Authorization'];
    expect(authHeader).toBe(`Bearer ${TOKEN_VALUE}`);
  });
});
