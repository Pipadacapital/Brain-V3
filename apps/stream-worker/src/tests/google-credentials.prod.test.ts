/**
 * google-credentials.prod.test.ts — P0: the OAuth↔repull credential-bundle mismatch is fixed.
 *
 * The Google OAuth callback stores ONLY {refresh_token, ad_account_id} in the per-brand secret, but
 * the old resolver demanded client_id/client_secret/developer_token/customer_id ALL from that
 * bundle → they were undefined → returned null → ZERO spend on every real connect. The fix sources
 * the app-level Google Cloud creds from ENV (same for every brand) and the refresh_token/ad_account_id
 * from the bundle. This proves the previously-null case now resolves, plus fail-closed branches.
 *
 * @brain/connector-secrets is mocked — no real AWS. A realistic {refresh_token, ad_account_id}
 * bundle stands in for the prod GetSecretValue response.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const getSecretMock = vi.fn();
vi.mock('@brain/connector-secrets', () => ({
  AwsSecretsManager: vi.fn().mockImplementation(() => ({ getSecret: getSecretMock })),
}));

import { resolveGoogleCredentials } from '../jobs/google-ads-spend-repull/run.js';

const ARN = 'arn:aws:secretsmanager:ap-south-1:123456789012:secret:brain/connector/google_ads/1234567890-AbCdEf';
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ['NODE_ENV', 'GOOGLE_ADS_CLIENT_ID', 'GOOGLE_ADS_CLIENT_SECRET', 'GOOGLE_ADS_DEVELOPER_TOKEN', 'GOOGLE_ADS_LOGIN_CUSTOMER_ID'];

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env['NODE_ENV'] = 'production';
  process.env['GOOGLE_ADS_CLIENT_ID'] = '1234.apps.googleusercontent.com';
  process.env['GOOGLE_ADS_CLIENT_SECRET'] = 'GOCSPX-appsecret';
  process.env['GOOGLE_ADS_DEVELOPER_TOKEN'] = 'devTok_AbCdEf123';
  delete process.env['GOOGLE_ADS_LOGIN_CUSTOMER_ID'];
});

afterEach(() => {
  vi.clearAllMocks();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('resolveGoogleCredentials — OAuth↔repull bundle fix (P0)', () => {
  it('resolves with app-env creds + the {refresh_token, ad_account_id} bundle (previously null → zero spend)', async () => {
    getSecretMock.mockResolvedValue({ refresh_token: '1//0gReFrEsH', ad_account_id: '1234567890' });
    const creds = await resolveGoogleCredentials(ARN, null);
    expect(creds).not.toBeNull();
    expect(creds!.refreshToken).toBe('1//0gReFrEsH');
    expect(creds!.clientId).toBe('1234.apps.googleusercontent.com');
    expect(creds!.clientSecret).toBe('GOCSPX-appsecret');
    expect(creds!.developerToken).toBe('devTok_AbCdEf123');
    expect(creds!.customerId).toBe('1234567890'); // from the bundle's ad_account_id
  });

  it('strips dashes from a CID and falls back to the connector_instance ad_account_id column', async () => {
    getSecretMock.mockResolvedValue({ refresh_token: '1//0gReFrEsH' }); // no ad_account_id in bundle
    const creds = await resolveGoogleCredentials(ARN, '123-456-7890');
    expect(creds!.customerId).toBe('1234567890'); // dashes stripped, sourced from the column
  });

  it('fail-closed: app-level env creds missing → null (cannot resolve)', async () => {
    delete process.env['GOOGLE_ADS_DEVELOPER_TOKEN'];
    getSecretMock.mockResolvedValue({ refresh_token: '1//0gReFrEsH', ad_account_id: '1234567890' });
    expect(await resolveGoogleCredentials(ARN, null)).toBeNull();
  });

  it('fail-closed: a bundle without refresh_token → null', async () => {
    getSecretMock.mockResolvedValue({ ad_account_id: '1234567890' });
    expect(await resolveGoogleCredentials(ARN, null)).toBeNull();
  });

  // ── BYO refresh fix: the bundle's client creds WIN over env ────────────────────────────────
  it('prefers the bundle client_id/client_secret/developer_token over env (BYO app — refresh must use the minting client)', async () => {
    getSecretMock.mockResolvedValue({
      refresh_token: '1//0gReFrEsH',
      ad_account_id: '1234567890',
      client_id: 'byo-client.apps.googleusercontent.com',
      client_secret: 'GOCSPX-byo-secret',
      developer_token: 'byoDevTok',
    });
    const creds = await resolveGoogleCredentials(ARN, null);
    expect(creds!.clientId).toBe('byo-client.apps.googleusercontent.com');
    expect(creds!.clientSecret).toBe('GOCSPX-byo-secret');
    expect(creds!.developerToken).toBe('byoDevTok');
  });

  it('a BYO bundle resolves even with NO env app creds at all (ingestion-backfill inherits)', async () => {
    delete process.env['GOOGLE_ADS_CLIENT_ID'];
    delete process.env['GOOGLE_ADS_CLIENT_SECRET'];
    delete process.env['GOOGLE_ADS_DEVELOPER_TOKEN'];
    getSecretMock.mockResolvedValue({
      refresh_token: '1//0gReFrEsH',
      ad_account_id: '1234567890',
      client_id: 'byo-client.apps.googleusercontent.com',
      client_secret: 'GOCSPX-byo-secret',
      developer_token: 'byoDevTok',
    });
    const creds = await resolveGoogleCredentials(ARN, null);
    expect(creds).not.toBeNull();
    expect(creds!.clientId).toBe('byo-client.apps.googleusercontent.com');
  });

  it('a PARTIAL bundle (no developer_token) falls back to env for the missing field only', async () => {
    getSecretMock.mockResolvedValue({
      refresh_token: '1//0gReFrEsH',
      ad_account_id: '1234567890',
      client_id: 'byo-client.apps.googleusercontent.com',
      client_secret: 'GOCSPX-byo-secret',
    });
    const creds = await resolveGoogleCredentials(ARN, null);
    expect(creds!.clientId).toBe('byo-client.apps.googleusercontent.com');
    expect(creds!.developerToken).toBe('devTok_AbCdEf123'); // env fallback
  });
});
