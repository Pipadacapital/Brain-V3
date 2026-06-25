/**
 * marketplace-view.credential-fields.test.ts — unit tests for the connect-form field helpers.
 *
 * Proves:
 *   - the hardcoded fallback sets stay aligned with the server catalog (woo now carries the secret
 *     consumer_key + optional webhook_secret; shiprocket has its own set — no Razorpay fallback).
 *   - secret fields are marked secret=true (type="password", never echoed).
 *   - authFieldsToCredentialFields maps the server-supplied auth_fields (the PRIMARY path) faithfully.
 *   - Unknown providers fall through to the RAZORPAY_FIELDS default (no regression).
 */

import { describe, it, expect } from 'vitest';
import { credentialFieldsFor, authFieldsToCredentialFields } from './credential-fields';
import type { ConnectorAuthFieldDto } from '@/lib/api/types';

describe('credentialFieldsFor — woocommerce (catalog-aligned fallback)', () => {
  it('returns site_url, consumer_key, consumer_secret, webhook_secret', () => {
    const keys = credentialFieldsFor('woocommerce').map((f) => f.key);
    expect(keys).toEqual(['site_url', 'consumer_key', 'consumer_secret', 'webhook_secret']);
  });

  it('site_url is a non-secret identifier', () => {
    const f = credentialFieldsFor('woocommerce').find((x) => x.key === 'site_url')!;
    expect(f.secret).toBe(false);
  });

  it('consumer_key and consumer_secret are SECRET (type=password, never echoed)', () => {
    const fields = credentialFieldsFor('woocommerce');
    expect(fields.find((f) => f.key === 'consumer_key')!.secret).toBe(true);
    expect(fields.find((f) => f.key === 'consumer_secret')!.secret).toBe(true);
  });

  it('webhook_secret is optional', () => {
    const f = credentialFieldsFor('woocommerce').find((x) => x.key === 'webhook_secret')!;
    expect(f.optional).toBe(true);
  });

  it('field keys are unique', () => {
    const keys = credentialFieldsFor('woocommerce').map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('credentialFieldsFor — other providers (regression)', () => {
  it('shopflo: api_token, merchant_id, webhook_secret', () => {
    const keys = credentialFieldsFor('shopflo').map((f) => f.key);
    expect(keys).toContain('api_token');
    expect(keys).toContain('merchant_id');
    expect(keys).toContain('webhook_secret');
  });

  it('gokwik: appid and appsecret', () => {
    const keys = credentialFieldsFor('gokwik').map((f) => f.key);
    expect(keys).toContain('appid');
    expect(keys).toContain('appsecret');
  });

  it('shiprocket: email, password, channel_id — NOT the Razorpay fallback', () => {
    const fields = credentialFieldsFor('shiprocket');
    const keys = fields.map((f) => f.key);
    expect(keys).toEqual(['email', 'password', 'channel_id']);
    expect(keys).not.toContain('key_id'); // regression: was falling through to Razorpay
    expect(fields.find((f) => f.key === 'password')!.secret).toBe(true);
    expect(fields.find((f) => f.key === 'channel_id')!.optional).toBe(true);
  });

  it('razorpay (default): key_id, key_secret, webhook_secret, razorpay_account_id', () => {
    const keys = credentialFieldsFor('razorpay').map((f) => f.key);
    expect(keys).toEqual(['key_id', 'key_secret', 'webhook_secret', 'razorpay_account_id']);
  });

  it('unknown provider falls through to razorpay default', () => {
    expect(credentialFieldsFor('some-unknown-provider').map((f) => f.key)).toContain('key_id');
  });
});

describe('authFieldsToCredentialFields — the server-driven PRIMARY path', () => {
  const dtos: ConnectorAuthFieldDto[] = [
    { key: 'site_url', label: 'Store URL', type: 'url', secret: false, optional: false, hint: null },
    { key: 'consumer_secret', label: 'Consumer Secret', type: 'password', secret: true, optional: false, hint: null },
    { key: 'webhook_secret', label: 'Webhook Secret', type: 'password', secret: true, optional: true, hint: 'From WooCommerce settings' },
  ];

  it('preserves key/label/secret/optional and carries the hint', () => {
    const fields = authFieldsToCredentialFields(dtos);
    expect(fields.map((f) => f.key)).toEqual(['site_url', 'consumer_secret', 'webhook_secret']);
    expect(fields[1].secret).toBe(true);
    expect(fields[2].optional).toBe(true);
    expect(fields[2].hint).toBe('From WooCommerce settings');
  });

  it('derives a masked placeholder for secrets and a url placeholder for url fields', () => {
    const fields = authFieldsToCredentialFields(dtos);
    expect(fields[0].placeholder).toMatch(/^https:\/\//); // url type
    expect(fields[1].placeholder).toBe('••••••••••••'); // secret
  });

  it('omits hint when the server sends null (no empty note rendered)', () => {
    const fields = authFieldsToCredentialFields(dtos);
    expect(fields[0].hint).toBeUndefined();
  });
});
