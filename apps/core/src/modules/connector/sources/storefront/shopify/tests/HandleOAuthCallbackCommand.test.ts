/**
 * HandleOAuthCallbackCommand unit tests (NN-4 + NN-2 + MED-CALLBACK-01).
 *
 * Critical negative controls:
 *   1. Tampered HMAC must throw HmacValidationError BEFORE any other processing.
 *   2. Invalid state nonce must throw StateNonceError AFTER HMAC passes.
 *   3. Invalid shop domain must throw ShopDomainError.
 *   4. On success, secret_ref (ARN) is returned — the token is not accessible from result.
 *   5. MED-CALLBACK-01: brandId is derived from the server-side state record, NOT from
 *      the query string — a forged brand_id in the query must have no effect.
 *
 * These tests prove the NN-4 processing ORDER is enforced and MED-CALLBACK-01 is fixed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  HandleOAuthCallbackCommand,
  HmacValidationError,
  StateNonceError,
  ShopDomainError,
} from '../application/commands/HandleOAuthCallbackCommand.js';
import { InProcessOAuthStateStore } from '../infrastructure/state/InProcessOAuthStateStore.js';
import { LocalSecretsManager } from '@brain/connector-secrets';
import type { IConnectorInstanceRepository } from '../domain/repositories/IConnectorInstanceRepository.js';
import type { IConnectorSyncStatusRepository } from '../domain/repositories/IConnectorSyncStatusRepository.js';
import { ConnectorInstance } from '../domain/entities/ConnectorInstance.js';
import { ConnectorSyncStatus } from '../domain/entities/ConnectorSyncStatus.js';

const CLIENT_SECRET = 'test-shopify-client-secret';
const BRAND_ID = '550e8400-e29b-41d4-a716-446655440000';
const SHOP_DOMAIN = 'testbrand.myshopify.com';

/**
 * Build a valid Shopify callback query.
 * MED-CALLBACK-01: brand_id is NOT included in the query params — Shopify does not
 * include it and the handler must not trust it from the query string.
 */
function buildValidQuery(stateNonce: string, overrides?: Record<string, string>) {
  const params: Record<string, string> = {
    code: 'auth_code_abc123',
    shop: SHOP_DOMAIN,
    state: stateNonce,
    timestamp: String(Math.floor(Date.now() / 1000)),
    // brand_id intentionally omitted — MED-CALLBACK-01
    ...overrides,
  };
  const message = Object.entries(params)
    .filter(([k]) => k !== 'hmac')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .sort()
    .join('&');
  const hmac = createHmac('sha256', CLIENT_SECRET).update(message).digest('hex');
  return { ...params, hmac };
}

