/**
 * @brain/woocommerce-mapper/resources unit tests (ingestion-framework onboarding, 2nd connector).
 *
 * Locks the WOOCOMMERCE_MANIFEST validity + the framework-record mappers: the orders adapter over
 * the FROZEN mapWooOrderToEvent and the products mapper. Focus: manifest validity, per-state dedup
 * identity, and money in exact minor units (I-S07).
 */
import { describe, it, expect } from 'vitest';
import { assertManifestValid, backfillableResources } from '@brain/connector-core';
import {
  WOOCOMMERCE_MANIFEST,
  WOOCOMMERCE_PROVIDER,
  mapWooOrderToDraft,
  mapWooProductToDraft,
  mapWooCustomerToDraft,
  mapWooCouponToDraft,
  mapWooRefundToDraft,
  mapWooOrderRefundsToDrafts,
  PRODUCT_UPSERT_V1_EVENT_NAME,
  CUSTOMER_UPSERT_V1_EVENT_NAME,
  COUPON_UPSERT_V1_EVENT_NAME,
  REFUND_RECORDED_V1_EVENT_NAME,
  ORDER_LIVE_V1_EVENT_NAME,
  type WooProductShape,
  type WooOrderShape,
  type WooCustomerShape,
  type WooCouponShape,
  type WooRefundShape,
} from './index.js';

const BRAND = '22222222-2222-2222-2222-222222222222';
const SALT = 'b'.repeat(64);

describe('WOOCOMMERCE_MANIFEST', () => {
  it('is internally valid', () => {
    expect(() => assertManifestValid(WOOCOMMERCE_MANIFEST)).not.toThrow();
  });

  it('declares orders + products + customers + coupons + refunds as backfillable REST resources', () => {
    expect(WOOCOMMERCE_MANIFEST.provider).toBe(WOOCOMMERCE_PROVIDER);
    const names = backfillableResources(WOOCOMMERCE_MANIFEST).map((r) => r.name).sort();
    expect(names).toEqual(['coupons', 'customers', 'orders', 'products', 'refunds']);
  });
});

describe('mapWooOrderToDraft (framework adapter over the FROZEN order mapper)', () => {
  const order: WooOrderShape = {
    id: 4242,
    status: 'completed',
    currency: 'INR',
    total: '1250.00',
    date_created_gmt: '2026-06-01T10:00:00',
    date_modified_gmt: '2026-06-01T10:05:00',
    payment_method: 'razorpay',
    billing: { email: 'woo@example.com', phone: '+919812345678' },
  };

  it('emits a shared order.live.v1 with exact minor-units total + hashed PII only', () => {
    const rec = mapWooOrderToDraft(order, BRAND, SALT, 'IN', 'synthetic');
    expect(rec.events[0]!.event_name).toBe(ORDER_LIVE_V1_EVENT_NAME);
    const props = rec.events[0]!.properties as Record<string, unknown>;
    expect(props['order_id']).toBe('4242');
    expect(props['amount_minor']).toBe('125000');
    expect(JSON.stringify(props)).not.toContain('woo@example.com');
  });

  it('folds date_modified into the dedup identity (per-state restatement)', () => {
    const a = mapWooOrderToDraft(order, BRAND, SALT, 'IN');
    const b = mapWooOrderToDraft(
      { ...order, date_modified_gmt: '2026-06-02T10:05:00' },
      BRAND,
      SALT,
      'IN',
    );
    expect(a.providerId).not.toBe(b.providerId);
  });
});

