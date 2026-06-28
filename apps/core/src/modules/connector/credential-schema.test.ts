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
import { planCredentialConnect, splitConnectorCredentials, provisionGeneratedSecrets } from './credential-schema.js';

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
  it('site_url → shop_domain + column AND rides in the bundle (repull/pixel read it from there)', () => {
    const plan = planFor('woocommerce', {
      site_url: 'https://store.example.com',
      consumer_key: 'ck',
      consumer_secret: 'cs',
      webhook_secret: 'wh',
    });
    expect(plan.secretBundle).toEqual({
      consumer_key: 'ck',
      consumer_secret: 'cs',
      webhook_secret: 'wh',
      site_url: 'https://store.example.com',
    });
    expect(plan.shopDomain).toBe('https://store.example.com');
    expect(plan.providerConfig).toEqual({ woocommerce_site_url: 'https://store.example.com' });
    expect(plan.instanceColumnUpdate).toEqual({ column: 'woocommerce_site_url', value: 'https://store.example.com' });
  });
  it('omitting an optional webhook_secret is valid and leaves it out of the bundle (site_url stays)', () => {
    const plan = planFor('woocommerce', { site_url: 'https://s.co', consumer_key: 'ck', consumer_secret: 'cs' });
    expect(plan.secretBundle).toEqual({ consumer_key: 'ck', consumer_secret: 'cs', site_url: 'https://s.co' });
    expect(plan.missingRequired).toEqual([]);
  });
  it('missing a required secret is reported', () => {
    const plan = planFor('woocommerce', { site_url: 'https://s.co', consumer_key: 'ck' });
    expect(plan.missingRequired).toContain('consumer_secret');
  });
});

/**
 * Command-parity pins — each bespoke Connect command (ConnectRazorpay/Woo/Shopflo/Gokwik) now
 * derives its storeSecret bundle from planCredentialConnect(def.authFields, def.credentialConnect, …).
 * These assertions PIN the resulting bundle equals exactly what each command previously hard-coded,
 * so the single-SoR split can never silently drift from what the repull jobs / webhook receivers read.
 */
describe('bespoke-command bundle parity (storeSecret payload === plan.secretBundle)', () => {
  it('razorpay bundle === { key_id, key_secret, webhook_secret } (no razorpay_account_id)', () => {
    const plan = planFor('razorpay', {
      key_id: 'rzp_k',
      key_secret: 'rzp_s',
      webhook_secret: 'whsec',
      razorpay_account_id: 'acc_1',
    });
    expect(plan.secretBundle).toEqual({ key_id: 'rzp_k', key_secret: 'rzp_s', webhook_secret: 'whsec' });
    expect(plan.secretBundle).not.toHaveProperty('razorpay_account_id');
  });

  it('woocommerce bundle === { consumer_key, consumer_secret, webhook_secret, site_url }', () => {
    const plan = planFor('woocommerce', {
      site_url: 'https://store.example.com',
      consumer_key: 'ck',
      consumer_secret: 'cs',
      webhook_secret: 'generated_wh',
    });
    expect(plan.secretBundle).toEqual({
      consumer_key: 'ck',
      consumer_secret: 'cs',
      webhook_secret: 'generated_wh',
      site_url: 'https://store.example.com',
    });
  });

  it('shopflo bundle === { api_token, webhook_secret } (merchant_id is routing-only)', () => {
    const plan = planFor('shopflo', { api_token: 'tok', merchant_id: 'm_1', webhook_secret: 'wh' });
    expect(plan.secretBundle).toEqual({ api_token: 'tok', webhook_secret: 'wh' });
    expect(plan.secretBundle).not.toHaveProperty('merchant_id');
  });

  it('gokwik bundle === { appid, appsecret, webhook_secret } when webhook_secret supplied', () => {
    const plan = planFor('gokwik', { appid: 'app_1', appsecret: 'sec', webhook_secret: 'wh' });
    expect(plan.secretBundle).toEqual({ appid: 'app_1', appsecret: 'sec', webhook_secret: 'wh' });
  });

  it('gokwik bundle === { appid, appsecret } when webhook_secret blank/absent (omitted)', () => {
    expect(planFor('gokwik', { appid: 'app_1', appsecret: 'sec', webhook_secret: '' }).secretBundle).toEqual({
      appid: 'app_1',
      appsecret: 'sec',
    });
    expect(planFor('gokwik', { appid: 'app_1', appsecret: 'sec' }).secretBundle).toEqual({
      appid: 'app_1',
      appsecret: 'sec',
    });
  });
});

