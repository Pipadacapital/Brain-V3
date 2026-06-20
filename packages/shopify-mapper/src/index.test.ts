/**
 * @brain/shopify-mapper unit tests (feat-shopify-order-depth).
 *
 * The mapper was a frozen, load-bearing contract with NO unit tests — covered only indirectly via
 * webhook/backfill integration tests. This suite locks its behaviour directly, with a focus on the
 * new order-depth projection (line items / tax / shipping / discounts / refunds), and the money
 * invariant that everything is exact minor-units integer arithmetic (I-S07, no float).
 */
import { describe, it, expect } from 'vitest';
import {
  mapOrderToEvent,
  projectOrderDepth,
  decimalStringToMinor,
  tryDecimalToMinor,
  ORDER_LIVE_V1_EVENT_NAME,
  ORDER_BACKFILL_V1_EVENT_NAME,
  type ShopifyOrderShape,
} from './index.js';

const SALT = 'a'.repeat(64);

/** A minimal valid order; spread depth fields on top per-test. */
function baseOrder(over: Partial<ShopifyOrderShape> = {}): ShopifyOrderShape {
  return {
    id: 12345,
    name: '#1001',
    created_at: '2026-06-01T10:00:00Z',
    processed_at: '2026-06-01T10:05:00Z',
    updated_at: '2026-06-01T10:06:00Z',
    cancelled_at: null,
    currency: 'INR',
    current_total_price: '1250.00',
    financial_status: 'paid',
    fulfillment_status: null,
    ...over,
  };
}

describe('decimalStringToMinor / tryDecimalToMinor (I-S07)', () => {
  it('converts decimal strings to exact minor units with integer math', () => {
    expect(decimalStringToMinor('1250.00')).toBe(125000n);
    expect(decimalStringToMinor('15.5')).toBe(1550n);
    expect(decimalStringToMinor('999')).toBe(99900n);
    expect(decimalStringToMinor('0.01')).toBe(1n);
  });

  it('throws on malformed input (strict variant)', () => {
    expect(() => decimalStringToMinor('1.234')).toThrow();
    expect(() => decimalStringToMinor('abc')).toThrow();
    expect(() => decimalStringToMinor('-5.00')).toThrow();
  });

  it('tryDecimalToMinor returns null instead of throwing (resilient depth variant)', () => {
    expect(tryDecimalToMinor('10.00')).toBe(1000n);
    expect(tryDecimalToMinor(null)).toBeNull();
    expect(tryDecimalToMinor(undefined)).toBeNull();
    expect(tryDecimalToMinor('garbage')).toBeNull();
  });
});

describe('mapOrderToEvent — core (unchanged) shape', () => {
  it('maps order-level totals + drops raw PII to hashes', () => {
    const ev = mapOrderToEvent(
      baseOrder({ customer: { id: 77, email: 'a@b.com', phone: '+919876543210' } }),
      SALT, 'IN', ORDER_LIVE_V1_EVENT_NAME,
    );
    expect(ev.event_name).toBe(ORDER_LIVE_V1_EVENT_NAME);
    expect(ev.properties.amount_minor).toBe('125000');
    expect(ev.properties.currency_code).toBe('INR');
    expect(ev.properties.order_id).toBe('12345');
    expect(ev.properties.storefront_customer_id).toBe('77');
    expect(ev.properties.hashed_customer_email).toMatch(/^[0-9a-f]{64}$/);
    // raw PII never leaks
    expect(JSON.stringify(ev.properties)).not.toContain('a@b.com');
    expect(JSON.stringify(ev.properties)).not.toContain('9876543210');
  });

  it('stays FLAT (no depth keys) when the order carries no breakdown — backward compatible', () => {
    const ev = mapOrderToEvent(baseOrder(), SALT, 'IN', ORDER_BACKFILL_V1_EVENT_NAME);
    expect(ev.properties.line_items).toBeUndefined();
    expect(ev.properties.tax_lines).toBeUndefined();
    expect(ev.properties.refunds).toBeUndefined();
    expect(ev.properties.shipping_total_minor).toBeUndefined();
    expect(ev.properties.discount_total_minor).toBeUndefined();
  });
});