describe('mapWooProductToDraft', () => {
  const product: WooProductShape = {
    id: 700,
    name: 'Woo Mug',
    slug: 'woo-mug',
    status: 'publish',
    type: 'simple',
    sku: 'MUG-1',
    price: '299.00',
    stock_quantity: 42,
    date_modified_gmt: '2026-06-01T10:00:00',
  };

  it('projects price in exact minor units (+ currency sibling) and a per-state dedup identity', () => {
    const rec = mapWooProductToDraft(product, BRAND, 'INR');
    expect(rec.events[0]!.event_name).toBe(PRODUCT_UPSERT_V1_EVENT_NAME);
    const props = rec.events[0]!.properties as Record<string, unknown>;
    expect(props['product_id']).toBe('700');
    expect(props['price_minor']).toBe('29900');
    expect(props['currency_code']).toBe('INR');
    expect(props['stock_quantity']).toBe(42);
    expect(props['variants']).toEqual([]); // flat simple product → empty variant array

    const b = mapWooProductToDraft({ ...product, date_modified_gmt: '2026-06-05T10:00:00' }, BRAND, 'INR');
    expect(rec.providerId).not.toBe(b.providerId);
  });

  it('MONEY FIX: variant prices carry a currency_code sibling, scaled per-currency (KWD 3dp)', () => {
    const variable: WooProductShape = {
      ...product,
      type: 'variable',
      variations: [
        { id: 7001, sku: 'MUG-S', price: '1.500', stock_quantity: 5 },
        { id: 7002, sku: 'MUG-L', price: '2.000', stock_quantity: 9 },
      ],
    };
    const rec = mapWooProductToDraft(variable, BRAND, 'KWD');
    const props = rec.events[0]!.properties as Record<string, unknown>;
    const variants = props['variants'] as Array<Record<string, unknown>>;
    expect(variants).toHaveLength(2);
    expect(variants[0]).toMatchObject({ variant_id: '7001', sku: 'MUG-S', price_minor: '1500', currency_code: 'KWD', inventory_quantity: 5 });
    expect(variants[1]).toMatchObject({ variant_id: '7002', price_minor: '2000', currency_code: 'KWD' });
  });
});

describe('mapWooCustomerToDraft', () => {
  const customer: WooCustomerShape = {
    id: 88,
    email: 'buyer@example.com',
    phone: '+919812345678',
    role: 'customer',
    date_modified_gmt: '2026-06-01T10:00:00',
    total_spent: '4500.00',
    orders_count: 3,
    billing: { email: 'buyer@example.com', phone: '+919812345678', country: 'IN', state: 'KA', city: 'Bengaluru', postcode: '560001' },
  };

  it('emits customer.upsert.v1 with hashed PII only (raw dropped) + coarse geo', () => {
    const rec = mapWooCustomerToDraft(customer, BRAND, SALT, 'IN', 'INR');
    expect(rec.events[0]!.event_name).toBe(CUSTOMER_UPSERT_V1_EVENT_NAME);
    const props = rec.events[0]!.properties as Record<string, unknown>;
    expect(props['customer_id']).toBe('88');
    expect(props['woocommerce_customer_id']).toBe('88');
    expect(props['hashed_customer_email']).toMatch(/^[0-9a-f]+$/);
    expect(props['hashed_customer_phone']).toMatch(/^[0-9a-f]+$/);
    expect(props['total_spent_minor']).toBe('450000');
    expect(props['currency_code']).toBe('INR');
    expect(props['orders_count']).toBe(3);
    // coarse geo carried; identifying PII never present
    expect(props['billing_country']).toBe('IN');
    expect(props['billing_city']).toBe('Bengaluru');
    const json = JSON.stringify(rec);
    expect(json).not.toContain('buyer@example.com');
    expect(json).not.toContain('9812345678');
    expect(json).not.toContain('560001'); // postcode (PII) dropped
  });

  it('idempotent event_id basis (providerId) is stable across re-map, per-state on date_modified', () => {
    const a = mapWooCustomerToDraft(customer, BRAND, SALT, 'IN', 'INR');
    const a2 = mapWooCustomerToDraft({ ...customer }, BRAND, SALT, 'IN', 'INR');
    expect(a.providerId).toBe(a2.providerId);
    const b = mapWooCustomerToDraft({ ...customer, date_modified_gmt: '2026-06-09T10:00:00' }, BRAND, SALT, 'IN', 'INR');
    expect(a.providerId).not.toBe(b.providerId);
  });
});

