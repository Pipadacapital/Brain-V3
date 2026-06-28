/**
 * @brain/woocommerce-mapper — UT: canonical order.live.v1 emission, money (I-S07), PII boundary,
 * cancellation → cancelled_at, refunds → abs minor.
 */

import { describe, it, expect } from 'vitest';
import {
  mapWooOrderToEvent,
  decimalStringToMinor,
  uuidV5FromOrderLive,
  ORDER_LIVE_V1_EVENT_NAME,
  type WooOrderShape,
} from '../index.js';

const BRAND = '124e6af5-0000-0000-0000-000000000001';
const SALT = '8cc152f6'.repeat(8);

const baseOrder: WooOrderShape = {
  id: 1001,
  status: 'processing',
  currency: 'inr',
  total: '1250.00',
  total_tax: '190.68',
  shipping_total: '50.00',
  discount_total: '100.00',
  date_created_gmt: '2026-06-10T08:00:00',
  date_modified_gmt: '2026-06-11T09:30:00',
  payment_method: 'cod',
  payment_method_title: 'Cash on delivery',
  customer_id: 55,
  billing: { email: 'shopper@example.com', phone: '9876543210' },
  line_items: [
    { id: 1, name: 'Pink Overshirt', sku: 'PO-1', quantity: 2, price: '500.00', subtotal: '1100.00', total: '1000.00', product_id: 9, variation_id: 0 },
  ],
  tax_lines: [{ label: 'GST', rate_percent: 18, tax_total: '190.68' }],
  coupon_lines: [{ code: 'SAVE100', discount: '100.00', discount_type: 'fixed_cart' }],
};

describe('mapWooOrderToEvent', () => {
  it('emits the canonical order.live.v1 with I-S07 minor units + provenance', () => {
    const ev = mapWooOrderToEvent(baseOrder, BRAND, SALT, 'IN', 'synthetic');
    expect(ev.event_name).toBe(ORDER_LIVE_V1_EVENT_NAME);
    expect(ev.occurred_at).toBe('2026-06-11T09:30:00.000Z');
    const p = ev.properties;
    expect(p.source).toBe('woocommerce');
    expect(p.order_id).toBe('1001');
    expect(p.amount_minor).toBe('125000');         // 1250.00 → 125000, digits-only (I-S07)
    expect(/^\d+$/.test(p.amount_minor)).toBe(true);
    expect(p.currency_code).toBe('INR');
    expect(p.payment_method).toBe('cod');
    expect(p.cancelled_at).toBeNull();
    expect(p.data_source).toBe('synthetic');
    expect(p.storefront_customer_id).toBe('55');
    // PII hashed — raw email/phone never present
    expect(p.hashed_customer_email).toMatch(/^[0-9a-f]+$/);
    expect(p.hashed_customer_phone).toMatch(/^[0-9a-f]+$/);
    expect(JSON.stringify(ev)).not.toContain('shopper@example.com');
    expect(JSON.stringify(ev)).not.toContain('9876543210');
    // line items + depth
    expect(p.line_items?.[0]).toMatchObject({ sku: 'PO-1', quantity: 2, line_total_minor: '100000' });
    expect(p.discount_codes?.[0]).toMatchObject({ code: 'SAVE100', amount_minor: '10000' });
    expect(p.tax_total_minor).toBe('19068');
  });

  it('cancelled status → cancelled_at set (drives rto_reversal downstream)', () => {
    const ev = mapWooOrderToEvent({ ...baseOrder, status: 'cancelled' }, BRAND, SALT, 'IN');
    expect(ev.properties.cancelled_at).toBe(ev.occurred_at);
  });

  it('prepaid classification + refunds → abs minor, one row per refund_id', () => {
    const ev = mapWooOrderToEvent(
      {
        ...baseOrder,
        payment_method: 'razorpay',
        payment_method_title: 'Razorpay',
        refunds: [{ id: 7, reason: 'damaged', total: '-500.00', date_created: '2026-06-12T10:00:00' }],
      },
      BRAND,
      SALT,
      'IN',
    );
    expect(ev.properties.payment_method).toBe('prepaid');
    expect(ev.properties.refunds?.[0]).toMatchObject({ refund_id: '7', amount_minor: '50000', reason: 'damaged' });
    expect(ev.properties.refund_total_minor).toBe('50000');
  });

  it('throws on missing id', () => {
    expect(() => mapWooOrderToEvent({ id: '' } as WooOrderShape, BRAND, SALT, 'IN')).toThrow(/missing id/);
  });

  it('MONEY FIX: 0dp currency (JPY) total is NOT x100-inflated', () => {
    const ev = mapWooOrderToEvent(
      { id: 9, status: 'completed', currency: 'JPY', total: '12500', date_created_gmt: '2026-06-01T00:00:00' },
      BRAND,
      SALT,
      'JP',
    );
    expect(ev.properties.amount_minor).toBe('12500'); // not '1250000'
    expect(ev.properties.currency_code).toBe('JPY');
  });

  it('MONEY FIX: 3dp currency (KWD) total is NOT under-scaled', () => {
    const ev = mapWooOrderToEvent(
      { id: 10, status: 'completed', currency: 'kwd', total: '12.500', date_created_gmt: '2026-06-01T00:00:00' },
      BRAND,
      SALT,
      'KW',
    );
    expect(ev.properties.amount_minor).toBe('12500'); // 12.500 KWD → 12500 fils (not 1250)
    expect(ev.properties.currency_code).toBe('KWD');
  });

  it('MONEY FIX: fail closed on a missing currency (NO INR default)', () => {
    expect(() =>
      mapWooOrderToEvent(
        { id: 11, status: 'completed', total: '100.00', date_created_gmt: '2026-06-01T00:00:00' } as WooOrderShape,
        BRAND,
        SALT,
        'IN',
      ),
    ).toThrow(/missing currency/);
  });
});

describe('decimalStringToMinor (CURRENCY-AWARE — no hardcoded x100)', () => {
  it('2dp currency (INR): integer-only conversion', () => {
    expect(decimalStringToMinor('1250.00', 'INR')).toBe(125000n);
    expect(decimalStringToMinor('15.5', 'INR')).toBe(1550n);
    expect(decimalStringToMinor('0', 'INR')).toBe(0n);
    expect(() => decimalStringToMinor('1.234', 'INR')).toThrow();
  });

  it('0dp currency (JPY): NO x100 — 1000 yen → 1000 minor (not 100000)', () => {
    expect(decimalStringToMinor('1000', 'JPY')).toBe(1000n);
    expect(decimalStringToMinor('1250', 'JPY')).toBe(1250n);
    // a fractional JPY amount is invalid (0 decimals) — refuse to silently round money
    expect(() => decimalStringToMinor('1000.50', 'JPY')).toThrow();
  });

  it('3dp currency (KWD): NO under-scale — 1.500 KWD → 1500 minor (not 150)', () => {
    expect(decimalStringToMinor('1.500', 'KWD')).toBe(1500n);
    expect(decimalStringToMinor('10', 'KWD')).toBe(10000n);
    expect(decimalStringToMinor('-0.500', 'KWD')).toBe(-500n);
  });
});

describe('uuidV5FromOrderLive', () => {
  it('deterministic, distinct per updated_at, v5-shaped', () => {
    const a = uuidV5FromOrderLive(BRAND, '1001', 1000);
    const b = uuidV5FromOrderLive(BRAND, '1001', 2000);
    expect(a).toBe(uuidV5FromOrderLive(BRAND, '1001', 1000));
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
