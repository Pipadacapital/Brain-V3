/**
 * ConnectMetaWithSystemUserTokenCommand unit tests (Meta system-user token connect path).
 *
 * Acceptance items proven:
 *   1. /me IS the token validation — a rejected token throws MetaSystemUserTokenInvalidError
 *      and creates NOTHING (no secret, no instance, no event).
 *   2. An explicit ad_account_id is VERIFIED with the token (fetch of that account); an
 *      unreachable account throws MetaAdAccountAccessError (token valid ≠ account assigned).
 *   3. No ad_account_id → the SAME /me/adaccounts enumeration as the OAuth callback (Gap B):
 *      one instance per account, auto-activate ONLY when exactly one (0106).
 *   4. The bundle is stamped token_type='system_user' (meta-token-refresh skip flag) and the
 *      token NEVER appears in the result / event / connector row (NN-2 / I-S09).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ConnectMetaWithSystemUserTokenCommand,
  MetaSystemUserTokenInvalidError,
  MetaAdAccountAccessError,
  META_SYSTEM_USER_TOKEN_TYPE,
} from '../application/commands/ConnectMetaWithSystemUserTokenCommand.js';
import { LocalSecretsManager } from '@brain/connector-secrets';
import type { IConnectorInstanceRepository } from '@brain/connector-core';
import type { IConnectorSyncStatusRepository } from '@brain/connector-core';
import { ConnectorInstance } from '@brain/connector-core';
import { ConnectorSyncStatus } from '@brain/connector-core';

const BRAND_ID = '550e8400-e29b-41d4-a716-446655440000';
const TOKEN_VALUE = 'EAABsystem_user_never_expiring_token';

function makeConnectorRepo(brandId: string): IConnectorInstanceRepository {
  const base = ConnectorInstance.create({
    id: '11111111-0000-0000-0000-000000000001',
    brandId,
    provider: 'meta',
    shopDomain: '',
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
    activateAccount: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockResolvedValue(base),
    update: vi.fn().mockResolvedValue(base),
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

/**
 * Stub Graph API for the system-user path: /me validates the token; /me/adaccounts enumerates;
 * /act_<id> is the single-account verification fetch.
 */
function stubGraph(opts: {
  meOk?: boolean;
  accounts?: Array<{ id: string; account_id?: string; name?: string }>;
  actOk?: boolean;
} = {}) {
  const { meOk = true, accounts = [{ id: 'act_123456', account_id: '123456', name: 'Acme Meta' }], actOk = true } = opts;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString();
    calls.push({ url: u, init });
    if (u.includes('/me/adaccounts')) {
      return new Response(JSON.stringify({ data: accounts }), { status: 200 });
    }
    if (u.includes('/me?')) {
      return meOk
        ? new Response(JSON.stringify({ id: '9000001' }), { status: 200 })
        : new Response(JSON.stringify({ error: { code: 190 } }), { status: 401 });
    }
    if (/\/act_\d+\?/.test(u)) {
      return actOk
        ? new Response(JSON.stringify({ id: u.match(/(act_\d+)\?/)![1], name: 'Verified Account' }), { status: 200 })
        : new Response('forbidden', { status: 403 });
    }
    throw new Error(`[meta sut test] unexpected fetch: ${u}`);
  });
  return calls;
}