describe('projectOrderDepth — line items', () => {
  it('maps line items with exact per-unit and line-total minor units (qty × unit − discount)', () => {
    const d = projectOrderDepth(baseOrder({
      line_items: [
        { sku: 'SKU-1', title: 'Widget', quantity: 3, price: '100.00', product_id: 9, variant_id: 90, total_discount: '50.00' },
        { sku: 'SKU-2', name: 'Gadget', quantity: 1, price: '250.50' },
      ],
    }));
    expect(d.line_items).toHaveLength(2);
    expect(d.line_items![0]).toMatchObject({
      sku: 'SKU-1', title: 'Widget', quantity: 3,
      unit_price_minor: '10000', line_total_minor: '25000', line_discount_minor: '5000',
      product_id: '9', variant_id: '90',
    });
    // title falls back to name; ids null when absent
    expect(d.line_items![1]).toMatchObject({ title: 'Gadget', unit_price_minor: '25050', line_total_minor: '25050', product_id: null });
  });

  it('skips an un-priceable line rather than fabricating a zero', () => {
    const d = projectOrderDepth(baseOrder({
      line_items: [
        { sku: 'OK', quantity: 2, price: '10.00' },
        { sku: 'BAD', quantity: 1, price: 'not-a-price' },
      ],
    }));
    expect(d.line_items).toHaveLength(1);
    expect(d.line_items![0]!.sku).toBe('OK');
  });
});

describe('projectOrderDepth — tax / shipping / discounts', () => {
  it('maps tax lines + total, summed shipping, and discount codes + total', () => {
    const d = projectOrderDepth(baseOrder({
      tax_lines: [{ title: 'GST', rate: 0.18, price: '45.00' }],
      total_tax: '45.00',
      shipping_lines: [{ title: 'Std', price: '30.00' }, { title: 'Surcharge', price: '20.00' }],
      total_discounts: '100.00',
      discount_codes: [{ code: 'SAVE10', amount: '100.00', type: 'percentage' }],
    }));
    expect(d.tax_lines).toEqual([{ title: 'GST', rate: 0.18, amount_minor: '4500' }]);
    expect(d.tax_total_minor).toBe('4500');
    expect(d.shipping_total_minor).toBe('5000'); // 30 + 20
    expect(d.discount_total_minor).toBe('10000');
    expect(d.discount_codes).toEqual([{ code: 'SAVE10', amount_minor: '10000', type: 'percentage' }]);
  });
});

describe('projectOrderDepth — refunds', () => {
  it('sums settled refund transactions per refund and across the order', () => {
    const d = projectOrderDepth(baseOrder({
      refunds: [
        {
          id: 555, processed_at: '2026-06-02T09:00:00Z', note: 'damaged',
          transactions: [
            { amount: '100.00', kind: 'refund', status: 'success' },
            { amount: '50.00', kind: 'refund', status: 'success' },
            { amount: '999.00', kind: 'refund', status: 'failure' }, // ignored
          ],
        },
        { id: 556, created_at: '2026-06-03T09:00:00Z', transactions: [{ amount: '25.00', kind: 'refund' }] },
      ],
    }));
    expect(d.refunds).toHaveLength(2);
    expect(d.refunds![0]).toMatchObject({ refund_id: '555', amount_minor: '15000', reason: 'damaged' });
    expect(d.refunds![0]!.processed_at).toBe('2026-06-02T09:00:00.000Z');
    expect(d.refunds![1]).toMatchObject({ refund_id: '556', amount_minor: '2500' });
    expect(d.refund_total_minor).toBe('17500'); // 150 + 25
  });
});

describe('mapOrderToEvent — full depth merged into properties', () => {
  it('nests the full breakdown under properties (lands in Bronze as JSONB)', () => {
    const ev = mapOrderToEvent(
      baseOrder({
        line_items: [{ sku: 'S', quantity: 2, price: '500.00' }],
        total_tax: '90.00',
        shipping_lines: [{ price: '40.00' }],
        total_discounts: '0.00',
        refunds: [{ id: 1, transactions: [{ amount: '100.00', kind: 'refund' }] }],
      }),
      SALT, 'IN', ORDER_LIVE_V1_EVENT_NAME,
    );
    expect(ev.properties.line_items).toHaveLength(1);
    expect(ev.properties.tax_total_minor).toBe('9000');
    expect(ev.properties.shipping_total_minor).toBe('4000');
    expect(ev.properties.refund_total_minor).toBe('10000');
    // core total still present + unchanged
    expect(ev.properties.amount_minor).toBe('125000');
  });
});
