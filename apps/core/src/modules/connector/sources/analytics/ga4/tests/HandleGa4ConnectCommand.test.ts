/**
 * HandleGa4ConnectCommand unit tests — the GENERIC per-brand GA4 connect path.
 *
 * Proves:
 *   1. Happy path: SA JWT-bearer token mint → cheap runReport validation → SA bundle stored →
 *      instance saved (NN-2: secret_ref = ARN; accountKey = property id) → ad_account_id mirror →
 *      sync status + event.
 *   2. Non-numeric property id → Ga4InvalidPropertyIdError BEFORE any network call.
 *   3. Malformed service-account JSON → Ga4ServiceAccountKeyInvalidError BEFORE any network call.
 *   4. Google rejects the assertion (token endpoint 400) → Ga4CredentialsInvalidError, nothing persisted.
 *   5. runReport 403 (SA email lacks Viewer on the property) → Ga4CredentialsInvalidError, nothing persisted.
 *   6. The stored bundle matches EXACTLY the shape resolveGa4Credentials (ga4-repull) reads
 *      (auth_method/client_email/private_key/property_id/currency_code) and the event payload
 *      never carries the key (I-S09).
 *   7. Optional currency_code: uppercased into the bundle + provider_config; omitted when blank.
 */
import { describe, it, expect, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import {
  HandleGa4ConnectCommand,
  Ga4InvalidPropertyIdError,
  Ga4ServiceAccountKeyInvalidError,
  Ga4CredentialsInvalidError,
} from '../application/commands/HandleGa4ConnectCommand.js';
import { LocalSecretsManager } from '@brain/connector-secrets';
import type {
  IConnectorInstanceRepository,
  IConnectorSyncStatusRepository,
  ConnectorInstance,
} from '@brain/connector-core';
import { ConnectorSyncStatus } from '@brain/connector-core';

const BRAND_ID = '550e8400-e29b-41d4-a716-446655440000';
const PROPERTY_ID = '123456789';
const CLIENT_EMAIL = 'brain-ga4@test-project.iam.gserviceaccount.com';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const SA_JSON = JSON.stringify({
  type: 'service_account',
  client_email: CLIENT_EMAIL,
  private_key: PRIVATE_PEM,
});

function makeConnectorRepo(): IConnectorInstanceRepository {
  return {
    findByBrandAndProvider: vi.fn().mockResolvedValue(null),
    findById: vi.fn().mockResolvedValue(null),
    findAllByBrand: vi.fn().mockResolvedValue([]),
    findAllByBrandAndProvider: vi.fn().mockResolvedValue([]),
    activateAccount: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockImplementation(async (inst: ConnectorInstance) => inst),
    update: vi.fn().mockImplementation(async (inst: ConnectorInstance) => inst),
  } as unknown as IConnectorInstanceRepository;
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
  } as unknown as IConnectorSyncStatusRepository;
}

/** fetch stub: SA token mint + runReport validation, both configurable. */
function makeFetch(opts?: { tokenStatus?: number; reportStatus?: number }): typeof fetch {
  const tokenStatus = opts?.tokenStatus ?? 200;
  const reportStatus = opts?.reportStatus ?? 200;
  return vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.includes('oauth2.googleapis.com/token')) {
      return {
        ok: tokenStatus >= 200 && tokenStatus < 300,
        status: tokenStatus,
        json: async () => ({ access_token: 'ya29.connect-probe', expires_in: 3599 }),
      } as Response;
    }
    if (u.includes(':runReport')) {
      expect(u).toContain(`/properties/${PROPERTY_ID}:runReport`);
      return {
        ok: reportStatus >= 200 && reportStatus < 300,
        status: reportStatus,
        json: async () => ({ rowCount: 0 }),
      } as Response;
    }
    throw new Error(`unexpected fetch: ${u}`);
  }) as unknown as typeof fetch;
}

function makeCommand(overrides?: {
  fetchImpl?: typeof fetch;
  setAdAccountId?: ReturnType<typeof vi.fn>;
}) {
  const secretsManager = new LocalSecretsManager();
  const connectorRepo = makeConnectorRepo();
  const syncStatusRepo = makeSyncStatusRepo();
  const emitEvent = vi.fn().mockResolvedValue(undefined);
  const setAdAccountId = overrides?.setAdAccountId ?? vi.fn().mockResolvedValue(undefined);
  const fetchImpl = overrides?.fetchImpl ?? makeFetch();
  const cmd = new HandleGa4ConnectCommand(
    secretsManager,
    connectorRepo,
    syncStatusRepo,
    emitEvent,
    setAdAccountId,
    fetchImpl,
    () => new Date('2026-07-12T00:00:00Z'),
  );
  return { cmd, secretsManager, connectorRepo, syncStatusRepo, emitEvent, setAdAccountId, fetchImpl };
}

