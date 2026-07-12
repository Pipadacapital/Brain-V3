/**
 * unwrapShopifyTokenValue — pure unit tests.
 *
 * Two Shopify token storage shapes coexist behind getShopifyToken(secret_ref):
 *   - LEGACY (authorization-code OAuth): the SecretString IS the raw token.
 *   - BUNDLE (generic per-brand client-credentials connect): JSON with access_token +
 *     refresh metadata (auth_method / issued / expires) for the token-refresh cron.
 * The unwrap keeps every existing reader (RegisterWebhooks, pixel install, backfill worker,
 * repull) working unchanged across both shapes.
 */
import { describe, it, expect } from 'vitest';
import { unwrapShopifyTokenValue } from './ISecretsManager.js';

describe('unwrapShopifyTokenValue', () => {
  it('returns a legacy raw token unchanged', () => {
    expect(unwrapShopifyTokenValue('shpat_raw_token')).toBe('shpat_raw_token');
  });

  it('unwraps a client-credentials JSON bundle to the bare access_token', () => {
    const bundle = JSON.stringify({
      access_token: 'shpat_bundle_token',
      shop_domain: 'x.myshopify.com',
      auth_method: 'client_credentials',
      access_token_issued_at: '2026-07-12T00:00:00Z',
      access_token_expires_at: '2026-07-13T00:00:00Z',
    });
    expect(unwrapShopifyTokenValue(bundle)).toBe('shpat_bundle_token');
  });

  it('tolerates leading whitespace around a JSON bundle', () => {
    expect(unwrapShopifyTokenValue('  {"access_token":"t"}')).toBe('t');
  });

  it('returns the raw value for JSON without an access_token (not a token bundle)', () => {
    const notABundle = JSON.stringify({ client_id: 'a', client_secret: 'b' });
    expect(unwrapShopifyTokenValue(notABundle)).toBe(notABundle);
  });

  it('returns the raw value for malformed JSON starting with a brace', () => {
    expect(unwrapShopifyTokenValue('{not-json')).toBe('{not-json');
  });
});
