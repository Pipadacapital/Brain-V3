/**
 * WooCommerceHmac — UT: base64 HMAC-SHA256 verification (the documented WooCommerce scheme),
 * the gating security operation (NN-4). Valid signature passes; tampered body / wrong secret /
 * missing / malformed all fail closed.
 */
import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { WooCommerceHmac, WOOCOMMERCE_SIG_HEADER } from './WooCommerceHmac.js';

const SECRET = 'wc_webhook_secret_123';
const body = Buffer.from(JSON.stringify({ id: 4001, status: 'processing', total: '1250.00' }));
const validSig = createHmac('sha256', SECRET).update(body).digest('base64');

describe('WooCommerceHmac.validateWebhook', () => {
  it('accepts a correct base64 HMAC-SHA256 signature', () => {
    expect(WooCommerceHmac.validateWebhook(body, validSig, SECRET)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const tampered = Buffer.from(JSON.stringify({ id: 4001, status: 'processing', total: '9999.00' }));
    expect(WooCommerceHmac.validateWebhook(tampered, validSig, SECRET)).toBe(false);
  });

  it('rejects a wrong secret', () => {
    expect(WooCommerceHmac.validateWebhook(body, validSig, 'wrong_secret')).toBe(false);
  });

  it('rejects missing signature / missing secret', () => {
    expect(WooCommerceHmac.validateWebhook(body, '', SECRET)).toBe(false);
    expect(WooCommerceHmac.validateWebhook(body, validSig, '')).toBe(false);
  });

  it('rejects a malformed (non-base64-length) signature without throwing', () => {
    expect(WooCommerceHmac.validateWebhook(body, 'not-a-real-sig', SECRET)).toBe(false);
  });

  it('uses the fixed WooCommerce header name', () => {
    expect(WooCommerceHmac.signatureHeaderName()).toBe(WOOCOMMERCE_SIG_HEADER);
    expect(WOOCOMMERCE_SIG_HEADER).toBe('x-wc-webhook-signature');
  });
});
