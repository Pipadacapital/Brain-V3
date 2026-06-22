/**
 * marketplace-view.credential-fields.test.ts — unit tests for credentialFieldsFor.
 *
 * Proves:
 *   - woocommerce returns the correct three fields: site_url, consumer_key, consumer_secret.
 *   - consumer_secret is marked secret=true (type="password", never echoed).
 *   - site_url and consumer_key are marked secret=false (visible identifiers).
 *   - Other known providers (shopflo, gokwik, razorpay) still return their correct sets.
 *   - Unknown providers fall through to the RAZORPAY_FIELDS default (no regression).
 */

import { describe, it, expect } from 'vitest';
import { credentialFieldsFor } from './credential-fields';

describe('credentialFieldsFor — woocommerce', () => {
  it('returns exactly three fields for woocommerce', () => {
    const fields = credentialFieldsFor('woocommerce');
    expect(fields).toHaveLength(3);
  });

  it('includes site_url as a non-secret field', () => {
    const fields = credentialFieldsFor('woocommerce');
    const siteUrlField = fields.find((f) => f.key === 'site_url');
    expect(siteUrlField).toBeDefined();
    expect(siteUrlField!.secret).toBe(false);
    expect(siteUrlField!.label).toBeTruthy();
  });

  it('includes consumer_key as a non-secret field', () => {
    const fields = credentialFieldsFor('woocommerce');
    const ckField = fields.find((f) => f.key === 'consumer_key');
    expect(ckField).toBeDefined();
    expect(ckField!.secret).toBe(false);
  });

  it('includes consumer_secret as a SECRET field (type=password, never echoed)', () => {
    const fields = credentialFieldsFor('woocommerce');
    const csField = fields.find((f) => f.key === 'consumer_secret');
    expect(csField).toBeDefined();
    expect(csField!.secret).toBe(true);
  });

  it('field keys are unique (no duplicate keys)', () => {
    const fields = credentialFieldsFor('woocommerce');
    const keys = fields.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('credentialFieldsFor — other providers (regression)', () => {
  it('shopflo: returns api_token, merchant_id, webhook_secret', () => {
    const fields = credentialFieldsFor('shopflo');
    const keys = fields.map((f) => f.key);
    expect(keys).toContain('api_token');
    expect(keys).toContain('merchant_id');
    expect(keys).toContain('webhook_secret');
  });

  it('gokwik: returns appid and appsecret', () => {
    const fields = credentialFieldsFor('gokwik');
    const keys = fields.map((f) => f.key);
    expect(keys).toContain('appid');
    expect(keys).toContain('appsecret');
  });

  it('razorpay (default): returns key_id, key_secret, webhook_secret, razorpay_account_id', () => {
    const fields = credentialFieldsFor('razorpay');
    const keys = fields.map((f) => f.key);
    expect(keys).toContain('key_id');
    expect(keys).toContain('key_secret');
    expect(keys).toContain('webhook_secret');
    expect(keys).toContain('razorpay_account_id');
  });

  it('unknown provider falls through to razorpay default (no regression)', () => {
    const fields = credentialFieldsFor('some-unknown-provider');
    const keys = fields.map((f) => f.key);
    expect(keys).toContain('key_id');
  });
});