/**
 * SR-2: provisionGeneratedSecrets mints connect-time secrets (Shiprocket's webhook_secret) onto the
 * plan bundle. planCredentialConnect stays PURE (the shiprocket bundle above is still {email,password});
 * generation is layered on top and returns the minted values for the connect response.
 */
describe('provisionGeneratedSecrets — connect-time minted secrets (SR-2)', () => {
  const def = getDefinition('shiprocket')!;
  const spec = def.credentialConnect!;
  let counter = 0;
  const gen = () => `minted-${++counter}`;

  it('shiprocket spec declares webhook_secret as a generated field + the webhook routing header', () => {
    expect(spec.generatedSecretFields).toEqual(['webhook_secret']);
    expect(spec.webhookRoutingHeader).toBe('x-shiprocket-channel-id');
  });

  it('mints webhook_secret into the bundle and returns it (it is NOT a planCredentialConnect field)', () => {
    counter = 0;
    const plan = planCredentialConnect(def.authFields!, spec, { email: 'a@b.co', password: 'pw', channel_id: 'ch_1' });
    expect(plan.secretBundle).toEqual({ email: 'a@b.co', password: 'pw' }); // pure plan unchanged
    const { bundle, generated } = provisionGeneratedSecrets(plan.secretBundle, spec, gen);
    expect(generated).toEqual({ webhook_secret: 'minted-1' });
    expect(bundle).toEqual({ email: 'a@b.co', password: 'pw', webhook_secret: 'minted-1' });
  });

  it('never regenerates a user-supplied value (already present in the bundle)', () => {
    const { bundle, generated } = provisionGeneratedSecrets(
      { email: 'a@b.co', webhook_secret: 'user-set' },
      spec,
      gen,
    );
    expect(generated).toEqual({}); // nothing minted
    expect(bundle['webhook_secret']).toBe('user-set');
  });

  it('no-ops for a spec without generatedSecretFields (razorpay)', () => {
    const rzp = getDefinition('razorpay')!.credentialConnect!;
    const { bundle, generated } = provisionGeneratedSecrets({ key_id: 'k' }, rzp, gen);
    expect(generated).toEqual({});
    expect(bundle).toEqual({ key_id: 'k' });
  });
});

/**
 * #17: the SR-2 minting mechanism is GENERALIZED to GoKwik — its webhook lane is HMAC-gated and was
 * failing closed because the bundle held only {appid,appsecret} (no webhook_secret). GoKwik now mints
 * a webhook_secret at connect when the merchant leaves the optional form field blank.
 */
describe('provisionGeneratedSecrets — GoKwik webhook_secret minting (#17)', () => {
  const def = getDefinition('gokwik')!;
  const spec = def.credentialConnect!;
  let counter = 0;
  const gen = () => `gk-minted-${++counter}`;

  it('gokwik spec declares webhook_secret as a generated field + the appid routing header', () => {
    expect(spec.generatedSecretFields).toEqual(['webhook_secret']);
    expect(spec.webhookRoutingHeader).toBe('x-gokwik-appid');
  });

  it('mints webhook_secret when the merchant did not supply one (bundle had only appid/appsecret)', () => {
    counter = 0;
    const plan = planCredentialConnect(def.authFields!, spec, { appid: 'app_1', appsecret: 'sec' });
    expect(plan.secretBundle).toEqual({ appid: 'app_1', appsecret: 'sec' }); // pure plan: no webhook_secret yet
    const { bundle, generated } = provisionGeneratedSecrets(plan.secretBundle, spec, gen);
    expect(generated).toEqual({ webhook_secret: 'gk-minted-1' });
    expect(bundle).toEqual({ appid: 'app_1', appsecret: 'sec', webhook_secret: 'gk-minted-1' });
  });

  it('honours a merchant-supplied webhook_secret (never regenerated)', () => {
    const plan = planCredentialConnect(def.authFields!, spec, { appid: 'app_1', appsecret: 'sec', webhook_secret: 'gk-user' });
    const { bundle, generated } = provisionGeneratedSecrets(plan.secretBundle, spec, gen);
    expect(generated).toEqual({});
    expect(bundle['webhook_secret']).toBe('gk-user');
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
