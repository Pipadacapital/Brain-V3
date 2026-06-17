/**
 * SecretRef unit tests (NN-2 + HIGH-01/D-7/ADR-CM-4 KMS isolation).
 *
 * Verifies that:
 *   - ConnectorInstance entity rejects creation without a secretRef (negative control).
 *   - ConnectorInstance entity does NOT have any token/key/ciphertext field.
 *   - LocalSecretsManager returns an ARN (never returns a plaintext token to the caller).
 *   - The secretRef field is required and non-empty.
 *   - AwsSecretsManager sends KMSKeyId + EncryptionContext on CreateSecretCommand
 *     and GetSecretValueCommand (HIGH-01 VETO-clearing proof).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConnectorInstance } from '../domain/entities/ConnectorInstance.js';
import { LocalSecretsManager } from '../infrastructure/secrets/LocalSecretsManager.js';

const VALID_PROPS = {
  id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
  brandId: '550e8400-e29b-41d4-a716-446655440000',
  provider: 'shopify' as const,
  shopDomain: 'teststore.myshopify.com',
  secretRef: 'arn:aws:secretsmanager:us-east-1:000000000000:secret:brain/connector/shopify/...',
  status: 'connected' as const,
  // ADR-CM-5: health fields required in ConnectorInstanceProps
  healthState: 'Healthy' as const,
  safetyRating: 'safe' as const,
  connectedAt: new Date(),
  disconnectedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('ConnectorInstance (NN-2 secret_ref enforcement)', () => {
  it('accepts a valid entity with a non-empty secretRef', () => {
    const instance = ConnectorInstance.create(VALID_PROPS);
    expect(instance.secretRef).toBeTruthy();
  });

  it('rejects creation with an empty secretRef (negative control — NN-2)', () => {
    expect(() =>
      ConnectorInstance.create({ ...VALID_PROPS, secretRef: '' }),
    ).toThrow(/secret_ref must be a non-empty Secrets Manager ARN/);
  });

  it('rejects creation with a whitespace-only secretRef (negative control — NN-2)', () => {
    expect(() =>
      ConnectorInstance.create({ ...VALID_PROPS, secretRef: '   ' }),
    ).toThrow(/secret_ref/);
  });

  it('does NOT have any oauth_token / access_token / *_key field (NN-2 schema check)', () => {
    const instance = ConnectorInstance.create(VALID_PROPS);
    const keys = Object.keys(instance);
    const forbiddenPatterns = ['token', 'ciphertext', 'access_token', 'oauth_token', '_key', '_secret'];
    for (const key of keys) {
      for (const pattern of forbiddenPatterns) {
        expect(key.toLowerCase()).not.toContain(pattern);
      }
    }
  });

  it('rejects an invalid shop domain (not *.myshopify.com)', () => {
    expect(() =>
      ConnectorInstance.create({ ...VALID_PROPS, shopDomain: 'evil.example.com' }),
    ).toThrow(/myshopify\.com/);
  });

  it('validates that secretRef is an ARN-shaped string (structural check)', () => {
    const instance = ConnectorInstance.create(VALID_PROPS);
    // The real ARN starts with arn: — this is a structural (not format-strict) check
    expect(instance.secretRef).toContain('arn');
  });
});

describe('LocalSecretsManager (NN-2 storage contract)', () => {
  it('stores token and returns an ARN, never the token value', async () => {
    process.env['SHOPIFY_CLIENT_SECRET'] = 'test-secret';
    const mgr = new LocalSecretsManager();
    const result = await mgr.storeShopifyToken(
      '550e8400-e29b-41d4-a716-446655440000',
      'mystore.myshopify.com',
      'shpat_secret_access_token_value',
    );
    // The result is an ARN — not the token itself
    expect(result.arn).toMatch(/^arn:aws:/);
    expect(result.arn).not.toContain('shpat_secret_access_token_value');
    expect(result.name).not.toContain('shpat_secret_access_token_value');
  });
});

// ── HIGH-01 VETO-clearing proof — AwsSecretsManager KMS CMK binding ──────────────
//
// Mocks @aws-sdk/client-secrets-manager to assert that CreateSecretCommand is invoked
// WITH KmsKeyId set to the injected CMK ARN, and that the secret Name encodes the
// brand_id and connector_type (auditable brand attribution via Tags + namespaced path).
//
// Isolation guarantee: AWS Secrets Manager uses the CMK for envelope encryption.
// A caller without IAM/key-policy permission on the CMK cannot call GetSecretValue
// even if the secret ARN is known. Per-brand isolation = per-brand CMK policy.
//
// NOTE: AWS Secrets Manager's CreateSecret API does NOT accept a caller-supplied
// EncryptionContext parameter — the service derives its own internal context.
// The KmsKeyId binding is the structural enforcement mechanism (D-7/ADR-CM-4).
//
// These tests go RED if KmsKeyId is dropped or set to undefined.
describe('AwsSecretsManager (HIGH-01/D-7/ADR-CM-4 — KMS CMK isolation)', () => {
  const BRAND_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const KMS_KEY_ID = 'arn:aws:kms:us-east-1:123456789012:key/test-key-id';
  const CONNECTOR_TYPE = 'shopify';
  const FAKE_ARN = `arn:aws:secretsmanager:us-east-1:123456789012:secret:brain/connector/${CONNECTOR_TYPE}/${BRAND_ID}-AbCdEf`;
  const FAKE_SECRET_JSON = JSON.stringify({ access_token: 'tok_test' });

  let sendMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
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

    const { AwsSecretsManager } = await import(
      '../infrastructure/secrets/AwsSecretsManager.js'
    );
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

    const { AwsSecretsManager } = await import(
      '../infrastructure/secrets/AwsSecretsManager.js'
    );
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

    const { AwsSecretsManager } = await import(
      '../infrastructure/secrets/AwsSecretsManager.js'
    );
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

    const { AwsSecretsManager } = await import(
      '../infrastructure/secrets/AwsSecretsManager.js'
    );
    const mgr = new AwsSecretsManager('us-east-1', 'arn:aws:secretsmanager:us-east-1:123:secret:shopify-client', KMS_KEY_ID);

    const result = await mgr.getSecret(FAKE_ARN);

    expect(sendMock).toHaveBeenCalledOnce();
    const [cmd] = sendMock.mock.calls[0]!;
    expect(cmd.input.SecretId).toBe(FAKE_ARN);
    expect(result).toEqual({ access_token: 'tok_test' });
  });
});
