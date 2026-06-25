/**
 * marketplace-view.credential-fields.test.ts — unit tests for the connect-form field helpers.
 *
 * The server catalog (apps/core catalog/registry.ts) is the SINGLE source of truth for a
 * connector's connect-form fields. These tests prove the client helpers honour that:
 *   - authFieldsToCredentialFields maps the server-supplied auth_fields (the ONLY path) faithfully:
 *     keys/labels/secret/optional preserved, masked placeholder for secrets, url placeholder for url,
 *     hint carried (and omitted when null).
 *   - credentialFieldsFor() is now a NO-FALLBACK shim: it returns [] for ANY id, including ones that
 *     used to fall through to Razorpay's fields. This is the fix for the bug where a field-less OAuth
 *     tile (e.g. GA4) rendered another connector's (Razorpay's) credential form.
 */

import { describe, it, expect } from 'vitest';
import { credentialFieldsFor, authFieldsToCredentialFields } from './credential-fields';
import type { ConnectorAuthFieldDto } from '@/lib/api/types';

describe('credentialFieldsFor — no cross-connector fallback (SoR = server catalog)', () => {
  it('returns an empty set for a known credential connector (no hardcoded duplicate)', () => {
    expect(credentialFieldsFor('woocommerce')).toEqual([]);
    expect(credentialFieldsFor('razorpay')).toEqual([]);
    expect(credentialFieldsFor('shiprocket')).toEqual([]);
  });

  it('NEVER falls through to another connector — an unknown/field-less id yields []', () => {
    // Regression: GA4 / unknown providers used to render Razorpay's key_id field.
    expect(credentialFieldsFor('ga4')).toEqual([]);
    expect(credentialFieldsFor('some-unknown-provider')).toEqual([]);
    expect(credentialFieldsFor('ga4').map((f) => f.key)).not.toContain('key_id');
  });
});

describe('authFieldsToCredentialFields — the server-driven (only) path', () => {
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
