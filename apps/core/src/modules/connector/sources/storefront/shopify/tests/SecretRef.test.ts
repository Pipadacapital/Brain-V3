/**
 * SecretRef unit tests (NN-2 secret_ref enforcement + LocalSecretsManager storage contract).
 *
 * Verifies that:
 *   - ConnectorInstance entity rejects creation without a secretRef (negative control).
 *   - ConnectorInstance entity does NOT have any token/key/ciphertext field.
 *   - LocalSecretsManager returns an ARN (never returns a plaintext token to the caller).
 *   - The secretRef field is required and non-empty.
 *
 * The AwsSecretsManager KMS-CMK-isolation proofs (HIGH-01/D-7/ADR-CM-4) moved with the
 * implementation to packages/connector-secrets/src/AwsSecretsManager.test.ts (#75).
 */
import { describe, it, expect } from 'vitest';
import { ConnectorInstance } from '@brain/connector-core';
import { createShopifyConnectorInstance } from '../domain/ShopifyHostPolicy.js';
import { LocalSecretsManager } from '@brain/connector-secrets';

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

  it('the neutral kernel entity no longer hardcodes the myshopify.com rule (it accepts any host)', () => {
    // The host rule moved into ShopifyHostPolicy; the kernel is provider-agnostic.
    const instance = ConnectorInstance.create({ ...VALID_PROPS, shopDomain: 'evil.example.com' });
    expect(instance.shopDomain).toBe('evil.example.com');
  });

  it('the Shopify factory still rejects an invalid shop domain (NN-4 preserved)', () => {
    expect(() =>
      createShopifyConnectorInstance({ ...VALID_PROPS, shopDomain: 'evil.example.com' }),
    ).toThrow(/Invalid host/);
  });

  it('the Shopify factory accepts a valid *.myshopify.com host', () => {
    const instance = createShopifyConnectorInstance(VALID_PROPS);
    expect(instance.shopDomain).toBe('teststore.myshopify.com');
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
