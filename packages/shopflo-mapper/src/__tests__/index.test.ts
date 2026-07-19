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
  mapShopfloOrder,
  mapShopfloRefund,
  mapShopfloPayment,
  mapShopfloCheckout,
  uuidV5FromShopfloCheckout,
  SHOPFLO_CHECKOUT_ABANDONED_V1_EVENT_NAME,
  ORDER_LIVE_V1_EVENT_NAME,
  REFUND_RECORDED_V1_EVENT_NAME,
  PAYMENT_ATTEMPTED_V1_EVENT_NAME,
  PAYMENT_AUTHORIZED_V1_EVENT_NAME,
  CHECKOUT_ABANDONED_V1_EVENT_NAME,
  SHOPFLO_CHECKOUT_STARTED_V1_EVENT_NAME,
  SHOPFLO_CHECKOUT_STEP_V1_EVENT_NAME,
  SHOPFLO_CHECKOUT_COMPLETED_V1_EVENT_NAME,
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

// ─── SLICE B — full reimplementation: order / payment / refund / checkout-funnel ──────────────────────

describe('UT-8: mapShopfloOrder → order.live.v1 (THE order-source fix)', () => {
  const ORDER = {
    event_name: 'order.paid',
    order_id: 'SF-1001',
    total_price: 1299,
    total_tax: 99,
    total_discount: 100,
    currency: 'INR',
    payment_method: 'prepaid',
    updated_at: '2026-06-10T12:00:00Z',
    customer: { uid: 'cust_9', email: 'Buyer@Example.com', phone: '+917777777777' },
    line_items: [{ sku: 'TEE', title: 'Tee', quantity: 2, price: 650 }],
    utm_params: { utm_source: 'meta', utm_campaign: 'spring' },
    discount_code: 'SPRING10',
  };

  it('emits canonical order.live.v1 with bigint-minor money + currency', () => {
    const ev = mapShopfloOrder(ORDER, BRAND_A, SALT_A);
    expect(ev.event_name).toBe(ORDER_LIVE_V1_EVENT_NAME);
    expect(ev.properties.source).toBe('shopflo');
    expect(ev.properties.order_id).toBe('SF-1001');
    expect(ev.properties.amount_minor).toBe('129900');
    expect(ev.properties.currency_code).toBe('INR');
    expect(ev.properties.financial_status).toBe('paid');
    expect(ev.properties.tax_total_minor).toBe('9900');
    expect(ev.properties.discount_total_minor).toBe('10000');
    expect(ev.properties.line_items?.[0]!.unit_price_minor).toBe('65000');
  });

  it('event_id is deterministic + replay-stable (same as Shopify/GoKwik order lane)', () => {
    const a = mapShopfloOrder(ORDER, BRAND_A, SALT_A);
    const b = mapShopfloOrder(ORDER, BRAND_A, SALT_A);
    expect(a.event_id).toBe(b.event_id);
    expect(a.event_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('threads non-PII journey context; hashes email/phone; raw never present', () => {
    const ev = mapShopfloOrder(ORDER, BRAND_A, SALT_A);
    const json = JSON.stringify(ev);
    expect(json).not.toContain('Buyer@Example.com');
    expect(json).not.toContain('+917777777777');
    expect(ev.properties.hashed_customer_email).toMatch(/^[0-9a-f]{64}$/);
    expect(ev.properties.utm_params).toEqual({ utm_source: 'meta', utm_campaign: 'spring' });
    expect(ev.properties.discount_code).toBe('SPRING10');
  });

  it('normalizes lifecycle subtypes to recognition-gate statuses', () => {
    expect(mapShopfloOrder({ ...ORDER, event_name: 'order.failed' }, BRAND_A, SALT_A).properties.financial_status).toBe('voided');
    expect(mapShopfloOrder({ ...ORDER, event_name: 'order.cancelled' }, BRAND_A, SALT_A).properties.financial_status).toBe('cancelled');
    expect(mapShopfloOrder({ ...ORDER, event_name: 'order.refunded' }, BRAND_A, SALT_A).properties.financial_status).toBe('refunded');
  });

  it('throws when order_id missing (no phantom spine key)', () => {
    expect(() => mapShopfloOrder({ event_name: 'order.paid', total_price: 1 }, BRAND_A, SALT_A)).toThrow(/order_id/);
  });
});

describe('UT-9: mapShopfloRefund → refund.recorded.v1', () => {
  it('maps a standalone refund with bigint-minor amount + stable id', () => {
    const ev = mapShopfloRefund({ refund_id: 'RF-7', order_id: 'SF-1001', amount: 500, currency: 'inr', occurred_at: '2026-06-11T00:00:00Z' }, BRAND_A, SALT_A);
    expect(ev.event_name).toBe(REFUND_RECORDED_V1_EVENT_NAME);
    expect(ev.properties.amount_minor).toBe('50000');
    expect(ev.properties.currency_code).toBe('INR');
    expect(ev.properties.order_id).toBe('SF-1001');
    // Same refund_id at a different payload time → SAME id (refund event_id is refund-id-keyed).
    expect(ev.event_id).toBe(mapShopfloRefund({ refund_id: 'RF-7', occurred_at: '2026-06-12T00:00:00Z' }, BRAND_A, SALT_A).event_id);
  });
});

describe('UT-10: mapShopfloPayment → payment.attempted/authorized.v1', () => {
  it('authorized → payment.authorized.v1 with hashed payment id', () => {
    const ev = mapShopfloPayment({ order_id: 'SF-1', payment_id: 'pay_abc', amount: 1299, currency: 'INR', occurred_at: '2026-06-10T12:00:00Z' }, BRAND_A, SALT_A, 'IN', 'authorized');
    expect(ev.event_name).toBe(PAYMENT_AUTHORIZED_V1_EVENT_NAME);
    expect(ev.properties.payment_status).toBe('authorized');
    expect(ev.properties.payment_id_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(ev)).not.toContain('pay_abc');
    expect(ev.properties.amount_minor).toBe('129900');
  });
  it('attempted failure status → failed; else initiated', () => {
    const AT = { occurred_at: '2026-06-10T12:00:00Z' };
    expect(mapShopfloPayment({ order_id: 'SF-1', status: 'declined', ...AT }, BRAND_A, SALT_A, 'IN', 'attempted').properties.payment_status).toBe('failed');
    expect(mapShopfloPayment({ order_id: 'SF-1', status: 'pending', ...AT }, BRAND_A, SALT_A, 'IN', 'attempted').properties.payment_status).toBe('initiated');
    expect(mapShopfloPayment({ order_id: 'SF-1', ...AT }, BRAND_A, SALT_A, 'IN', 'attempted').event_name).toBe(PAYMENT_ATTEMPTED_V1_EVENT_NAME);
  });
});

describe('UT-12: missing payload timestamp FAILS CLOSED (no wall-clock event_id minting)', () => {
  // occurred_at feeds the DETERMINISTIC event_id seed. A wall-clock fallback would mint a
  // DIFFERENT id on every at-least-once webhook redelivery → permanent TRUE duplicates in
  // Bronze/Silver. So a record with none of occurred_at/updated_at/event_time/created_at/
  // timestamp is unmappable: the mapper throws — the same fail-closed posture the frozen
  // abandoned lane's strategy gate already takes for a missing occurred_at.
  it('order: no timestamp → throws (no event emitted, no wall-clock id)', () => {
    expect(() => mapShopfloOrder({ event_name: 'order.paid', order_id: 'SF-NT-1', total_price: 1 }, BRAND_A, SALT_A)).toThrow(/timestamp/);
  });
  it('payment: no timestamp → throws', () => {
    expect(() => mapShopfloPayment({ order_id: 'SF-NT-2', payment_id: 'p1' }, BRAND_A, SALT_A, 'IN', 'attempted')).toThrow(/timestamp/);
  });
  it('checkout funnel: no timestamp → throws', () => {
    expect(() => mapShopfloCheckout({ checkout_id: 'chk-NT' }, BRAND_A, SALT_A, 'IN', 'started')).toThrow(/timestamp/);
  });
  it('refund: no timestamp → throws', () => {
    expect(() => mapShopfloRefund({ refund_id: 'RF-NT' }, BRAND_A, SALT_A)).toThrow(/timestamp/);
  });
  it('unparseable timestamp → throws (never silently falls back to now)', () => {
    expect(() => mapShopfloOrder({ event_name: 'order.paid', order_id: 'SF-NT-3', total_price: 1, updated_at: 'not-a-date' }, BRAND_A, SALT_A)).toThrow(/timestamp/);
  });
  it('same-payload redelivery → byte-identical event_id (order / payment / checkout)', () => {
    const order = { event_name: 'order.paid', order_id: 'SF-RD-1', total_price: 10, updated_at: '2026-06-10T12:00:00Z' };
    expect(mapShopfloOrder(order, BRAND_A, SALT_A).event_id).toBe(mapShopfloOrder(order, BRAND_A, SALT_A).event_id);
    const payment = { order_id: 'SF-RD-2', occurred_at: '2026-06-10T12:00:00Z' };
    expect(mapShopfloPayment(payment, BRAND_A, SALT_A, 'IN', 'attempted').event_id)
      .toBe(mapShopfloPayment(payment, BRAND_A, SALT_A, 'IN', 'attempted').event_id);
    const checkout = { checkout_id: 'chk-RD-1', occurred_at: '2026-06-10T12:00:00Z' };
    expect(mapShopfloCheckout(checkout, BRAND_A, SALT_A, 'IN', 'started').event_id)
      .toBe(mapShopfloCheckout(checkout, BRAND_A, SALT_A, 'IN', 'started').event_id);
  });
});

describe('UT-13: null-payment-id event_id discriminator (payment_status folded into seed)', () => {
  const AT = '2026-06-10T12:05:00Z';
  it('distinct signals (initiated vs failed) with NO payment id at the same occurred_at → DISTINCT ids', () => {
    const initiated = mapShopfloPayment({ order_id: 'SF-P-1', occurred_at: AT }, BRAND_A, SALT_A, 'IN', 'attempted');
    const failed = mapShopfloPayment({ order_id: 'SF-P-1', status: 'declined', occurred_at: AT }, BRAND_A, SALT_A, 'IN', 'attempted');
    expect(initiated.properties.payment_status).toBe('initiated');
    expect(failed.properties.payment_status).toBe('failed');
    expect(initiated.event_id).not.toBe(failed.event_id);
  });
  it('truly identical null-payment payloads still collapse to ONE id (same logical event)', () => {
    const a = mapShopfloPayment({ order_id: 'SF-P-2', occurred_at: AT }, BRAND_A, SALT_A, 'IN', 'attempted');
    const b = mapShopfloPayment({ order_id: 'SF-P-2', occurred_at: AT }, BRAND_A, SALT_A, 'IN', 'attempted');
    expect(a.event_id).toBe(b.event_id);
  });
  it('a present payment_id keeps the payment-id-keyed seed (distinct from the null-case seed)', () => {
    const withId = mapShopfloPayment({ order_id: 'SF-P-3', payment_id: 'pay_x', occurred_at: AT }, BRAND_A, SALT_A, 'IN', 'attempted');
    const withoutId = mapShopfloPayment({ order_id: 'SF-P-3', occurred_at: AT }, BRAND_A, SALT_A, 'IN', 'attempted');
    expect(withId.event_id).not.toBe(withoutId.event_id);
  });
});

describe('UT-11: mapShopfloCheckout(kind) → funnel canon', () => {
  const CK = { checkout_id: 'chk_77', total_price: 65, currency: 'INR', occurred_at: '2026-06-10T12:00:00Z', step: 'address' };
  it('routes each kind to the right canonical event name', () => {
    expect(mapShopfloCheckout(CK, BRAND_A, SALT_A, 'IN', 'abandoned').event_name).toBe(CHECKOUT_ABANDONED_V1_EVENT_NAME);
    expect(mapShopfloCheckout(CK, BRAND_A, SALT_A, 'IN', 'started').event_name).toBe(SHOPFLO_CHECKOUT_STARTED_V1_EVENT_NAME);
    expect(mapShopfloCheckout(CK, BRAND_A, SALT_A, 'IN', 'step').event_name).toBe(SHOPFLO_CHECKOUT_STEP_V1_EVENT_NAME);
    expect(mapShopfloCheckout(CK, BRAND_A, SALT_A, 'IN', 'completed').event_name).toBe(SHOPFLO_CHECKOUT_COMPLETED_V1_EVENT_NAME);
  });
  it('stamps source=shopflo, bigint-minor money, step_name only on step', () => {
    const step = mapShopfloCheckout(CK, BRAND_A, SALT_A, 'IN', 'step');
    expect(step.properties.source).toBe('shopflo');
    expect(step.properties.total_price_minor).toBe('6500');
    expect(step.properties.step_name).toBe('address');
    expect(mapShopfloCheckout(CK, BRAND_A, SALT_A, 'IN', 'started').properties.step_name).toBeUndefined();
  });
  it('distinct event_id per (kind, checkout)', () => {
    const started = mapShopfloCheckout(CK, BRAND_A, SALT_A, 'IN', 'started');
    const completed = mapShopfloCheckout(CK, BRAND_A, SALT_A, 'IN', 'completed');
    expect(started.event_id).not.toBe(completed.event_id);
  });
});