describe('mapWooCouponToDraft', () => {
  it('fixed_cart coupon → amount_minor in exact minor units (+ currency sibling)', () => {
    const coupon: WooCouponShape = {
      id: 500,
      code: 'SAVE100',
      amount: '100.00',
      discount_type: 'fixed_cart',
      date_modified_gmt: '2026-06-01T10:00:00',
      usage_count: 12,
      usage_limit: 100,
    };
    const rec = mapWooCouponToDraft(coupon, BRAND, 'INR');
    expect(rec.events[0]!.event_name).toBe(COUPON_UPSERT_V1_EVENT_NAME);
    const props = rec.events[0]!.properties as Record<string, unknown>;
    expect(props['coupon_id']).toBe('500');
    expect(props['code']).toBe('SAVE100');
    expect(props['amount_minor']).toBe('10000');
    expect(props['currency_code']).toBe('INR');
    expect(props['amount_percent']).toBeNull();
    expect(props['usage_count']).toBe(12);
  });

  it('MONEY FIX: fixed coupon money is currency-aware (KWD 3dp)', () => {
    const coupon: WooCouponShape = { id: 501, code: 'KW5', amount: '5.000', discount_type: 'fixed_cart', date_modified_gmt: '2026-06-01T10:00:00' };
    const props = mapWooCouponToDraft(coupon, BRAND, 'KWD').events[0]!.properties as Record<string, unknown>;
    expect(props['amount_minor']).toBe('5000'); // 5.000 KWD → 5000 fils (not 500)
    expect(props['currency_code']).toBe('KWD');
  });

  it('percent coupon → amount_percent carried verbatim, NEVER scaled to money', () => {
    const coupon: WooCouponShape = { id: 502, code: 'TENOFF', amount: '10', discount_type: 'percent', date_modified_gmt: '2026-06-01T10:00:00' };
    const props = mapWooCouponToDraft(coupon, BRAND, 'INR').events[0]!.properties as Record<string, unknown>;
    expect(props['amount_percent']).toBe('10');
    expect(props['amount_minor']).toBeNull();
    expect(props['currency_code']).toBeNull(); // a percentage has no currency
  });
});

describe('mapWooRefundToDraft / mapWooOrderRefundsToDrafts', () => {
  it('standalone refund → refund.recorded.v1 with ABS minor + currency sibling', () => {
    const refund: WooRefundShape = { id: 9001, amount: '500.00', reason: 'damaged', currency: 'INR', date_created_gmt: '2026-06-12T10:00:00' };
    const rec = mapWooRefundToDraft(refund, BRAND, '4242', 'INR');
    expect(rec.events[0]!.event_name).toBe(REFUND_RECORDED_V1_EVENT_NAME);
    const props = rec.events[0]!.properties as Record<string, unknown>;
    expect(props['refund_id']).toBe('9001');
    expect(props['order_id']).toBe('4242');
    expect(props['amount_minor']).toBe('50000');
    expect(props['currency_code']).toBe('INR');
    expect(props['reason']).toBe('damaged');
    expect(rec.providerId).toBe('9001'); // provider_id dedup — stable across re-map
  });

  it('MONEY FIX: refund amount is currency-aware (JPY 0dp, NEGATIVE total form)', () => {
    const refund: WooRefundShape = { id: 9002, total: '-1500', date_created_gmt: '2026-06-12T10:00:00' };
    const props = mapWooRefundToDraft(refund, BRAND, '5', 'JPY').events[0]!.properties as Record<string, unknown>;
    expect(props['amount_minor']).toBe('1500'); // not '150000'
    expect(props['currency_code']).toBe('JPY');
  });

  it('fans an order refunds[] array into standalone refund drafts (currency from the order)', () => {
    const order: WooOrderShape = {
      id: 4242,
      currency: 'INR',
      total: '1000.00',
      refunds: [
        { id: 1, total: '-500.00', reason: 'partial', date_created: '2026-06-12T10:00:00' },
        { id: 2, total: '-250.00', reason: 'partial2', date_created: '2026-06-13T10:00:00' },
      ],
    };
    const recs = mapWooOrderRefundsToDrafts(order, BRAND);
    expect(recs).toHaveLength(2);
    expect(recs.map((r) => (r.events[0]!.properties as Record<string, unknown>)['amount_minor'])).toEqual(['50000', '25000']);
    expect((recs[0]!.events[0]!.properties as Record<string, unknown>)['order_id']).toBe('4242');
  });

  it('throws on a refund missing id', () => {
    expect(() => mapWooRefundToDraft({ amount: '1.00' } as WooRefundShape, BRAND, '1', 'INR')).toThrow(/missing id/);
  });
});
