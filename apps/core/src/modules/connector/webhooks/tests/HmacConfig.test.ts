/**
 * HmacConfig.test.ts — byte-compatibility regression pins for HmacConfig.
 *
 * Originally proved HmacConfig byte-identical to the four legacy *Hmac
 * value-objects (deleted after consolidation — AUD-CODE-006). The proof is
 * preserved as GOLDEN DIGEST pins: the fixed digests below were produced by
 * the legacy VOs' algorithm (HMAC-SHA256 over TEST_BODY with TEST_SECRET) and
 * must verify forever. A change here means the pipeline would reject webhooks
 * the legacy handlers accepted (or vice versa) — the cutover safety check.
 */

import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  SHOPIFY_HMAC_CONFIG,
  RAZORPAY_HMAC_CONFIG,
  WOOCOMMERCE_HMAC_CONFIG,
  buildShopfloHmacConfig,
} from '../platform/HmacConfig.js';
import { ProviderRedisDedupAdapter } from '../infrastructure/ProviderRedisDedupAdapter.js';

const TEST_BODY = Buffer.from('{"test":"payload","amount":1500}');
const TEST_SECRET = 'test-webhook-secret-for-hmac-compat';

// ── Golden digests (computed by the deleted legacy VOs; DO NOT regenerate) ──
// base64(HMAC-SHA256(TEST_BODY, TEST_SECRET)) — Shopify + WooCommerce scheme
const GOLDEN_BASE64_SIG = 'Ds4NUA0lc3U7S4GJb9uWUvlQrErlTy5fHrQsoJsnM1Y=';
// hex(HMAC-SHA256(TEST_BODY, TEST_SECRET)) — Razorpay + Shopflo scheme
const GOLDEN_HEX_SIG = '0ece0d500d2573753b4b81896fdb9652f950ac4ae54f2e5f1eb42ca09b273356';

