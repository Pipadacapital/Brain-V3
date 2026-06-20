/**
 * razorpay-credentials.prod.test.ts — P0: the prod AWS Secrets Manager credential-bundle reader.
 *
 * The settlement re-pull previously had ONLY a dev resolver (dev_secret table / env), so it could
 * not run against real prod secrets — a hard blocker on live settlement truth. This proves the new
 * prod branch reads the {key_id, key_secret, webhook_secret} bundle from AWS Secrets Manager via the
 * shared @brain/connector-secrets AwsSecretsManager (the same impl the connect path wrote it with),
 * and is fail-closed on a missing/partial bundle (never fabricates credentials).
 *
 * @brain/connector-secrets is mocked — no real AWS. (A realistic prod bundle stands in for the
 * GetSecretValue response; the real pipeline reads the identical shape from Secrets Manager.)
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const getSecretMock = vi.fn();
vi.mock('@brain/connector-secrets', () => ({
  AwsSecretsManager: vi.fn().mockImplementation(() => ({ getSecret: getSecretMock })),
}));

import { resolveRazorpayCredentials } from '../jobs/razorpay-settlement-repull/run.js';

const ARN = 'arn:aws:secretsmanager:ap-south-1:123456789012:secret:brain/connector/razorpay/acc_LbXyZ-AbCdEf';
const prevNodeEnv = process.env['NODE_ENV'];

afterEach(() => {
  vi.clearAllMocks();
  process.env['NODE_ENV'] = prevNodeEnv ?? 'test';
});

describe('resolveRazorpayCredentials — prod AWS Secrets Manager path (P0)', () => {
  it('reads the {key_id, key_secret} bundle from Secrets Manager in production', async () => {
    process.env['NODE_ENV'] = 'production';
    getSecretMock.mockResolvedValue({
      key_id: 'rzp_live_AbC123XyZ',
      key_secret: 'sek_live_9f8e7d6c5b4a',
      webhook_secret: 'whsec_live_aabbccddeeff',
    });
    const creds = await resolveRazorpayCredentials(ARN);
    expect(creds).toEqual({ keyId: 'rzp_live_AbC123XyZ', keySecret: 'sek_live_9f8e7d6c5b4a' });
    expect(getSecretMock).toHaveBeenCalledWith(ARN);
  });

  it('fail-closed: a partial bundle (missing key_secret) returns null — RECONNECT, never fabricated', async () => {
    process.env['NODE_ENV'] = 'production';
    getSecretMock.mockResolvedValue({ key_id: 'rzp_live_AbC123XyZ' });
    expect(await resolveRazorpayCredentials(ARN)).toBeNull();
  });

  it('fail-closed: a missing secret (null) returns null', async () => {
    process.env['NODE_ENV'] = 'production';
    getSecretMock.mockResolvedValue(null);
    expect(await resolveRazorpayCredentials(ARN)).toBeNull();
  });
});