describe('HandleGa4ConnectCommand', () => {
  it('happy path: validates via runReport, stores the SA bundle, saves instance, mirrors ad_account_id, emits event', async () => {
    const { cmd, secretsManager, connectorRepo, syncStatusRepo, emitEvent, setAdAccountId } = makeCommand();

    const result = await cmd.execute({
      brandId: BRAND_ID,
      propertyId: ` ${PROPERTY_ID} `, // whitespace tolerated
      serviceAccountJson: SA_JSON,
      currencyCode: 'inr',
      idempotencyKey: 'idem-ga4-1',
    });

    expect(result.status).toBe('connected');
    expect(result.propertyId).toBe(PROPERTY_ID);

    // Instance saved with an ARN secret_ref (NN-2), accountKey = property id.
    const saved = (connectorRepo.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ConnectorInstance;
    expect(saved.secretRef).toMatch(/^arn:aws:secretsmanager:/);
    expect(saved.provider).toBe('ga4');
    expect(saved.accountKey).toBe(PROPERTY_ID);
    expect(saved.providerConfig).toMatchObject({
      ga4_property_id: PROPERTY_ID,
      auth_method: 'service_account',
      currency_code: 'INR', // uppercased
    });

    // The bundle carries EXACTLY the shape resolveGa4Credentials (ga4-repull/run.ts) reads.
    const bundle = await secretsManager.getSecret(saved.secretRef);
    expect(bundle).toMatchObject({
      auth_method: 'service_account',
      client_email: CLIENT_EMAIL,
      private_key: PRIVATE_PEM,
      property_id: PROPERTY_ID,
      currency_code: 'INR',
    });

    // ad_account_id mirror (generic repull contract: for ga4 the column stores the property id).
    expect(setAdAccountId).toHaveBeenCalledWith(BRAND_ID, result.connectorInstanceId, PROPERTY_ID);

    expect(syncStatusRepo.save).toHaveBeenCalledOnce();
    expect(emitEvent).toHaveBeenCalledWith(
      'connector.connected',
      expect.objectContaining({
        brand_id: BRAND_ID,
        provider: 'ga4',
        property_id: PROPERTY_ID,
        auth_method: 'service_account',
      }),
    );
    // I-S09: the event payload never carries the key or the token.
    const eventPayload = (emitEvent as ReturnType<typeof vi.fn>).mock.calls[0]![1] as Record<string, unknown>;
    expect(JSON.stringify(eventPayload)).not.toContain('PRIVATE KEY');
    expect(JSON.stringify(eventPayload)).not.toContain('ya29.');
  });

  it('blank currency_code → omitted from bundle + provider_config (USD applied downstream)', async () => {
    const { cmd, secretsManager, connectorRepo } = makeCommand();
    await cmd.execute({
      brandId: BRAND_ID,
      propertyId: PROPERTY_ID,
      serviceAccountJson: SA_JSON,
      idempotencyKey: 'idem-ga4-2',
    });
    const saved = (connectorRepo.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ConnectorInstance;
    expect(saved.providerConfig).not.toHaveProperty('currency_code');
    const bundle = await secretsManager.getSecret(saved.secretRef);
    expect(bundle).not.toHaveProperty('currency_code');
  });

  it('non-numeric property id (a "G-…" measurement id) → Ga4InvalidPropertyIdError, NO network call', async () => {
    const fetchImpl = makeFetch();
    const { cmd } = makeCommand({ fetchImpl });

    await expect(
      cmd.execute({
        brandId: BRAND_ID,
        propertyId: 'G-ABC123DEF',
        serviceAccountJson: SA_JSON,
        idempotencyKey: 'idem-ga4-3',
      }),
    ).rejects.toThrow(Ga4InvalidPropertyIdError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('malformed service-account JSON → Ga4ServiceAccountKeyInvalidError, NO network call', async () => {
    const fetchImpl = makeFetch();
    const { cmd } = makeCommand({ fetchImpl });

    await expect(
      cmd.execute({
        brandId: BRAND_ID,
        propertyId: PROPERTY_ID,
        serviceAccountJson: '{"type":"authorized_user"}',
        idempotencyKey: 'idem-ga4-4',
      }),
    ).rejects.toThrow(Ga4ServiceAccountKeyInvalidError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('Google rejects the JWT assertion (token endpoint 400) → Ga4CredentialsInvalidError, nothing persisted', async () => {
    const { cmd, connectorRepo, emitEvent } = makeCommand({ fetchImpl: makeFetch({ tokenStatus: 400 }) });

    await expect(
      cmd.execute({
        brandId: BRAND_ID,
        propertyId: PROPERTY_ID,
        serviceAccountJson: SA_JSON,
        idempotencyKey: 'idem-ga4-5',
      }),
    ).rejects.toThrow(Ga4CredentialsInvalidError);
    expect(connectorRepo.save).not.toHaveBeenCalled();
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it('runReport 403 (no Viewer grant on the property) → Ga4CredentialsInvalidError, nothing persisted', async () => {
    const { cmd, connectorRepo, syncStatusRepo } = makeCommand({ fetchImpl: makeFetch({ reportStatus: 403 }) });

    await expect(
      cmd.execute({
        brandId: BRAND_ID,
        propertyId: PROPERTY_ID,
        serviceAccountJson: SA_JSON,
        idempotencyKey: 'idem-ga4-6',
      }),
    ).rejects.toThrow(Ga4CredentialsInvalidError);
    expect(connectorRepo.save).not.toHaveBeenCalled();
    expect(syncStatusRepo.save).not.toHaveBeenCalled();
  });

  it('runReport 5xx → plain error (retryable), NOT Ga4CredentialsInvalidError; nothing persisted', async () => {
    const { cmd, connectorRepo } = makeCommand({ fetchImpl: makeFetch({ reportStatus: 503 }) });

    const p = cmd.execute({
      brandId: BRAND_ID,
      propertyId: PROPERTY_ID,
      serviceAccountJson: SA_JSON,
      idempotencyKey: 'idem-ga4-7',
    });
    await expect(p).rejects.toThrow('validation runReport failed');
    await expect(p).rejects.not.toThrow(Ga4CredentialsInvalidError);
    expect(connectorRepo.save).not.toHaveBeenCalled();
  });
});
