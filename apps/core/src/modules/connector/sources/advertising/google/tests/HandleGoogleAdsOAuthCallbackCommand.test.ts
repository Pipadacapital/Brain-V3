/**
 * HandleGoogleAdsOAuthCallbackCommand unit tests (feat-ad-connectors Track 1 / ADR-AD-2).
 *
 * Acceptance items proven:
 *   1. brand-from-state, NEVER-from-body (anti-spoof).
 *   2. refresh_token persisted as a SECRET BUNDLE (ARN only on the row) — never in the result/event.
 *   3. missing refresh_token (offline access not granted) → GoogleAdsOAuthError (honest).
 *   4. state nonce single-use.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  HandleGoogleAdsOAuthCallbackCommand,
  GoogleAdsStateNonceError,
  GoogleAdsOAuthError,
} from '../application/commands/HandleGoogleAdsOAuthCallbackCommand.js';
import { InProcessOAuthStateStore } from '../../../storefront/shopify/infrastructure/state/InProcessOAuthStateStore.js';
import { LocalSecretsManager } from '@brain/connector-secrets';
import type { IConnectorInstanceRepository } from '@brain/connector-core';
import type { IConnectorSyncStatusRepository } from '@brain/connector-core';
import { ConnectorInstance } from '@brain/connector-core';
import { ConnectorSyncStatus } from '@brain/connector-core';

const REAL_BRAND_ID = '550e8400-e29b-41d4-a716-446655440000';
const ATTACKER_BRAND_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const REFRESH_TOKEN = '1//google_secret_refresh_token_value';
const ACCESS_TOKEN = 'ya29.google_short_lived_access_token';

function makeConnectorRepo(brandId: string): IConnectorInstanceRepository {
  const base = ConnectorInstance.create({
    id: '11111111-0000-0000-0000-000000000001',
    brandId,
    provider: 'google_ads',
    shopDomain: '',
    secretRef: 'arn:aws:secretsmanager:us-east-1:000000000000:secret:brain/connector/google_ads/test',
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

function stubGoogleFetch(opts: { refresh?: string | undefined } = {}) {
  const refresh = 'refresh' in opts ? opts.refresh : REFRESH_TOKEN;
  vi.stubGlobal('fetch', async (url: string | URL) => {
    const u = typeof url === 'string' ? url : url.toString();
    if (u.includes('oauth2.googleapis.com/token')) {
      const body: Record<string, string> = { access_token: ACCESS_TOKEN };
      if (refresh) body['refresh_token'] = refresh;
      return new Response(JSON.stringify(body), { status: 200 });
    }
    if (u.includes('listAccessibleCustomers')) {
      return new Response(JSON.stringify({ resourceNames: ['customers/1234567890'] }), { status: 200 });
    }
    throw new Error(`[google test] unexpected fetch: ${u}`);
  });
}

describe('HandleGoogleAdsOAuthCallbackCommand', () => {
  beforeEach(() => {
    process.env['NODE_ENV'] = 'development';
    process.env['GOOGLE_ADS_CLIENT_ID'] = 'test-google-client-id';
    process.env['GOOGLE_ADS_CLIENT_SECRET'] = 'test-google-client-secret';
    process.env['GOOGLE_ADS_DEVELOPER_TOKEN'] = 'test-dev-token';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env['GOOGLE_ADS_DEVELOPER_TOKEN'];
  });

  it('derives brandId from the server-stored state record, IGNORING a forged brand_id query param', async () => {
    const stateStore = new InProcessOAuthStateStore();
    const secretsMgr = new LocalSecretsManager();
    const connectorRepo = makeConnectorRepo(REAL_BRAND_ID);
    const syncStatusRepo = makeSyncStatusRepo();
    const emitEvent = vi.fn().mockResolvedValue(undefined);
    stubGoogleFetch();

    const cmd = new HandleGoogleAdsOAuthCallbackCommand(
      secretsMgr,
      stateStore,
      connectorRepo,
      syncStatusRepo,
      emitEvent,
    );

    const stateNonce = 'google-state-1';
    await stateStore.set(REAL_BRAND_ID, stateNonce, 900);
    const result = await cmd.execute({
      query: { code: 'auth_code_g', state: stateNonce, brand_id: ATTACKER_BRAND_ID },
      idempotencyKey: 'idem-g-1',
    });

    const saved = (connectorRepo.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ConnectorInstance;
    expect(saved.brandId).toBe(REAL_BRAND_ID);
    expect(saved.brandId).not.toBe(ATTACKER_BRAND_ID);
    expect(saved.provider).toBe('google_ads');
    expect(result.brandId).toBe(REAL_BRAND_ID);
  });

  it('stores the refresh_token in a Secrets Manager bundle (ARN only) — token never in result/event/row', async () => {
    const stateStore = new InProcessOAuthStateStore();
    const secretsMgr = new LocalSecretsManager();
    const storeSpy = vi.spyOn(secretsMgr, 'storeSecret');
    const connectorRepo = makeConnectorRepo(REAL_BRAND_ID);
    const syncStatusRepo = makeSyncStatusRepo();
    const emitEvent = vi.fn().mockResolvedValue(undefined);
    stubGoogleFetch();

    const cmd = new HandleGoogleAdsOAuthCallbackCommand(
      secretsMgr,
      stateStore,
      connectorRepo,
      syncStatusRepo,
      emitEvent,
    );

    const stateNonce = 'google-state-2';
    await stateStore.set(REAL_BRAND_ID, stateNonce, 900);
    const result = await cmd.execute({
      query: { code: 'auth_code_g', state: stateNonce },
      idempotencyKey: 'idem-g-2',
    });

    // The bundle written to Secrets Manager carries refresh_token + ad_account_id.
    expect(storeSpy).toHaveBeenCalledWith(
      REAL_BRAND_ID,
      expect.objectContaining({ connectorType: 'google_ads' }),
      expect.objectContaining({ refresh_token: REFRESH_TOKEN, ad_account_id: '1234567890' }),
    );
    // The token must NOT appear in the result or the emitted event.
    expect(JSON.stringify(result)).not.toContain(REFRESH_TOKEN);
    expect(JSON.stringify(result)).not.toContain(ACCESS_TOKEN);
    const emittedPayload = (emitEvent as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(JSON.stringify(emittedPayload)).not.toContain(REFRESH_TOKEN);
    // The persisted secret_ref is an ARN, not the token.
    const saved = (connectorRepo.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ConnectorInstance;
    expect(saved.secretRef).toMatch(/^arn:aws:/);
    expect(saved.secretRef).not.toContain(REFRESH_TOKEN);
    expect(result.adAccountId).toBe('1234567890');
  });

  it('throws GoogleAdsOAuthError when offline access is not granted (no refresh_token)', async () => {
    const stateStore = new InProcessOAuthStateStore();
    const secretsMgr = new LocalSecretsManager();
    const connectorRepo = makeConnectorRepo(REAL_BRAND_ID);
    const syncStatusRepo = makeSyncStatusRepo();
    const emitEvent = vi.fn().mockResolvedValue(undefined);
    stubGoogleFetch({ refresh: undefined }); // token endpoint returns no refresh_token

    const cmd = new HandleGoogleAdsOAuthCallbackCommand(
      secretsMgr,
      stateStore,
      connectorRepo,
      syncStatusRepo,
      emitEvent,
    );

    const stateNonce = 'google-state-no-refresh';
    await stateStore.set(REAL_BRAND_ID, stateNonce, 900);
    await expect(
      cmd.execute({ query: { code: 'c', state: stateNonce }, idempotencyKey: 'idem-g-3' }),
    ).rejects.toThrow(GoogleAdsOAuthError);
    expect(connectorRepo.save).not.toHaveBeenCalled();
  });

  it('throws GoogleAdsStateNonceError for an unknown state (no connector created)', async () => {
    const stateStore = new InProcessOAuthStateStore();
    const secretsMgr = new LocalSecretsManager();
    const connectorRepo = makeConnectorRepo(REAL_BRAND_ID);
    const syncStatusRepo = makeSyncStatusRepo();
    const emitEvent = vi.fn().mockResolvedValue(undefined);
    stubGoogleFetch();

    const cmd = new HandleGoogleAdsOAuthCallbackCommand(
      secretsMgr,
      stateStore,
      connectorRepo,
      syncStatusRepo,
      emitEvent,
    );

    await expect(
      cmd.execute({ query: { code: 'x', state: 'nope' }, idempotencyKey: 'idem-g-4' }),
    ).rejects.toThrow(GoogleAdsStateNonceError);
    expect(connectorRepo.save).not.toHaveBeenCalled();
  });

  it('MCC: expands a manager login to its LEAF clients + captures per-account login_customer_id', async () => {
    const MANAGER_CID = '7000000000';
    const LEAF_A = '8000000001';
    const LEAF_B = '8000000002';
    // listAccessibleCustomers returns the MANAGER; customer_client expands to two leaves under it.
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN }), { status: 200 });
      }
      if (u.includes('listAccessibleCustomers')) {
        return new Response(JSON.stringify({ resourceNames: [`customers/${MANAGER_CID}`] }), { status: 200 });
      }
      if (u.includes('googleAds:searchStream')) {
        // login-customer-id header MUST be the manager CID we query through.
        expect((init?.headers as Record<string, string>)['login-customer-id']).toBe(MANAGER_CID);
        return new Response(
          JSON.stringify([
            {
              results: [
                { customerClient: { id: MANAGER_CID, manager: true, level: '0', status: 'ENABLED' } },
                { customerClient: { id: LEAF_A, manager: false, level: '1', status: 'ENABLED' } },
                { customerClient: { id: LEAF_B, manager: false, level: '1', status: 'ENABLED' } },
              ],
            },
          ]),
          { status: 200 },
        );
      }
      throw new Error(`[google test] unexpected fetch: ${u}`);
    });

    const stateStore = new InProcessOAuthStateStore();
    const secretsMgr = new LocalSecretsManager();
    const storeSpy = vi.spyOn(secretsMgr, 'storeSecret');
    const connectorRepo = makeConnectorRepo(REAL_BRAND_ID);
    const syncStatusRepo = makeSyncStatusRepo();
    const emitEvent = vi.fn().mockResolvedValue(undefined);

    const cmd = new HandleGoogleAdsOAuthCallbackCommand(
      secretsMgr,
      stateStore,
      connectorRepo,
      syncStatusRepo,
      emitEvent,
    );

    const stateNonce = 'google-state-mcc';
    await stateStore.set(REAL_BRAND_ID, stateNonce, 900);
    const result = await cmd.execute({
      query: { code: 'auth_code_g', state: stateNonce },
      idempotencyKey: 'idem-mcc',
    });

    // Two LEAF accounts offered (NOT the manager) — manager carries no spend.
    expect(result.adAccountIds.sort()).toEqual([LEAF_A, LEAF_B]);
    expect(result.adAccountIds).not.toContain(MANAGER_CID);

    // Each leaf bundle carries its required manager login_customer_id (per-account, not a global env).
    expect(storeSpy).toHaveBeenCalledWith(
      REAL_BRAND_ID,
      expect.objectContaining({ connectorType: 'google_ads', subKey: LEAF_A }),
      expect.objectContaining({ refresh_token: REFRESH_TOKEN, ad_account_id: LEAF_A, login_customer_id: MANAGER_CID }),
    );

    // Multiple accounts → NONE auto-activated (0106: user must pick one); login CID on providerConfig.
    const savedInstances = (connectorRepo.save as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as ConnectorInstance,
    );
    expect(savedInstances).toHaveLength(2);
    for (const inst of savedInstances) {
      expect(inst.activatedAt).toBeNull();
      expect(inst.providerConfig['google_ads_login_customer_id']).toBe(MANAGER_CID);
    }
  });

  it('state nonce is single-use (NN-4)', async () => {
    const stateStore = new InProcessOAuthStateStore();
    const secretsMgr = new LocalSecretsManager();
    const connectorRepo = makeConnectorRepo(REAL_BRAND_ID);
    const syncStatusRepo = makeSyncStatusRepo();
    const emitEvent = vi.fn().mockResolvedValue(undefined);
    stubGoogleFetch();

    const cmd = new HandleGoogleAdsOAuthCallbackCommand(
      secretsMgr,
      stateStore,
      connectorRepo,
      syncStatusRepo,
      emitEvent,
    );

    const stateNonce = 'google-state-single';
    await stateStore.set(REAL_BRAND_ID, stateNonce, 900);
    await cmd.execute({ query: { code: 'c', state: stateNonce }, idempotencyKey: 'idem-ga' });
    await expect(
      cmd.execute({ query: { code: 'c', state: stateNonce }, idempotencyKey: 'idem-gb' }),
    ).rejects.toThrow(GoogleAdsStateNonceError);
  });
});
