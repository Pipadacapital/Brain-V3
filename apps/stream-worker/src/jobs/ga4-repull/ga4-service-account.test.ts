/**
 * ga4-service-account.test.ts — the GA4 service-account lane (no live network, no DB).
 *
 * Covers:
 *   - Ga4DataClient (kind='service_account'): authenticate() signs a REAL RS256 JWT-bearer
 *     assertion (generated test key) and exchanges it at the token endpoint; 4xx → GA4_AUTH_ERROR;
 *     the minted token is used as the runReport Bearer.
 *   - resolveGa4Credentials (mocked pg dev_secret read): a service-account bundle resolves WITHOUT
 *     the shared GOOGLE_CLIENT_ID env pair (the env dependency the rebuild drops), carries the
 *     bundle currency_code (uppercased), and falls back to the ad_account_id column property id.
 *   - Legacy OAuth bundle still requires the env pair (back-compat).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';

// ── pg mock: readGa4SecretBundle's dev_secret read (both static + dynamic import) ──
const pgState = vi.hoisted(() => ({ secretValue: null as string | null }));
vi.mock('pg', () => {
  class MockPool {
    async query(): Promise<{ rows: Array<{ secret_value: string }> }> {
      return { rows: pgState.secretValue === null ? [] : [{ secret_value: pgState.secretValue }] };
    }
    async end(): Promise<void> {
      /* no-op */
    }
    async connect(): Promise<never> {
      throw new Error('not used in these tests');
    }
  }
  return { Pool: MockPool, default: { Pool: MockPool } };
});

import { resolveGa4Credentials } from './run.js';
import { Ga4DataClient, GA4_AUTH_ERROR } from './ga4-data-client.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const CLIENT_EMAIL = 'brain-ga4@test-project.iam.gserviceaccount.com';
const PROPERTY_ID = '987654321';

const SA_CREDS = {
  kind: 'service_account' as const,
  clientEmail: CLIENT_EMAIL,
  privateKeyPem: PRIVATE_PEM,
  propertyId: PROPERTY_ID,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Ga4DataClient — service-account JWT-bearer auth (mocked fetch)', () => {
  it('authenticate() exchanges a signed jwt-bearer assertion and uses the token on runReport', async () => {
    const calls: Array<{ url: string; body: string; auth: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body?: string; headers?: Record<string, string> }) => {
      calls.push({ url, body: String(init?.body ?? ''), auth: init?.headers?.['Authorization'] ?? '' });
      if (url.includes('oauth2.googleapis.com/token')) {
        return { ok: true, status: 200, json: async () => ({ access_token: 'ya29.sa-token', expires_in: 3599 }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({ rows: [], rowCount: 0 }) } as unknown as Response;
    }));

    const client = new Ga4DataClient(SA_CREDS);
    await client.authenticate();
    await client.runReport('2026-07-01', '2026-07-11');

    // Token exchange used the JWT-bearer grant with a signed assertion.
    expect(calls[0]!.url).toContain('oauth2.googleapis.com/token');
    expect(calls[0]!.body).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer');
    expect(calls[0]!.body).toContain('assertion=');
    // runReport hit the property with the minted Bearer token.
    expect(calls[1]!.url).toContain(`/properties/${PROPERTY_ID}:runReport`);
    expect(calls[1]!.auth).toBe('Bearer ya29.sa-token');
  });

  it('authenticate() throws GA4_AUTH_ERROR when Google rejects the assertion (400)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: 'invalid_grant' }),
    })));

    const client = new Ga4DataClient(SA_CREDS);
    await expect(client.authenticate()).rejects.toThrow(GA4_AUTH_ERROR);
  });

  it('authenticate() throws GA4_AUTH_ERROR on a structurally empty key (no network)', async () => {
    const fetchStub = vi.fn();
    vi.stubGlobal('fetch', fetchStub);
    const client = new Ga4DataClient({ ...SA_CREDS, privateKeyPem: '', clientEmail: '' });
    await expect(client.authenticate()).rejects.toThrow(GA4_AUTH_ERROR);
    expect(fetchStub).not.toHaveBeenCalled();
  });
});

describe('resolveGa4Credentials — service-account bundle (mocked dev_secret)', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env['NODE_ENV'] = 'test'; // dev path → mocked pg dev_secret read
    delete process.env['GOOGLE_CLIENT_ID'];
    delete process.env['GOOGLE_CLIENT_SECRET'];
    delete process.env['GOOGLE_ADS_CLIENT_ID'];
    delete process.env['GOOGLE_ADS_CLIENT_SECRET'];
    pgState.secretValue = null;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('SA bundle resolves WITHOUT the shared GOOGLE_CLIENT_ID env pair (the dropped dependency)', async () => {
    pgState.secretValue = JSON.stringify({
      auth_method: 'service_account',
      client_email: CLIENT_EMAIL,
      private_key: PRIVATE_PEM,
      property_id: PROPERTY_ID,
      currency_code: 'inr',
    });

    const creds = await resolveGa4Credentials('arn:x:secret:brand_ga4', null);
    expect(creds).toEqual({
      kind: 'service_account',
      clientEmail: CLIENT_EMAIL,
      privateKeyPem: PRIVATE_PEM,
      propertyId: PROPERTY_ID,
      currencyCode: 'INR', // uppercased from the bundle
    });
  });

  it('SA bundle without property_id falls back to the ad_account_id column (repull contract)', async () => {
    pgState.secretValue = JSON.stringify({
      client_email: CLIENT_EMAIL,
      private_key: PRIVATE_PEM,
    });

    const creds = await resolveGa4Credentials('arn:x:secret:brand_ga4', PROPERTY_ID);
    expect(creds).toMatchObject({ kind: 'service_account', propertyId: PROPERTY_ID });
    expect(creds).not.toHaveProperty('currencyCode');
  });

  it('non-numeric property id → null (honest-empty guard)', async () => {
    pgState.secretValue = JSON.stringify({
      client_email: CLIENT_EMAIL,
      private_key: PRIVATE_PEM,
      property_id: 'G-ABC123',
    });
    await expect(resolveGa4Credentials('arn:x:secret:brand_ga4', null)).resolves.toBeNull();
  });

  it('legacy OAuth bundle still requires the env app pair (null without it, resolves with it)', async () => {
    pgState.secretValue = JSON.stringify({ refresh_token: 'rt-1', property_id: PROPERTY_ID });

    // No env pair → honest null (surface reconnect-with-SA guidance).
    await expect(resolveGa4Credentials('arn:x:secret:brand_ga4', null)).resolves.toBeNull();

    // With the env pair the legacy path still works (back-compat).
    process.env['GOOGLE_CLIENT_ID'] = 'env-client-id';
    process.env['GOOGLE_CLIENT_SECRET'] = 'env-client-secret';
    const creds = await resolveGa4Credentials('arn:x:secret:brand_ga4', null);
    expect(creds).toMatchObject({
      kind: 'oauth',
      refreshToken: 'rt-1',
      clientId: 'env-client-id',
      propertyId: PROPERTY_ID,
    });
  });

  it('empty bundle → null (honest-empty guard: neither SA key nor refresh token)', async () => {
    pgState.secretValue = JSON.stringify({ property_id: PROPERTY_ID });
    await expect(resolveGa4Credentials('arn:x:secret:brand_ga4', null)).resolves.toBeNull();
  });
});
