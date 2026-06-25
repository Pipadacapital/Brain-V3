/**
 * credential-schema.test.ts — planCredentialConnect drives the unified credential connect path.
 *
 * These assertions PIN the secret-bundle / provider_config / column shape each connector produced
 * before the unification, so the migration cannot silently change what the repull jobs, token
 * providers and webhook receivers read back. Each case is built from the REAL catalog entry
 * (authFields + credentialConnect) — not a hand-rolled spec — so registry drift fails here.
 */
import { describe, it, expect } from 'vitest';
import { getDefinition } from './catalog/index.js';
import { planCredentialConnect, splitConnectorCredentials } from './credential-schema.js';

function planFor(type: string, values: Record<string, string | undefined>) {
  const def = getDefinition(type)!;
  expect(def, `catalog has ${type}`).toBeTruthy();
  expect(def.authFields, `${type} has authFields`).toBeTruthy();
  expect(def.credentialConnect, `${type} has credentialConnect`).toBeTruthy();
  return planCredentialConnect(def.authFields!, def.credentialConnect!, values);
}

describe('planCredentialConnect — razorpay', () => {
  const values = { key_id: 'rzp_k', key_secret: 'rzp_s', webhook_secret: 'whsec', razorpay_account_id: 'acc_1' };

  it('bundle = {key_id, key_secret, webhook_secret} (key_id rides along for the settlement client)', () => {
    const plan = planFor('razorpay', values);
    expect(plan.secretBundle).toEqual({ key_id: 'rzp_k', key_secret: 'rzp_s', webhook_secret: 'whsec' });
  });
  it('routing: account_id → column + provider_config + accountKey', () => {
    const plan = planFor('razorpay', values);
    expect(plan.accountKey).toBe('acc_1');
    expect(plan.providerConfig).toEqual({ razorpay_account_id: 'acc_1' });
    expect(plan.instanceColumnUpdate).toEqual({ column: 'razorpay_account_id', value: 'acc_1' });
    expect(plan.shopDomain).toBe('');
    expect(plan.missingRequired).toEqual([]);
  });
  it('webhook_secret is REQUIRED (missing → reported)', () => {
    const plan = planFor('razorpay', { ...values, webhook_secret: '' });
    expect(plan.missingRequired).toContain('webhook_secret');
  });
});

describe('planCredentialConnect — gokwik', () => {
  it('bundle keeps appid (AWB client reads it from the bundle); column gokwik_appid', () => {
    const plan = planFor('gokwik', { appid: 'app_1', appsecret: 'sec', webhook_secret: 'wh' });
    expect(plan.secretBundle).toEqual({ appid: 'app_1', appsecret: 'sec', webhook_secret: 'wh' });
    expect(plan.providerConfig).toEqual({ gokwik_appid: 'app_1' });
    expect(plan.instanceColumnUpdate).toEqual({ column: 'gokwik_appid', value: 'app_1' });
    expect(plan.accountKey).toBe('app_1');
  });
  it('webhook_secret is optional (omitted when blank)', () => {
    const plan = planFor('gokwik', { appid: 'app_1', appsecret: 'sec' });
    expect(plan.secretBundle).toEqual({ appid: 'app_1', appsecret: 'sec' });
    expect(plan.missingRequired).toEqual([]);
  });
});

describe('planCredentialConnect — shopflo', () => {
  it('merchant_id is routing-only — NOT in the bundle (webhook reads it from the column)', () => {
    const plan = planFor('shopflo', { api_token: 'tok', merchant_id: 'm_1', webhook_secret: 'wh' });
    expect(plan.secretBundle).toEqual({ api_token: 'tok', webhook_secret: 'wh' });
    expect(plan.secretBundle).not.toHaveProperty('merchant_id');
    expect(plan.providerConfig).toEqual({ shopflo_merchant_id: 'm_1' });
    expect(plan.instanceColumnUpdate).toEqual({ column: 'shopflo_merchant_id', value: 'm_1' });
  });
});

describe('planCredentialConnect — shiprocket', () => {
  it('email rides in the bundle; channel_id (when given) is the routing key', () => {
    const plan = planFor('shiprocket', { email: 'a@b.co', password: 'pw', channel_id: 'ch_1' });
    expect(plan.secretBundle).toEqual({ email: 'a@b.co', password: 'pw' });
    expect(plan.accountKey).toBe('ch_1');
    expect(plan.providerConfig).toEqual({ shiprocket_channel_id: 'ch_1' });
    expect(plan.instanceColumnUpdate).toEqual({ column: 'shiprocket_channel_id', value: 'ch_1' });
  });
  it('no channel_id → sub-key falls back to email, no column/provider_config written', () => {
    const plan = planFor('shiprocket', { email: 'a@b.co', password: 'pw' });
    expect(plan.accountKey).toBe('a@b.co');
    expect(plan.providerConfig).toEqual({});
    expect(plan.instanceColumnUpdate).toBeNull();
    expect(plan.missingRequired).toEqual([]);
  });
});

describe('planCredentialConnect — woocommerce', () => {
  it('site_url → shop_domain + column; bundle = consumer key/secret (+ optional webhook)', () => {
    const plan = planFor('woocommerce', {
      site_url: 'https://store.example.com',
      consumer_key: 'ck',
      consumer_secret: 'cs',
      webhook_secret: 'wh',
    });
    expect(plan.secretBundle).toEqual({ consumer_key: 'ck', consumer_secret: 'cs', webhook_secret: 'wh' });
    expect(plan.shopDomain).toBe('https://store.example.com');
    expect(plan.providerConfig).toEqual({ woocommerce_site_url: 'https://store.example.com' });
    expect(plan.instanceColumnUpdate).toEqual({ column: 'woocommerce_site_url', value: 'https://store.example.com' });
  });
  it('omitting an optional webhook_secret is valid and leaves it out of the bundle', () => {
    const plan = planFor('woocommerce', { site_url: 'https://s.co', consumer_key: 'ck', consumer_secret: 'cs' });
    expect(plan.secretBundle).toEqual({ consumer_key: 'ck', consumer_secret: 'cs' });
    expect(plan.missingRequired).toEqual([]);
  });
  it('missing a required secret is reported', () => {
    const plan = planFor('woocommerce', { site_url: 'https://s.co', consumer_key: 'ck' });
    expect(plan.missingRequired).toContain('consumer_secret');
  });
});

describe('splitConnectorCredentials — trims + drops blanks, schema is authoritative', () => {
  it('ignores unknown keys and blank values', () => {
    const fields = [
      { key: 'a', label: 'A', type: 'text' as const, secret: false },
      { key: 'b', label: 'B', type: 'password' as const, secret: true },
    ];
    const { secrets, config } = splitConnectorCredentials(fields, { a: '  x ', b: '', c: 'ignored' });
    expect(config).toEqual({ a: 'x' });
    expect(secrets).toEqual({});
  });
});
