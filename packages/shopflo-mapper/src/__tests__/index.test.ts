/**
 * @brain/shopflo-mapper — unit tests.
 *
 * UT-1: moneyToMinorString — decimal/number → BIGINT-as-string minor units (I-S07, no float)
 * UT-2: mapShopfloCheckoutAbandoned — raw email/phone NEVER in output; only hashes (I-S02)
 * UT-3: email/phone hashes are per-brand distinct (salt isolation)
 * UT-4: has_address flag for addressless checkouts (research finding 8)
 * UT-5: uuidV5FromShopfloCheckout — deterministic + replay-stable + distinct namespace
 * UT-6: data_source stamped ('real' default; 'synthetic' when requested) — DEV-HONESTY
 * UT-7: line_items mapped to minor units; brand from caller never payload (MT-1)
 */

import { describe, it, expect } from 'vitest';
import {
  moneyToMinorString,
  mapShopfloCheckoutAbandoned,
  uuidV5FromShopfloCheckout,
  SHOPFLO_CHECKOUT_ABANDONED_V1_EVENT_NAME,
  type ShopfloCheckoutAbandonedPayload,
} from '../index.js';

const BRAND_A = 'c07ec701-0a00-4a00-8a00-000000000001';
const BRAND_B = 'c07ec702-0b00-4b00-8b00-000000000002';
const SALT_A = 'a'.repeat(64);
const SALT_B = 'b'.repeat(64);

const PAYLOAD: ShopfloCheckoutAbandonedPayload = {
  event_name: 'checkout_abandoned',
  checkout_id: 'chk_0001',
  cart_token: 'cart_0001',
  customer: { uid: 'cust_1', email: 'Buyer@Example.com', phone: '+917777777777', marketing_consent: true },
  shipping_address: { city: 'Bengaluru', pincode: '560001' },
  line_items: [
    { id: 'li_1', title: 'Tee', quantity: 1, price: 55 },
    { id: 'li_2', title: 'Cap', quantity: 2, price: 5 },
  ],
  subtotal_price: 65,
  total_discount: 0,
  total_shipping: 0,
  total_tax: 9.92,
  total_price: 65,
  currency: 'INR',
  created_at: '2026-06-10T12:00:00Z',
};

describe('UT-1: moneyToMinorString (I-S07, no float)', () => {
  it('converts integers and decimals to minor units', () => {
    expect(moneyToMinorString(65)).toBe('6500');
    expect(moneyToMinorString('65')).toBe('6500');
    expect(moneyToMinorString(9.92)).toBe('992');
    expect(moneyToMinorString('29.5')).toBe('2950');
    expect(moneyToMinorString(0)).toBe('0');
    expect(moneyToMinorString(null)).toBe('0');
    expect(moneyToMinorString(undefined)).toBe('0');
  });
  it('rejects invalid money (>2 decimals / negative / non-numeric)', () => {
    expect(() => moneyToMinorString('1.234')).toThrow(/I-S07/);
    expect(() => moneyToMinorString('-5')).toThrow(/I-S07/);
    expect(() => moneyToMinorString('abc')).toThrow(/I-S07/);
  });
});

describe('UT-2/UT-3: PII hashed at boundary; per-brand distinct', () => {
  it('raw email/phone NEVER appear in output; only 64-hex hashes', () => {
    const ev = mapShopfloCheckoutAbandoned(PAYLOAD, BRAND_A, SALT_A);
    const json = JSON.stringify(ev);
    expect(json).not.toContain('Buyer@Example.com');
    expect(json).not.toContain('buyer@example.com');
    expect(json).not.toContain('+917777777777');
    expect(ev.properties.customer_email_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(ev.properties.customer_phone_hash).toMatch(/^[0-9a-f]{64}$/);
  });
  it('different salts → different hashes (brand isolation)', () => {
    const a = mapShopfloCheckoutAbandoned(PAYLOAD, BRAND_A, SALT_A);
    const b = mapShopfloCheckoutAbandoned(PAYLOAD, BRAND_B, SALT_B);
    expect(a.properties.customer_email_hash).not.toBe(b.properties.customer_email_hash);
    expect(a.properties.customer_phone_hash).not.toBe(b.properties.customer_phone_hash);
  });
});

describe('UT-4: has_address flag', () => {
  it('true when shipping/billing address present', () => {
    expect(mapShopfloCheckoutAbandoned(PAYLOAD, BRAND_A, SALT_A).properties.has_address).toBe(true);
  });
  it('false for addressless checkout (email:null tolerated)', () => {
    const addressless: ShopfloCheckoutAbandonedPayload = {
      ...PAYLOAD, checkout_id: 'chk_0002', shipping_address: null, billing_address: null,
      customer: { uid: 'c2', email: null, phone: '+918888888888', marketing_consent: false },
    };
    const ev = mapShopfloCheckoutAbandoned(addressless, BRAND_A, SALT_A);
    expect(ev.properties.has_address).toBe(false);
    expect(ev.properties.customer_email_hash).toBeNull();
    expect(ev.properties.customer_phone_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('UT-5: uuidV5FromShopfloCheckout', () => {
  it('deterministic + replay-stable + distinct per (brand,checkout,occurred_at)', () => {
    const id1 = uuidV5FromShopfloCheckout(BRAND_A, 'chk_0001', '2026-06-10T12:00:00.000Z');
    const id2 = uuidV5FromShopfloCheckout(BRAND_A, 'chk_0001', '2026-06-10T12:00:00.000Z');
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(uuidV5FromShopfloCheckout(BRAND_B, 'chk_0001', '2026-06-10T12:00:00.000Z')).not.toBe(id1);
    expect(uuidV5FromShopfloCheckout(BRAND_A, 'chk_0002', '2026-06-10T12:00:00.000Z')).not.toBe(id1);
  });
});

describe('UT-6/UT-7: money minor units, data_source, event shape', () => {
  it('maps all money to minor units + currency + line items', () => {
    const ev = mapShopfloCheckoutAbandoned(PAYLOAD, BRAND_A, SALT_A);
    expect(ev.event_name).toBe(SHOPFLO_CHECKOUT_ABANDONED_V1_EVENT_NAME);
    expect(ev.properties.subtotal_minor).toBe('6500');
    expect(ev.properties.total_tax_minor).toBe('992');
    expect(ev.properties.total_price_minor).toBe('6500');
    expect(ev.properties.currency_code).toBe('INR');
    expect(ev.properties.line_items).toHaveLength(2);
    expect(ev.properties.line_items[0]!.price_minor).toBe('5500');
    expect(ev.properties.line_items[1]!.quantity).toBe(2);
  });
  it('data_source defaults real; synthetic when requested (DEV-HONESTY)', () => {
    expect(mapShopfloCheckoutAbandoned(PAYLOAD, BRAND_A, SALT_A).properties.data_source).toBe('real');
    expect(mapShopfloCheckoutAbandoned(PAYLOAD, BRAND_A, SALT_A, 'IN', 'synthetic').properties.data_source).toBe('synthetic');
  });
});
