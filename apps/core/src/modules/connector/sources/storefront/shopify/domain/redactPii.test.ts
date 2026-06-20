/**
 * redactPii.test.ts — proves the raw-archive redactor is structure-preserving + PII-safe (I-S02).
 */
import { describe, it, expect } from 'vitest';
import { redactShopifyPii, REDACTION_TOKEN } from './redactPii.js';

// A representative raw Shopify orders/create body shape.
const RAW_ORDER = {
  id: 7697253892327,
  name: '#1001',
  created_at: '2026-06-19T23:23:18Z',
  updated_at: '2026-06-19T23:23:18Z',
  currency: 'INR',
  current_total_price: '831.25',
  financial_status: 'paid',
  email: 'shopper@example.com',
  phone: '+919812345678',
  customer: {
    id: 9928842641639,
    email: 'shopper@example.com',
    phone: '+919812345678',
    first_name: 'Asha',
    last_name: 'Rao',
    default_address: { name: 'Asha Rao', address1: '12 MG Road', city: 'Pune', zip: '411001' },
  },
  shipping_address: { name: 'Asha Rao', address1: '12 MG Road', city: 'Pune', zip: '411001', province_code: 'MH' },
  note_attributes: [{ name: 'brain_anon_id', value: 'anon-123' }],
};

describe('redactShopifyPii', () => {
  it('masks PII leaf values', () => {
    const out = redactShopifyPii(RAW_ORDER) as Record<string, any>;
    expect(out.email).toBe(REDACTION_TOKEN);
    expect(out.phone).toBe(REDACTION_TOKEN);
    expect(out.customer.email).toBe(REDACTION_TOKEN);
    expect(out.customer.phone).toBe(REDACTION_TOKEN);
    expect(out.customer.first_name).toBe(REDACTION_TOKEN);
    expect(out.customer.last_name).toBe(REDACTION_TOKEN);
    expect(out.customer.default_address.address1).toBe(REDACTION_TOKEN);
    expect(out.customer.default_address.zip).toBe(REDACTION_TOKEN);
    expect(out.shipping_address.address1).toBe(REDACTION_TOKEN);
    // full name inside an address container is PII
    expect(out.shipping_address.name).toBe(REDACTION_TOKEN);
    expect(out.customer.default_address.name).toBe(REDACTION_TOKEN);
  });

  it('preserves structure and non-PII values', () => {
    const out = redactShopifyPii(RAW_ORDER) as Record<string, any>;
    expect(out.id).toBe(7697253892327);
    expect(out.name).toBe('#1001'); // top-level order number is NOT an address name → kept
    expect(out.currency).toBe('INR');
    expect(out.current_total_price).toBe('831.25');
    expect(out.financial_status).toBe('paid');
    expect(out.shipping_address.city).toBe('Pune'); // coarse, kept
    expect(out.shipping_address.province_code).toBe('MH');
    expect(out.customer.id).toBe(9928842641639);
    // every original key is still present
    expect(Object.keys(out.customer).sort()).toEqual(
      ['default_address', 'email', 'first_name', 'id', 'last_name', 'phone'].sort(),
    );
  });

  it('handles arrays and keeps note_attributes shape', () => {
    const out = redactShopifyPii(RAW_ORDER) as Record<string, any>;
    expect(Array.isArray(out.note_attributes)).toBe(true);
    expect(out.note_attributes[0]).toEqual({ name: 'brain_anon_id', value: 'anon-123' });
  });

  it('keeps null/empty PII fields visible (not tokenised)', () => {
    const out = redactShopifyPii({ email: null, phone: '', customer: null }) as Record<string, any>;
    expect(out.email).toBeNull();
    expect(out.phone).toBe(REDACTION_TOKEN); // empty string is still a present value → masked
    expect(out.customer).toBeNull();
  });

  it('does not mutate the input', () => {
    const input = { email: 'a@b.com', customer: { phone: '+91' } };
    redactShopifyPii(input);
    expect(input.email).toBe('a@b.com');
    expect(input.customer.phone).toBe('+91');
  });
});