function makeCmd(overrides: {
  connectorRepo?: IConnectorInstanceRepository;
  secretsMgr?: LocalSecretsManager;
  emitEvent?: ReturnType<typeof vi.fn>;
  setAdAccountId?: ReturnType<typeof vi.fn>;
} = {}) {
  const secretsMgr = overrides.secretsMgr ?? new LocalSecretsManager();
  const connectorRepo = overrides.connectorRepo ?? makeConnectorRepo(BRAND_ID);
  const syncStatusRepo = makeSyncStatusRepo();
  const emitEvent = overrides.emitEvent ?? vi.fn().mockResolvedValue(undefined);
  const cmd = new ConnectMetaWithSystemUserTokenCommand(
    secretsMgr,
    connectorRepo,
    syncStatusRepo,
    emitEvent,
    overrides.setAdAccountId,
  );
  return { cmd, secretsMgr, connectorRepo, syncStatusRepo, emitEvent };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ConnectMetaWithSystemUserTokenCommand', () => {
  it('rejects a token Meta refuses on /me — nothing created (fail-closed)', async () => {
    stubGraph({ meOk: false });
    const { cmd, connectorRepo, emitEvent, secretsMgr } = makeCmd();
    const storeSpy = vi.spyOn(secretsMgr, 'storeSecret');

    await expect(
      cmd.execute({ brandId: BRAND_ID, accessToken: TOKEN_VALUE, idempotencyKey: 'idem-1' }),
    ).rejects.toThrow(MetaSystemUserTokenInvalidError);
    expect(storeSpy).not.toHaveBeenCalled();
    expect(connectorRepo.save).not.toHaveBeenCalled();
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it('verifies an EXPLICIT ad_account_id with the token; unreachable → MetaAdAccountAccessError', async () => {
    stubGraph({ actOk: false });
    const { cmd, connectorRepo } = makeCmd();
    await expect(
      cmd.execute({ brandId: BRAND_ID, accessToken: TOKEN_VALUE, adAccountId: 'act_777', idempotencyKey: 'idem-2' }),
    ).rejects.toThrow(MetaAdAccountAccessError);
    expect(connectorRepo.save).not.toHaveBeenCalled();
  });

  it('connects the explicit account (bare digits normalized to act_) — single instance, auto-activated', async () => {
    const calls = stubGraph();
    const { cmd, connectorRepo } = makeCmd();

    const result = await cmd.execute({
      brandId: BRAND_ID,
      accessToken: TOKEN_VALUE,
      adAccountId: '777123',
      idempotencyKey: 'idem-3',
    });

    // /me/adaccounts enumeration NOT used when the account was named explicitly.
    expect(calls.some((c) => c.url.includes('/me/adaccounts'))).toBe(false);
    expect(result.adAccountId).toBe('act_777123');
    const saveMock = connectorRepo.save as ReturnType<typeof vi.fn>;
    expect(saveMock).toHaveBeenCalledOnce();
    const saved = saveMock.mock.calls[0]![0] as ConnectorInstance;
    expect(saved.accountKey).toBe('act_777123');
    expect(saved.activatedAt).not.toBeNull(); // exactly one account → auto-activate (0106)
    expect(saved.providerConfig).toMatchObject({ auth_method: 'system_user_token', ad_account_id: 'act_777123' });
  });

  it('no ad_account_id → enumerates /me/adaccounts (Gap B): one instance per account, NONE auto-activated for >1', async () => {
    stubGraph({
      accounts: [
        { id: 'act_111', account_id: '111', name: 'Acme Prospecting' },
        { id: 'act_222', account_id: '222', name: 'Acme Retargeting' },
      ],
    });
    const { cmd, connectorRepo } = makeCmd();

    const result = await cmd.execute({ brandId: BRAND_ID, accessToken: TOKEN_VALUE, idempotencyKey: 'idem-4' });

    expect(result.adAccountIds).toEqual(['act_111', 'act_222']);
    const saved = (connectorRepo.save as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as ConnectorInstance);
    expect(saved).toHaveLength(2);
    for (const inst of saved) {
      expect(inst.activatedAt).toBeNull(); // 0106: user must pick one
    }
    const byKey = new Map(saved.map((s) => [s.accountKey, s.providerConfig as Record<string, unknown>]));
    expect(byKey.get('act_111')).toMatchObject({ ad_account_name: 'Acme Prospecting' });
  });

  it("stamps the bundle token_type='system_user' (refresh-skip flag) and NEVER leaks the token (NN-2 / I-S09)", async () => {
    stubGraph();
    const secretsMgr = new LocalSecretsManager();
    const storeSpy = vi.spyOn(secretsMgr, 'storeSecret');
    const emitEvent = vi.fn().mockResolvedValue(undefined);
    const { cmd, connectorRepo } = makeCmd({ secretsMgr, emitEvent });

    const result = await cmd.execute({ brandId: BRAND_ID, accessToken: TOKEN_VALUE, idempotencyKey: 'idem-5' });

    expect(storeSpy).toHaveBeenCalledWith(
      BRAND_ID,
      expect.objectContaining({ connectorType: 'meta', subKey: 'act_123456' }),
      expect.objectContaining({ access_token: TOKEN_VALUE, token_type: META_SYSTEM_USER_TOKEN_TYPE }),
    );
    // Token never in the result / event / row.
    expect(JSON.stringify(result)).not.toContain(TOKEN_VALUE);
    const emittedPayload = (emitEvent as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(JSON.stringify(emittedPayload)).not.toContain(TOKEN_VALUE);
    expect(emittedPayload).toMatchObject({ provider: 'meta', auth_method: 'system_user_token' });
    const saved = (connectorRepo.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ConnectorInstance;
    expect(saved.secretRef).toMatch(/^arn:aws:/);
    expect(saved.secretRef).not.toContain(TOKEN_VALUE);
  });

  it('the token rides the Authorization header on EVERY Graph call — never a URL query (SEC-AD-M1)', async () => {
    const calls = stubGraph();
    const { cmd } = makeCmd();
    await cmd.execute({ brandId: BRAND_ID, accessToken: TOKEN_VALUE, idempotencyKey: 'idem-6' });

    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.url).not.toContain(TOKEN_VALUE);
      expect(c.url).not.toContain('access_token=');
      const authHeader = (c.init?.headers as Record<string, string> | undefined)?.['Authorization'];
      expect(authHeader).toBe(`Bearer ${TOKEN_VALUE}`);
    }
  });

  it('honest fallback: token valid but zero accounts resolvable → single __default__ instance', async () => {
    stubGraph({ accounts: [] });
    const setAdAccountId = vi.fn().mockResolvedValue(undefined);
    const { cmd, connectorRepo } = makeCmd({ setAdAccountId });

    const result = await cmd.execute({ brandId: BRAND_ID, accessToken: TOKEN_VALUE, idempotencyKey: 'idem-7' });

    expect(result.adAccountId).toBeNull();
    expect(result.status).toBe('connected');
    const saved = (connectorRepo.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ConnectorInstance;
    expect(saved.accountKey).toBe('__default__');
    expect(setAdAccountId).not.toHaveBeenCalled();
  });
});