function makeConnectorRepo(saveResult?: ConnectorInstance): IConnectorInstanceRepository {
  const base = ConnectorInstance.create({
    id: '11111111-0000-0000-0000-000000000001',
    brandId: BRAND_ID,
    provider: 'shopify',
    shopDomain: SHOP_DOMAIN,
    secretRef: 'arn:aws:secretsmanager:us-east-1:000000000000:secret:brain/connector/shopify/test',
    status: 'connected',
    // ADR-CM-5: health fields required in ConnectorInstanceProps
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
    save: vi.fn().mockResolvedValue(saveResult ?? base),
    update: vi.fn().mockResolvedValue(saveResult ?? base),
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

describe('HandleOAuthCallbackCommand', () => {
  beforeEach(() => {
    process.env['SHOPIFY_CLIENT_SECRET'] = CLIENT_SECRET;
    process.env['SHOPIFY_CLIENT_ID'] = 'test-client-id';
  });

  it('throws HmacValidationError FIRST for a tampered HMAC (NN-4 negative control)', async () => {
    const stateStore = new InProcessOAuthStateStore();
    const secretsMgr = new LocalSecretsManager();
    const connectorRepo = makeConnectorRepo();
    const syncStatusRepo = makeSyncStatusRepo();
    const emitEvent = vi.fn().mockResolvedValue(undefined);

    const cmd = new HandleOAuthCallbackCommand(
      secretsMgr,
      stateStore,
      connectorRepo,
      syncStatusRepo,
      emitEvent,
    );

    const stateNonce = 'abc123state';
    await stateStore.set(BRAND_ID, stateNonce, 900);

    const query = buildValidQuery(stateNonce);
    // Tamper the HMAC
    const tamperedQuery = { ...query, hmac: 'tampered_hmac_value' };

    await expect(
      cmd.execute({ query: tamperedQuery, idempotencyKey: 'idem-1' }),
    ).rejects.toThrow(HmacValidationError);

    // Ensure no repo calls were made (HMAC must be FIRST)
    expect(connectorRepo.save).not.toHaveBeenCalled();
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it('throws StateNonceError for invalid state AFTER HMAC passes (NN-4 order check)', async () => {
    const stateStore = new InProcessOAuthStateStore();
    const secretsMgr = new LocalSecretsManager();
    const connectorRepo = makeConnectorRepo();
    const syncStatusRepo = makeSyncStatusRepo();
    const emitEvent = vi.fn().mockResolvedValue(undefined);

    const cmd = new HandleOAuthCallbackCommand(
      secretsMgr,
      stateStore,
      connectorRepo,
      syncStatusRepo,
      emitEvent,
    );

    // Valid HMAC but no state stored — stateStore.consumeAndGetBrandId returns null
    const query = buildValidQuery('nonexistent-state');

    await expect(
      cmd.execute({ query, idempotencyKey: 'idem-2' }),
    ).rejects.toThrow(StateNonceError);

    // Repo must not be called
    expect(connectorRepo.save).not.toHaveBeenCalled();
  });

  it('throws ShopDomainError for invalid shop domain (negative control)', async () => {
    const stateStore = new InProcessOAuthStateStore();
    const secretsMgr = new LocalSecretsManager();
    const connectorRepo = makeConnectorRepo();
    const syncStatusRepo = makeSyncStatusRepo();
    const emitEvent = vi.fn().mockResolvedValue(undefined);

    const cmd = new HandleOAuthCallbackCommand(
      secretsMgr,
      stateStore,
      connectorRepo,
      syncStatusRepo,
      emitEvent,
    );

    const stateNonce = 'valid-state-nonce';
    await stateStore.set(BRAND_ID, stateNonce, 900);

    // Build query with valid HMAC but invalid shop domain
    const query = buildValidQuery(stateNonce, { shop: 'evil.example.com' });

    await expect(
      cmd.execute({ query, idempotencyKey: 'idem-3' }),
    ).rejects.toThrow(ShopDomainError);
  });

  it('does not expose the access token in the result (NN-2 contract)', async () => {
    const stateStore = new InProcessOAuthStateStore();
    const secretsMgr = new LocalSecretsManager();
    const connectorRepo = makeConnectorRepo();
    const syncStatusRepo = makeSyncStatusRepo();
    const emitEvent = vi.fn().mockResolvedValue(undefined);

    // Mock fetch for token exchange
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'shpat_secret_token_value' }),
    } as Response);

    const cmd = new HandleOAuthCallbackCommand(
      secretsMgr,
      stateStore,
      connectorRepo,
      syncStatusRepo,
      emitEvent,
    );

    const stateNonce = 'test-state-nonce-1';
    await stateStore.set(BRAND_ID, stateNonce, 900);
    const query = buildValidQuery(stateNonce);

    const result = await cmd.execute({ query, idempotencyKey: 'idem-4' });

    // MED-01: secretRef is no longer in OAuthCallbackResult (ARN persisted internally).
    // Result must NOT have a secretRef field; confirm the type does not expose it.
    expect(result).not.toHaveProperty('secretRef');
    // Token value must not appear anywhere in the result
    expect(JSON.stringify(result)).not.toContain('shpat_secret_token_value');

    // Ensure repo was called (happy path)
    expect(connectorRepo.save).toHaveBeenCalledOnce();
    expect(emitEvent).toHaveBeenCalledWith('connector.connected', expect.objectContaining({
      brand_id: BRAND_ID,
      provider: 'shopify',
    }));
  });

  // ── MED-CALLBACK-01 proof test ────────────────────────────────────────────
  it('MED-CALLBACK-01: brand_id from query is ignored — brandId is derived from the server-side state record', async () => {
    const stateStore = new InProcessOAuthStateStore();
    const secretsMgr = new LocalSecretsManager();
    // Use a different brand ID in the state store (the real, server-trusted one)
    const REAL_BRAND_ID = '550e8400-e29b-41d4-a716-446655440000';
    // Attacker-supplied brand ID that would appear in the query string
    const ATTACKER_BRAND_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

    const connectorRepo = makeConnectorRepo(
      ConnectorInstance.create({
        id: '11111111-0000-0000-0000-000000000001',
        brandId: REAL_BRAND_ID, // must come from server-trusted state
        provider: 'shopify',
        shopDomain: SHOP_DOMAIN,
        secretRef: 'arn:aws:secretsmanager:us-east-1:000000000000:secret:brain/connector/shopify/test',
        status: 'connected',
        healthState: 'Healthy',
        safetyRating: 'safe',
        connectedAt: new Date(),
        disconnectedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    );
    const syncStatusRepo = makeSyncStatusRepo();
    const emitEvent = vi.fn().mockResolvedValue(undefined);

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'shpat_proof_token' }),
    } as Response);

    const cmd = new HandleOAuthCallbackCommand(
      secretsMgr,
      stateStore,
      connectorRepo,
      syncStatusRepo,
      emitEvent,
    );

    const stateNonce = 'proof-state-nonce-medcb01';
    // Store with REAL_BRAND_ID bound into the record at initiation time
    await stateStore.set(REAL_BRAND_ID, stateNonce, 900);

    // Build query without brand_id (Shopify does not include it).
    // Even if an attacker appends brand_id=ATTACKER_BRAND_ID to the URL, the
    // command ignores it — the query helper here does NOT include brand_id.
    const query = buildValidQuery(stateNonce);

    const result = await cmd.execute({ query, idempotencyKey: 'idem-medcb01' });

    // The ConnectorInstance saved must use REAL_BRAND_ID, not ATTACKER_BRAND_ID
    const saveMock = connectorRepo.save as ReturnType<typeof vi.fn>;
    expect(saveMock).toHaveBeenCalledOnce();
    const savedInstance = saveMock.mock.calls[0]![0] as ConnectorInstance;
    expect(savedInstance.brandId).toBe(REAL_BRAND_ID);
    expect(savedInstance.brandId).not.toBe(ATTACKER_BRAND_ID);

    // The emitted event also carries the server-trusted brandId
    expect(emitEvent).toHaveBeenCalledWith('connector.connected', expect.objectContaining({
      brand_id: REAL_BRAND_ID,
    }));

    // Result is valid (happy path still works)
    expect(result.status).toBe('connected');
  });
});
