/**
 * AwsSecretsManager unit tests (HIGH-01/D-7/ADR-CM-4 — KMS CMK isolation).
 *
 * Co-located with the implementation in @brain/connector-secrets (#75): mocking the SDK's direct,
 * same-package import is deterministic here — unlike mocking it transitively through a dynamically
 * imported workspace package, which does not reliably intercept on first load.
 *
 * Mocks @aws-sdk/client-secrets-manager to assert CreateSecretCommand is invoked WITH KmsKeyId set
 * to the injected CMK ARN, and that the secret Name encodes brand_id + connector_type (auditable
 * attribution via Tags + namespaced path). These go RED if KmsKeyId is dropped or set to undefined
 * (per-brand isolation = per-brand CMK policy: a caller without key-policy permission on the CMK
 * cannot GetSecretValue even if it knows the ARN).
 *
 * NOTE: AWS Secrets Manager's CreateSecret API does NOT accept a caller-supplied EncryptionContext —
 * the service derives its own. The KmsKeyId binding is the structural enforcement mechanism.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('AwsSecretsManager (HIGH-01/D-7/ADR-CM-4 — KMS CMK isolation)', () => {
  const BRAND_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const KMS_KEY_ID = 'arn:aws:kms:us-east-1:123456789012:key/test-key-id';
  const CONNECTOR_TYPE = 'shopify';
  const FAKE_ARN = `arn:aws:secretsmanager:us-east-1:123456789012:secret:brain/connector/${CONNECTOR_TYPE}/${BRAND_ID}-AbCdEf`;
  const FAKE_SECRET_JSON = JSON.stringify({ access_token: 'tok_test' });

  let sendMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Mock the SecretsManagerClient.send method to intercept SDK calls.
    sendMock = vi.fn();
    vi.doMock('@aws-sdk/client-secrets-manager', async (importOriginal) => {
      const original = await importOriginal<typeof import('@aws-sdk/client-secrets-manager')>();
      return {
        ...original,
        SecretsManagerClient: vi.fn().mockImplementation(() => ({
          send: sendMock,
        })),
      };
    });
  });

  afterEach(() => {
    vi.doUnmock('@aws-sdk/client-secrets-manager');
    vi.resetModules();
  });

  it('storeSecret sends KmsKeyId on CreateSecretCommand AND name encodes brand+connector (HIGH-01 proof)', async () => {
    sendMock.mockResolvedValue({ ARN: FAKE_ARN });

    const { AwsSecretsManager } = await import('./AwsSecretsManager.js');
    const mgr = new AwsSecretsManager('us-east-1', 'arn:aws:secretsmanager:us-east-1:123:secret:shopify-client', KMS_KEY_ID);

    await mgr.storeSecret(BRAND_ID, { connectorType: CONNECTOR_TYPE }, { api_key: 'k', api_secret: 's' });

    expect(sendMock).toHaveBeenCalledOnce();
    const [cmd] = sendMock.mock.calls[0]!;
    // KmsKeyId must be the injected CMK (not undefined, not the AWS-managed default).
    // This goes RED if KmsKeyId is dropped.
    expect(cmd.input.KmsKeyId).toBe(KMS_KEY_ID);
    // Secret name must encode brand_id and connector_type for auditable attribution.
    expect(cmd.input.Name).toContain(BRAND_ID);
    expect(cmd.input.Name).toContain(CONNECTOR_TYPE);
    // Tags must carry brand_id and connector_type for cost/audit filtering.
    const tags: Array<{ Key: string; Value: string }> = cmd.input.Tags ?? [];
    expect(tags.find((t) => t.Key === 'brand_id')?.Value).toBe(BRAND_ID);
    expect(tags.find((t) => t.Key === 'connector_type')?.Value).toBe(CONNECTOR_TYPE);
  });

  it('goes RED when KmsKeyId is absent — negative control (non-inert proof)', async () => {
    sendMock.mockResolvedValue({ ARN: FAKE_ARN });

    const { AwsSecretsManager } = await import('./AwsSecretsManager.js');
    const mgr = new AwsSecretsManager('us-east-1', 'arn:aws:secretsmanager:us-east-1:123:secret:shopify-client', KMS_KEY_ID);

    await mgr.storeSecret(BRAND_ID, { connectorType: CONNECTOR_TYPE }, { api_key: 'k' });

    const [cmd] = sendMock.mock.calls[0]!;
    // This assertion FAILS (goes RED) if KmsKeyId is dropped — proving non-inertness.
    expect(cmd.input.KmsKeyId).toBeDefined();
    expect(cmd.input.KmsKeyId).not.toBeUndefined();
    expect(cmd.input.KmsKeyId).toBe(KMS_KEY_ID);
  });

  it('storeShopifyToken sends KmsKeyId AND name encodes brand_id (HIGH-01 proof)', async () => {
    sendMock.mockResolvedValue({ ARN: FAKE_ARN });

    const { AwsSecretsManager } = await import('./AwsSecretsManager.js');
    const mgr = new AwsSecretsManager('us-east-1', 'arn:aws:secretsmanager:us-east-1:123:secret:shopify-client', KMS_KEY_ID);

    await mgr.storeShopifyToken(BRAND_ID, 'teststore.myshopify.com', 'shpat_test_tok');

    expect(sendMock).toHaveBeenCalledOnce();
    const [cmd] = sendMock.mock.calls[0]!;
    // KmsKeyId binding must be present on storeShopifyToken too.
    expect(cmd.input.KmsKeyId).toBe(KMS_KEY_ID);
    // Name must encode brand_id.
    expect(cmd.input.Name).toContain(BRAND_ID);
    const tags: Array<{ Key: string; Value: string }> = cmd.input.Tags ?? [];
    expect(tags.find((t) => t.Key === 'brand_id')?.Value).toBe(BRAND_ID);
    expect(tags.find((t) => t.Key === 'connector_type')?.Value).toBe('shopify');
  });

  it('getSecret calls GetSecretValueCommand with the correct SecretId (contract check)', async () => {
    sendMock.mockResolvedValue({ SecretString: FAKE_SECRET_JSON });

    const { AwsSecretsManager } = await import('./AwsSecretsManager.js');
    const mgr = new AwsSecretsManager('us-east-1', 'arn:aws:secretsmanager:us-east-1:123:secret:shopify-client', KMS_KEY_ID);

    const result = await mgr.getSecret(FAKE_ARN);

    expect(sendMock).toHaveBeenCalledOnce();
    const [cmd] = sendMock.mock.calls[0]!;
    expect(cmd.input.SecretId).toBe(FAKE_ARN);
    expect(result).toEqual({ access_token: 'tok_test' });
  });

  it('storeSecret UPSERT: ResourceExistsException → falls back to PutSecretValue, returns existing ARN (reconnect path)', async () => {
    const { ResourceExistsException } = await import('@aws-sdk/client-secrets-manager');
    const existsErr = new ResourceExistsException({ message: 'already exists', $metadata: {} });
    // First call (CreateSecret) throws; second call (PutSecretValue) succeeds with the ARN.
    sendMock
      .mockRejectedValueOnce(existsErr)
      .mockResolvedValueOnce({ ARN: FAKE_ARN });

    const { AwsSecretsManager } = await import('./AwsSecretsManager.js');
    const mgr = new AwsSecretsManager('us-east-1', 'arn:aws:secretsmanager:us-east-1:123:secret:shopify-client', KMS_KEY_ID);

    // Must NOT throw — this is the reconnect path.
    const result = await mgr.storeSecret(BRAND_ID, { connectorType: CONNECTOR_TYPE }, { api_key: 'k', api_secret: 's' });

    expect(sendMock).toHaveBeenCalledTimes(2);
    // Second call must be PutSecretValueCommand (not CreateSecretCommand).
    const [putCmd] = sendMock.mock.calls[1]!;
    expect(putCmd.input.SecretId).toBeDefined();
    expect(putCmd.input.SecretString).toBe(JSON.stringify({ api_key: 'k', api_secret: 's' }));
    // The returned ARN must be the one from PutSecretValue.
    expect(result.arn).toBe(FAKE_ARN);
  });

  it('putSecretValue calls PutSecretValueCommand with the correct SecretId and SecretString', async () => {
    sendMock.mockResolvedValue({ ARN: FAKE_ARN });

    const { AwsSecretsManager } = await import('./AwsSecretsManager.js');
    const mgr = new AwsSecretsManager('us-east-1', 'arn:aws:secretsmanager:us-east-1:123:secret:shopify-client', KMS_KEY_ID);

    await mgr.putSecretValue(FAKE_ARN, { access_token: 'refreshed_tok' });

    expect(sendMock).toHaveBeenCalledOnce();
    const [cmd] = sendMock.mock.calls[0]!;
    expect(cmd.input.SecretId).toBe(FAKE_ARN);
    expect(cmd.input.SecretString).toBe(JSON.stringify({ access_token: 'refreshed_tok' }));
  });
});
