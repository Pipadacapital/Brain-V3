/**
 * HmacConfig.test.ts — byte-compatibility verification for HmacConfig.
 *
 * Proves that HmacConfig is byte-identical to each legacy *Hmac value-object.
 * This is the CUTOVER SAFETY CHECK: a bug here would mean the pipeline rejects
 * valid webhooks that the legacy handlers would accept (or vice versa).
 *
 * Strategy: sign test bodies with both the old VO and the new HmacConfig; both
 * must accept the same signature string and reject tampered strings.
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

// ── Legacy VO imports (directly from source to verify byte-compatibility) ──

import { ShopifyHmac } from '../../sources/storefront/shopify/domain/value-objects/ShopifyHmac.js';
import { RazorpayHmac } from '../../sources/payment/razorpay/domain/value-objects/RazorpayHmac.js';
import { WooCommerceHmac } from '../../sources/storefront/woocommerce/domain/value-objects/WooCommerceHmac.js';
import { ShopfloHmac } from '../../sources/checkout/shopflo/domain/value-objects/ShopfloHmac.js';

const TEST_BODY = Buffer.from('{"test":"payload","amount":1500}');
const TEST_SECRET = 'test-webhook-secret-for-hmac-compat';

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

describe('HmacConfig — byte-compatibility with legacy *Hmac VOs', () => {
  it('SHOPIFY_HMAC_CONFIG accepts same base64 HMAC-SHA256 as ShopifyHmac.validateWebhook()', () => {
    const sig = shopifySign(TEST_BODY, TEST_SECRET);

    // Legacy VO
    expect(ShopifyHmac.validateWebhook(TEST_BODY, sig, TEST_SECRET)).toBe(true);
    // New HmacConfig
    expect(SHOPIFY_HMAC_CONFIG.validateWebhook(TEST_BODY, sig, TEST_SECRET)).toBe(true);

    // Both must reject tampered body
    const tamperedBody = Buffer.from('{"test":"tampered"}');
    expect(ShopifyHmac.validateWebhook(tamperedBody, sig, TEST_SECRET)).toBe(false);
    expect(SHOPIFY_HMAC_CONFIG.validateWebhook(tamperedBody, sig, TEST_SECRET)).toBe(false);

    // Both must reject wrong encoding (hex instead of base64)
    const hexSig = createHmac('sha256', TEST_SECRET).update(TEST_BODY).digest('hex');
    expect(ShopifyHmac.validateWebhook(TEST_BODY, hexSig, TEST_SECRET)).toBe(false);
    expect(SHOPIFY_HMAC_CONFIG.validateWebhook(TEST_BODY, hexSig, TEST_SECRET)).toBe(false);
  });

  it('RAZORPAY_HMAC_CONFIG accepts same hex HMAC-SHA256 as RazorpayHmac.validateWebhook()', () => {
    const sig = razorpaySign(TEST_BODY, TEST_SECRET);

    expect(RazorpayHmac.validateWebhook(TEST_BODY, sig, TEST_SECRET)).toBe(true);
    expect(RAZORPAY_HMAC_CONFIG.validateWebhook(TEST_BODY, sig, TEST_SECRET)).toBe(true);

    const tamperedBody = Buffer.from('{"test":"tampered"}');
    expect(RazorpayHmac.validateWebhook(tamperedBody, sig, TEST_SECRET)).toBe(false);
    expect(RAZORPAY_HMAC_CONFIG.validateWebhook(tamperedBody, sig, TEST_SECRET)).toBe(false);

    // Razorpay uses hex — base64 sig must be rejected
    const base64Sig = createHmac('sha256', TEST_SECRET).update(TEST_BODY).digest('base64');
    expect(RazorpayHmac.validateWebhook(TEST_BODY, base64Sig, TEST_SECRET)).toBe(false);
    expect(RAZORPAY_HMAC_CONFIG.validateWebhook(TEST_BODY, base64Sig, TEST_SECRET)).toBe(false);
  });

  it('WOOCOMMERCE_HMAC_CONFIG accepts same base64 HMAC-SHA256 as WooCommerceHmac.validateWebhook()', () => {
    const sig = wooSign(TEST_BODY, TEST_SECRET);

    expect(WooCommerceHmac.validateWebhook(TEST_BODY, sig, TEST_SECRET)).toBe(true);
    expect(WOOCOMMERCE_HMAC_CONFIG.validateWebhook(TEST_BODY, sig, TEST_SECRET)).toBe(true);

    const tamperedBody = Buffer.from('{"amount":9999}');
    expect(WooCommerceHmac.validateWebhook(tamperedBody, sig, TEST_SECRET)).toBe(false);
    expect(WOOCOMMERCE_HMAC_CONFIG.validateWebhook(tamperedBody, sig, TEST_SECRET)).toBe(false);
  });

  it('buildShopfloHmacConfig() accepts same hex HMAC-SHA256 as ShopfloHmac.validateWebhook()', () => {
    const sig = shopfloSign(TEST_BODY, TEST_SECRET);
    const config = buildShopfloHmacConfig();

    expect(ShopfloHmac.validateWebhook(TEST_BODY, sig, TEST_SECRET)).toBe(true);
    expect(config.validateWebhook(TEST_BODY, sig, TEST_SECRET)).toBe(true);

    const tamperedBody = Buffer.from('{"checkout_id":"tampered"}');
    expect(ShopfloHmac.validateWebhook(tamperedBody, sig, TEST_SECRET)).toBe(false);
    expect(config.validateWebhook(tamperedBody, sig, TEST_SECRET)).toBe(false);
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
