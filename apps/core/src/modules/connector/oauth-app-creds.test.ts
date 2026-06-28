/**
 * oauth-app-creds.test.ts — per-brand BYO-app OAuth credential resolution.
 *
 * Proves the resolution order (brand-stored Secrets Manager → env fallback → null/undefined) and
 * that storing writes the <provider>_app secret bundle. No AWS — a mock ISecretsManager.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resetAllConfigCaches } from '@brain/config';
import type { ISecretsManager } from '@brain/connector-secrets';
import {
  storeBrandOAuthAppCreds,
  resolveBrandOAuthAppCreds,
  resolveBrandOAuthClientId,
} from './oauth-app-creds.js';

const BRAND = '11111111-1111-4111-8111-111111111111';

function mockSecrets(bundle: Record<string, string> | null): ISecretsManager {
  return {
    getSecret: vi.fn(async () => bundle),
    storeSecret: vi.fn(async () => ({ arn: 'arn:test', name: 'n' })),
    putSecretValue: vi.fn(),
    deleteSecret: vi.fn(),
    storeShopifyToken: vi.fn(),
    getShopifyClientSecret: vi.fn(),
    deleteShopifyToken: vi.fn(),
    getShopifyToken: vi.fn(),
  } as unknown as ISecretsManager;
}

describe('resolveBrandOAuthAppCreds', () => {
  it('returns the brand-stored creds when present (ignores env)', async () => {
    const sm = mockSecrets({ client_id: 'brand-id', client_secret: 'brand-secret' });
    const r = await resolveBrandOAuthAppCreds(sm, 'shopify', BRAND, { clientId: 'env-id', clientSecret: 'env-secret' });
    expect(r).toEqual({ clientId: 'brand-id', clientSecret: 'brand-secret' });
  });

  it('falls back to env when the brand has no stored creds', async () => {
    const sm = mockSecrets(null);
    const r = await resolveBrandOAuthAppCreds(sm, 'meta', BRAND, { clientId: 'env-id', clientSecret: 'env-secret' });
    expect(r).toEqual({ clientId: 'env-id', clientSecret: 'env-secret' });
  });

  it('returns null when neither brand nor env creds exist', async () => {
    const sm = mockSecrets(null);
    const r = await resolveBrandOAuthAppCreds(sm, 'google_ads', BRAND, null);
    expect(r).toBeNull();
  });

  it('falls back to env if the secret store throws', async () => {
    const sm = mockSecrets(null);
    (sm.getSecret as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('kms down'));
    const r = await resolveBrandOAuthAppCreds(sm, 'shopify', BRAND, { clientId: 'env-id', clientSecret: 'env-secret' });
    expect(r).toEqual({ clientId: 'env-id', clientSecret: 'env-secret' });
  });

  it('ignores a partial brand bundle (missing secret) and falls back to env', async () => {
    const sm = mockSecrets({ client_id: 'brand-id' });
    const r = await resolveBrandOAuthAppCreds(sm, 'meta', BRAND, { clientId: 'env-id', clientSecret: 'env-secret' });
    expect(r).toEqual({ clientId: 'env-id', clientSecret: 'env-secret' });
  });
});

describe('resolveBrandOAuthClientId', () => {
  beforeEach(() => {
    // envClientId() → loadCoreConfig(), which memoizes+freezes the parsed env on first call. Reset so
    // each case re-parses the env we set below instead of an earlier suite's frozen snapshot (the
    // staleness that left this case reading config without META_APP_ID). CoreEnvSchema requires
    // DATABASE_URL — provide a deterministic value so the parse succeeds in the unit context (no DB is
    // opened here; only envClientId is exercised). `??=` never clobbers a real ambient value.
    process.env['DATABASE_URL'] ??= 'postgres://brain:brain@localhost:5432/brain';
    resetAllConfigCaches();
  });

  it('prefers the brand-stored client_id', async () => {
    const sm = mockSecrets({ client_id: 'brand-id', client_secret: 's' });
    expect(await resolveBrandOAuthClientId(sm, 'shopify', BRAND)).toBe('brand-id');
  });

  it('falls back to the env client_id', async () => {
    const prev = process.env['META_APP_ID'];
    process.env['META_APP_ID'] = 'env-meta-id';
    try {
      const sm = mockSecrets(null);
      expect(await resolveBrandOAuthClientId(sm, 'meta', BRAND)).toBe('env-meta-id');
    } finally {
      if (prev === undefined) delete process.env['META_APP_ID'];
      else process.env['META_APP_ID'] = prev;
    }
  });
});

describe('storeBrandOAuthAppCreds', () => {
  it('writes the <provider>_app secret bundle (client_id + client_secret)', async () => {
    const sm = mockSecrets(null);
    await storeBrandOAuthAppCreds(sm, 'shopify', BRAND, { clientId: 'cid', clientSecret: 'csec' });
    expect(sm.storeSecret).toHaveBeenCalledWith(
      BRAND,
      { connectorType: 'shopify_app' },
      { client_id: 'cid', client_secret: 'csec' },
    );
  });
});