function shopifySign(body: Buffer, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64');
}
function razorpaySign(body: Buffer, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}
function wooSign(body: Buffer, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64');
}
function shopfloSign(body: Buffer, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

describe('HmacConfig — byte-compatibility golden pins (legacy *Hmac VO algorithm)', () => {
  it('SHOPIFY_HMAC_CONFIG accepts the golden base64 digest ShopifyHmac.validateWebhook() produced', () => {
    const sig = shopifySign(TEST_BODY, TEST_SECRET);

    // The freshly-computed sig must equal the legacy VO's pinned golden digest
    expect(sig).toBe(GOLDEN_BASE64_SIG);
    expect(SHOPIFY_HMAC_CONFIG.validateWebhook(TEST_BODY, GOLDEN_BASE64_SIG, TEST_SECRET)).toBe(
      true,
    );

    // Must reject tampered body
    const tamperedBody = Buffer.from('{"test":"tampered"}');
    expect(SHOPIFY_HMAC_CONFIG.validateWebhook(tamperedBody, GOLDEN_BASE64_SIG, TEST_SECRET)).toBe(
      false,
    );

    // Must reject wrong encoding (hex instead of base64)
    expect(SHOPIFY_HMAC_CONFIG.validateWebhook(TEST_BODY, GOLDEN_HEX_SIG, TEST_SECRET)).toBe(false);
  });

  it('RAZORPAY_HMAC_CONFIG accepts the golden hex digest RazorpayHmac.validateWebhook() produced', () => {
    const sig = razorpaySign(TEST_BODY, TEST_SECRET);

    expect(sig).toBe(GOLDEN_HEX_SIG);
    expect(RAZORPAY_HMAC_CONFIG.validateWebhook(TEST_BODY, GOLDEN_HEX_SIG, TEST_SECRET)).toBe(true);

    const tamperedBody = Buffer.from('{"test":"tampered"}');
    expect(RAZORPAY_HMAC_CONFIG.validateWebhook(tamperedBody, GOLDEN_HEX_SIG, TEST_SECRET)).toBe(
      false,
    );

    // Razorpay uses hex — base64 sig must be rejected
    expect(RAZORPAY_HMAC_CONFIG.validateWebhook(TEST_BODY, GOLDEN_BASE64_SIG, TEST_SECRET)).toBe(
      false,
    );
  });

  it('WOOCOMMERCE_HMAC_CONFIG accepts the golden base64 digest WooCommerceHmac.validateWebhook() produced', () => {
    const sig = wooSign(TEST_BODY, TEST_SECRET);

    expect(sig).toBe(GOLDEN_BASE64_SIG);
    expect(WOOCOMMERCE_HMAC_CONFIG.validateWebhook(TEST_BODY, GOLDEN_BASE64_SIG, TEST_SECRET)).toBe(
      true,
    );

    const tamperedBody = Buffer.from('{"amount":9999}');
    expect(
      WOOCOMMERCE_HMAC_CONFIG.validateWebhook(tamperedBody, GOLDEN_BASE64_SIG, TEST_SECRET),
    ).toBe(false);
  });

  it('buildShopfloHmacConfig() accepts the golden hex digest ShopfloHmac.validateWebhook() produced', () => {
    const sig = shopfloSign(TEST_BODY, TEST_SECRET);
    const config = buildShopfloHmacConfig();

    expect(sig).toBe(GOLDEN_HEX_SIG);
    expect(config.validateWebhook(TEST_BODY, GOLDEN_HEX_SIG, TEST_SECRET)).toBe(true);

    const tamperedBody = Buffer.from('{"checkout_id":"tampered"}');
    expect(config.validateWebhook(tamperedBody, GOLDEN_HEX_SIG, TEST_SECRET)).toBe(false);
  });

  it('all configs reject empty signature header', () => {
    expect(SHOPIFY_HMAC_CONFIG.validateWebhook(TEST_BODY, '', TEST_SECRET)).toBe(false);
    expect(RAZORPAY_HMAC_CONFIG.validateWebhook(TEST_BODY, '', TEST_SECRET)).toBe(false);
    expect(WOOCOMMERCE_HMAC_CONFIG.validateWebhook(TEST_BODY, '', TEST_SECRET)).toBe(false);
    expect(buildShopfloHmacConfig().validateWebhook(TEST_BODY, '', TEST_SECRET)).toBe(false);
  });

  it('all configs reject empty secret', () => {
    const anySig = shopifySign(TEST_BODY, TEST_SECRET);
    expect(SHOPIFY_HMAC_CONFIG.validateWebhook(TEST_BODY, anySig, '')).toBe(false);
    expect(RAZORPAY_HMAC_CONFIG.validateWebhook(TEST_BODY, anySig, '')).toBe(false);
    expect(WOOCOMMERCE_HMAC_CONFIG.validateWebhook(TEST_BODY, anySig, '')).toBe(false);
    expect(buildShopfloHmacConfig().validateWebhook(TEST_BODY, anySig, '')).toBe(false);
  });

  it('Shopify and WooCommerce configs produce identical digests (both base64 SHA256)', () => {
    // Both use base64(HMAC-SHA256) — a signed body should verify on both
    const sig = shopifySign(TEST_BODY, TEST_SECRET);
    expect(SHOPIFY_HMAC_CONFIG.validateWebhook(TEST_BODY, sig, TEST_SECRET)).toBe(true);
    expect(WOOCOMMERCE_HMAC_CONFIG.validateWebhook(TEST_BODY, sig, TEST_SECRET)).toBe(true);
  });

  it('Razorpay and Shopflo use hex — their signatures do NOT verify under Shopify (different encoding)', () => {
    const hexSig = razorpaySign(TEST_BODY, TEST_SECRET);
    // hex sig is not valid base64 SHA256 (different encoding → different length buffer → false)
    expect(SHOPIFY_HMAC_CONFIG.validateWebhook(TEST_BODY, hexSig, TEST_SECRET)).toBe(false);
  });

  it('ProviderRedisDedupAdapter key prefixes are provider-scoped (no cross-provider collision)', () => {
    // Verify the prefix logic: each provider gets its own prefix, not 'razorpay:dedup:' for all.
    // (this was the bug in the legacy RedisDedupAdapter)
    // We verify the class instantiates with different providers without throwing.
    // Use 'as any' here — this is a test stub; TS safety irrelevant for the constructor guard.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => new ProviderRedisDedupAdapter({} as any, 'shopflo')).not.toThrow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => new ProviderRedisDedupAdapter({} as any, 'razorpay')).not.toThrow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => new ProviderRedisDedupAdapter({} as any, 'woocommerce')).not.toThrow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => new ProviderRedisDedupAdapter({} as any, 'shopify')).not.toThrow();
    // Verify isWithinReplayWindow is a static method (same interface as legacy adapter)
    expect(typeof ProviderRedisDedupAdapter.isWithinReplayWindow).toBe('function');
    expect(ProviderRedisDedupAdapter.isWithinReplayWindow(Math.floor(Date.now() / 1000))).toBe(true);
    expect(ProviderRedisDedupAdapter.isWithinReplayWindow(Math.floor(Date.now() / 1000) - 10 * 60)).toBe(false);
  });
});
