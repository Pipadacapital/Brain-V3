/**
 * ShopifyHmac unit tests (NN-4 validation).
 *
 * Negative controls are mandatory:
 *   - A tampered HMAC MUST reject.
 *   - A missing HMAC MUST reject.
 *   - A correct HMAC MUST accept.
 *   - Webhook HMAC: tampered body MUST reject.
 *
 * These tests verify the NN-4 security invariant without a live Shopify connection.
 */
import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { ShopifyHmac } from '../domain/value-objects/ShopifyHmac.js';

const CLIENT_SECRET = 'test-shopify-client-secret-for-unit-tests';

// ── OAuth callback HMAC tests ─────────────────────────────────────────────────

function buildOAuthQuery(params: Record<string, string>, secret: string) {
  // Build HMAC the way Shopify does:
  // 1. Remove hmac, sort key=value pairs, join with &, HMAC-SHA256 hex
  const message = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .sort()
    .join('&');
  const hmac = createHmac('sha256', secret).update(message).digest('hex');
  return { ...params, hmac };
}

describe('ShopifyHmac.validateOAuthCallback', () => {
  it('accepts a valid HMAC (positive control)', () => {
    const params = {
      code: 'abc123',
      shop: 'test.myshopify.com',
      state: 'deadbeef',
      timestamp: '1718400000',
    };
    const query = buildOAuthQuery(params, CLIENT_SECRET);
    expect(ShopifyHmac.validateOAuthCallback(query, CLIENT_SECRET)).toBe(true);
  });

  it('rejects a tampered HMAC (negative control — NN-4)', () => {
    const params = {
      code: 'abc123',
      shop: 'test.myshopify.com',
      state: 'deadbeef',
      timestamp: '1718400000',
    };
    const query = buildOAuthQuery(params, CLIENT_SECRET);
    // Tamper the HMAC
    const tamperedQuery = { ...query, hmac: query.hmac.replace('a', 'b') };
    expect(ShopifyHmac.validateOAuthCallback(tamperedQuery, CLIENT_SECRET)).toBe(false);
  });

  it('rejects a missing HMAC (negative control)', () => {
    const query: Record<string, string> = {
      code: 'abc123',
      shop: 'test.myshopify.com',
      state: 'deadbeef',
    };
    expect(ShopifyHmac.validateOAuthCallback(query, CLIENT_SECRET)).toBe(false);
  });

  it('rejects a HMAC signed with a wrong secret (negative control)', () => {
    const params = {
      code: 'abc123',
      shop: 'test.myshopify.com',
      state: 'deadbeef',
      timestamp: '1718400000',
    };
    // Sign with a DIFFERENT secret
    const query = buildOAuthQuery(params, 'wrong-secret');
    expect(ShopifyHmac.validateOAuthCallback(query, CLIENT_SECRET)).toBe(false);
  });

  it('rejects when query params are modified after HMAC is computed (tamper negative control)', () => {
    const params = {
      code: 'abc123',
      shop: 'test.myshopify.com',
      state: 'deadbeef',
      timestamp: '1718400000',
    };
    const query = buildOAuthQuery(params, CLIENT_SECRET);
    // Modify a param after signing — HMAC must not match
    const tamperedQuery = { ...query, shop: 'evil.myshopify.com' };
    expect(ShopifyHmac.validateOAuthCallback(tamperedQuery, CLIENT_SECRET)).toBe(false);
  });
});

// ── Webhook HMAC tests ────────────────────────────────────────────────────────

describe('ShopifyHmac.validateWebhook', () => {
  it('accepts a valid webhook HMAC (positive control)', () => {
    const body = Buffer.from(JSON.stringify({ order_id: 'gid://shopify/Order/12345' }));
    const hmac = createHmac('sha256', CLIENT_SECRET).update(body).digest('base64');
    expect(ShopifyHmac.validateWebhook(body, hmac, CLIENT_SECRET)).toBe(true);
  });

  it('rejects a tampered webhook body (negative control — NN-4)', () => {
    const originalBody = Buffer.from(JSON.stringify({ order_id: 'gid://shopify/Order/12345' }));
    const hmac = createHmac('sha256', CLIENT_SECRET).update(originalBody).digest('base64');
    // Tampered body
    const tamperedBody = Buffer.from(JSON.stringify({ order_id: 'gid://shopify/Order/99999' }));
    expect(ShopifyHmac.validateWebhook(tamperedBody, hmac, CLIENT_SECRET)).toBe(false);
  });

  it('rejects a missing webhook HMAC (negative control)', () => {
    const body = Buffer.from('{}');
    expect(ShopifyHmac.validateWebhook(body, '', CLIENT_SECRET)).toBe(false);
  });

  it('rejects a webhook HMAC signed with a wrong secret (negative control)', () => {
    const body = Buffer.from(JSON.stringify({ order_id: 'gid://shopify/Order/12345' }));
    const hmac = createHmac('sha256', 'wrong-secret').update(body).digest('base64');
    expect(ShopifyHmac.validateWebhook(body, hmac, CLIENT_SECRET)).toBe(false);
  });
});
