/**
 * @brain/gokwik-mapper — unit tests (webhook-first canonical events; AWB retired).
 *
 * UT-1: mapGokwikOrder — order.live.v1 (OrderProperties-shaped); money minor units; PII hashed;
 *       financial_status normalized (order.failed → voided); per-state idempotent event_id.
 * UT-2: mapGokwikCheckout — checkout.abandoned.v1 / gokwik.checkout_started.v1 / gokwik.checkout_step.v1.
 * UT-3: mapGokwikPayment — payment.attempted.v1 (initiated/failed) / payment.authorized.v1; payment_id hashed.
 * UT-4/UT-5: mapGokwikRtoPredict — categorical risk_flag VERBATIM; NEVER a fabricated number.
 * UT-6: data_source stamped (DEV-HONESTY).
 */

import { describe, it, expect } from 'vitest';
import {
  mapGokwikOrder,
  mapGokwikCheckout,
  mapGokwikPayment,
  mapGokwikRtoPredict,
  uuidV5FromRtoPredict,
  hashPaymentId,
  normalizeRiskFlag,
  ORDER_LIVE_V1_EVENT_NAME,
  CHECKOUT_ABANDONED_V1_EVENT_NAME,
  GOKWIK_CHECKOUT_STARTED_V1_EVENT_NAME,
  GOKWIK_CHECKOUT_STEP_V1_EVENT_NAME,
  PAYMENT_ATTEMPTED_V1_EVENT_NAME,
  PAYMENT_AUTHORIZED_V1_EVENT_NAME,
  GOKWIK_RTO_PREDICT_V1_EVENT_NAME,
  type GokwikOrderRecord,
  type GokwikCheckoutRecord,
  type GokwikPaymentRecord,
  type GokwikRtoPredictRecord,
} from '../index.js';

const BRAND_A = 'c07ec701-0a00-4a00-8a00-000000000001';
const BRAND_B = 'c07ec702-0b00-4b00-8b00-000000000002';
const SALT_A = 'a'.repeat(64);
const SALT_B = 'b'.repeat(64);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('UT-1: mapGokwikOrder → order.live.v1 (OrderProperties-shaped)', () => {
  const base: GokwikOrderRecord = {
    event_type: 'order.created',
    moid: 'GK-ORD-1', total: '1299.50', currency: 'INR', payment_method: 'cod',
    email: 'buyer@example.com', phone: '+919876543210', customer_id: 'CUST-9',
    updated_at: '2026-05-05T16:00:00Z',
  };

  it('emits order.live.v1 with minor-units money + currency, never a float', () => {
    const ev = mapGokwikOrder(base, BRAND_A, SALT_A, 'IN');
    expect(ev.event_name).toBe(ORDER_LIVE_V1_EVENT_NAME);
    expect(ev.properties.source).toBe('gokwik');
    expect(ev.properties.order_id).toBe('GK-ORD-1');
    expect(ev.properties.amount_minor).toBe('129950'); // 1299.50 → BIGINT minor
    expect(typeof ev.properties.amount_minor).toBe('string');
    expect(ev.properties.currency_code).toBe('INR');
    expect(ev.properties.payment_method).toBe('cod');
    expect(ev.event_id).toMatch(UUID_RE);
  });

  it('hashes PII at the boundary; raw email/phone NEVER in output', () => {
    const ev = mapGokwikOrder(base, BRAND_A, SALT_A, 'IN');
    const json = JSON.stringify(ev);
    expect(json).not.toContain('buyer@example.com');
    expect(json).not.toContain('9876543210');
    expect(ev.properties.hashed_customer_email).toMatch(/^[0-9a-f]{64}$/);
    expect(ev.properties.hashed_customer_phone).toMatch(/^[0-9a-f]{64}$/);
    expect(ev.properties.storefront_customer_id).toBe('CUST-9');
  });

  it('defaults currency to INR when absent', () => {
    const ev = mapGokwikOrder({ moid: 'X', total: '100', updated_at: '2026-05-05T16:00:00Z' }, BRAND_A, SALT_A, 'IN');
    expect(ev.properties.currency_code).toBe('INR');
    expect(ev.properties.amount_minor).toBe('10000');
  });

  it('normalizes financial_status (order.failed → voided; cancelled → cancelled + cancelled_at)', () => {
    expect(mapGokwikOrder({ ...base, event_type: 'order.failed' }, BRAND_A, SALT_A, 'IN').properties.financial_status).toBe('voided');
    expect(mapGokwikOrder({ ...base, event_type: 'order.refunded' }, BRAND_A, SALT_A, 'IN').properties.financial_status).toBe('refunded');
    expect(mapGokwikOrder({ ...base, event_type: 'order.paid', status: 'paid' }, BRAND_A, SALT_A, 'IN').properties.financial_status).toBe('paid');
    const cancelled = mapGokwikOrder({ ...base, event_type: 'order.cancelled' }, BRAND_A, SALT_A, 'IN');
    expect(cancelled.properties.financial_status).toBe('cancelled');
    expect(cancelled.properties.cancelled_at).not.toBeNull();
  });

  it('per-state idempotent event_id: same state replay → same id; new state-time → new id', () => {
    const a = mapGokwikOrder(base, BRAND_A, SALT_A, 'IN');
    const aAgain = mapGokwikOrder(base, BRAND_A, SALT_A, 'IN');
    const later = mapGokwikOrder({ ...base, updated_at: '2026-05-06T10:00:00Z' }, BRAND_A, SALT_A, 'IN');
    expect(a.event_id).toBe(aAgain.event_id);
    expect(a.event_id).not.toBe(later.event_id);
  });

  it('projects optional economic depth (line_items / tax / discount / refunds) in minor units', () => {
    const ev = mapGokwikOrder(
      {
        ...base,
        event_type: 'order.refunded',
        line_items: [{ sku: 'SKU1', name: 'Tee', quantity: 2, price: '500.00', total_discount: '50.00' }],
        total_tax: '90.00', total_discount: '50.00',
        refunds: [{ id: 'R1', amount: '200.00', reason: 'damaged', processed_at: '2026-05-06T09:00:00Z' }],
      },
      BRAND_A, SALT_A, 'IN',
    );
    expect(ev.properties.line_items?.[0]?.unit_price_minor).toBe('50000');
    expect(ev.properties.line_items?.[0]?.line_total_minor).toBe('95000'); // 50000*2 - 5000
    expect(ev.properties.tax_total_minor).toBe('9000');
    expect(ev.properties.discount_total_minor).toBe('5000');
    expect(ev.properties.refund_total_minor).toBe('20000');
  });

  it('throws when order_id is absent', () => {
    expect(() => mapGokwikOrder({ total: '10' }, BRAND_A, SALT_A, 'IN')).toThrow(/order_id/);
  });
});

describe('UT-2: mapGokwikCheckout → checkout signals', () => {
  const base: GokwikCheckoutRecord = {
    checkout_id: 'CHK-1', total: '999.00', currency: 'INR', pincode: '110001',
    email: 'shopper@example.com', updated_at: '2026-05-05T16:00:00Z',
  };

  it('abandoned → checkout.abandoned.v1 (money minor units + has_address + hashed PII)', () => {
    const ev = mapGokwikCheckout(base, BRAND_A, SALT_A, 'IN', 'abandoned');
    expect(ev.event_name).toBe(CHECKOUT_ABANDONED_V1_EVENT_NAME);
    expect(ev.properties.total_price_minor).toBe('99900');
    expect(ev.properties.currency_code).toBe('INR');
    expect(ev.properties.has_address).toBe(true);
    expect(ev.event_id).toMatch(UUID_RE);
    expect(JSON.stringify(ev)).not.toContain('shopper@example.com');
    expect(ev.properties.hashed_customer_email).toMatch(/^[0-9a-f]{64}$/);
  });

  it('started → gokwik.checkout_started.v1', () => {
    const ev = mapGokwikCheckout({ checkout_id: 'CHK-2', updated_at: '2026-05-05T16:00:00Z' }, BRAND_A, SALT_A, 'IN', 'started');
    expect(ev.event_name).toBe(GOKWIK_CHECKOUT_STARTED_V1_EVENT_NAME);
    expect(ev.properties.total_price_minor).toBeUndefined(); // no money → omitted (no phantom currency row)
    expect(ev.properties.has_address).toBe(false);
  });

  it('step → gokwik.checkout_step.v1 with step_name', () => {
    const ev = mapGokwikCheckout({ checkout_id: 'CHK-3', step: 'address', updated_at: '2026-05-05T16:00:00Z' }, BRAND_A, SALT_A, 'IN', 'step');
    expect(ev.event_name).toBe(GOKWIK_CHECKOUT_STEP_V1_EVENT_NAME);
    expect(ev.properties.step_name).toBe('address');
  });

  it('throws when no checkout/order id', () => {
    expect(() => mapGokwikCheckout({}, BRAND_A, SALT_A, 'IN', 'abandoned')).toThrow(/checkout/);
  });
});

describe('UT-3: mapGokwikPayment → payment events', () => {
  const base: GokwikPaymentRecord = {
    order_id: 'GK-ORD-1', payment_id: 'pay_abc123', amount: '1299.00', currency: 'INR',
    updated_at: '2026-05-05T16:05:00Z',
  };

  it('attempted (default) → payment.attempted.v1, status initiated, payment_id hashed (raw dropped)', () => {
    const ev = mapGokwikPayment(base, BRAND_A, SALT_A, 'IN', 'attempted');
    expect(ev.event_name).toBe(PAYMENT_ATTEMPTED_V1_EVENT_NAME);
    expect(ev.properties.payment_status).toBe('initiated');
    expect(ev.properties.amount_minor).toBe('129900');
    expect(ev.properties.payment_id_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(ev)).not.toContain('pay_abc123');
    expect(ev.properties.payment_id_hash).toBe(hashPaymentId('pay_abc123', SALT_A));
  });

  it('attempted with failed status → status failed', () => {
    const ev = mapGokwikPayment({ ...base, payment_status: 'failed' }, BRAND_A, SALT_A, 'IN', 'attempted');
    expect(ev.properties.payment_status).toBe('failed');
  });

  it('authorized → payment.authorized.v1, status authorized', () => {
    const ev = mapGokwikPayment(base, BRAND_A, SALT_A, 'IN', 'authorized');
    expect(ev.event_name).toBe(PAYMENT_AUTHORIZED_V1_EVENT_NAME);
    expect(ev.properties.payment_status).toBe('authorized');
  });

  it('throws when order_id absent', () => {
    expect(() => mapGokwikPayment({ payment_id: 'x' }, BRAND_A, SALT_A, 'IN', 'attempted')).toThrow(/order_id/);
  });
});

describe('UT-4/UT-5: RTO-Predict categorical (never a fabricated number)', () => {
  const record: GokwikRtoPredictRecord = {
    order_id: 'ord_1', request_id: 'req_1', risk_flag: 'High Risk',
    risk_reason: 'high-RTO pincode', occurred_at: '2026-05-01T08:58:00Z',
  };
  it('records risk_flag VERBATIM + normalized closed set; no numeric score field', () => {
    const ev = mapGokwikRtoPredict(record, BRAND_A);
    expect(ev.properties.risk_flag_raw).toBe('High Risk');
    expect(ev.properties.risk_flag).toBe('high');
    expect(ev.event_name).toBe(GOKWIK_RTO_PREDICT_V1_EVENT_NAME);
    expect(JSON.stringify(ev)).not.toMatch(/"(score|probability|risk_score)"\s*:/);
  });
  it('normalizeRiskFlag closed set', () => {
    expect(normalizeRiskFlag('High Risk')).toBe('high');
    expect(normalizeRiskFlag('Medium')).toBe('medium');
    expect(normalizeRiskFlag('Low Risk')).toBe('low');
    expect(normalizeRiskFlag('Control')).toBe('control');
    expect(normalizeRiskFlag('weird')).toBe('unknown');
  });
  it('uuidV5FromRtoPredict deterministic + per-brand distinct', () => {
    expect(uuidV5FromRtoPredict(BRAND_A, 'ord_1', 'req_1')).toBe(uuidV5FromRtoPredict(BRAND_A, 'ord_1', 'req_1'));
    expect(uuidV5FromRtoPredict(BRAND_B, 'ord_1', 'req_1')).not.toBe(uuidV5FromRtoPredict(BRAND_A, 'ord_1', 'req_1'));
  });
  // UT-7 companion: the strategy seeds the id with `requestId ?? occurred_at`. With NEITHER present,
  // the old wall-clock occurred_at fallback would enter the seed → a redelivered webhook mints a
  // DIFFERENT event_id → permanent duplicate. The mapper must refuse that combination — and ONLY that
  // combination (a request_id alone keeps the seed idempotent, so occurred_at may fall back for the
  // envelope without duplicate risk).
  it('missing BOTH request_id and occurred_at → throws (no wall-clock id seed)', () => {
    expect(() => mapGokwikRtoPredict({ order_id: 'ord_nt', risk_flag: 'Low' }, BRAND_A)).toThrow(/request_id and occurred_at/);
  });
  it('request_id present, occurred_at absent → still maps (seed never touches occurred_at)', () => {
    const ev = mapGokwikRtoPredict({ order_id: 'ord_ri', request_id: 'req_only', risk_flag: 'Low' }, BRAND_A);
    expect(ev.event_name).toBe(GOKWIK_RTO_PREDICT_V1_EVENT_NAME);
    expect(ev.properties.request_id).toBe('req_only');
  });
});

describe('UT-6: data_source stamped (DEV-HONESTY) + per-brand distinct hashes', () => {
  it('order / checkout / payment / rto carry data_source', () => {
    const ts = { updated_at: '2026-05-05T16:00:00Z' };
    expect(mapGokwikOrder({ moid: 'o', total: '1', ...ts }, BRAND_A, SALT_A, 'IN', 'synthetic').properties.data_source).toBe('synthetic');
    expect(mapGokwikCheckout({ checkout_id: 'c', ...ts }, BRAND_A, SALT_A, 'IN', 'started', 'synthetic').properties.data_source).toBe('synthetic');
    expect(mapGokwikPayment({ order_id: 'o', ...ts }, BRAND_A, SALT_A, 'IN', 'attempted', 'synthetic').properties.data_source).toBe('synthetic');
    expect(mapGokwikRtoPredict({ order_id: 'o', request_id: 'req_ds', risk_flag: 'Low' }, BRAND_A, 'synthetic').properties.data_source).toBe('synthetic');
  });
  it('per-brand distinct payment_id hashes', () => {
    expect(hashPaymentId('pay_1', SALT_A)).not.toBe(hashPaymentId('pay_1', SALT_B));
  });
});

describe('UT-7: missing payload timestamp FAILS CLOSED (no wall-clock event_id minting)', () => {
  // occurred_at feeds the DETERMINISTIC event_id seed. A wall-clock fallback would mint a
  // DIFFERENT id on every at-least-once webhook redelivery → permanent TRUE duplicates in
  // Bronze/Silver. So a record with none of updated_at/event_time/created_at/timestamp is
  // unmappable: the mapper throws (pipeline surfaces it as a logged 400 skip).
  it('order: no timestamp → throws (no event emitted, no wall-clock id)', () => {
    expect(() => mapGokwikOrder({ moid: 'GK-NT-1', total: '10' }, BRAND_A, SALT_A, 'IN')).toThrow(/timestamp/);
  });
  it('checkout: no timestamp → throws', () => {
    expect(() => mapGokwikCheckout({ checkout_id: 'CHK-NT' }, BRAND_A, SALT_A, 'IN', 'started')).toThrow(/timestamp/);
  });
  it('payment: no timestamp → throws', () => {
    expect(() => mapGokwikPayment({ order_id: 'GK-NT-2', payment_id: 'p1' }, BRAND_A, SALT_A, 'IN', 'attempted')).toThrow(/timestamp/);
  });
  it('unparseable timestamp → throws (never silently falls back to now)', () => {
    expect(() => mapGokwikOrder({ moid: 'GK-NT-3', total: '10', updated_at: 'not-a-date' }, BRAND_A, SALT_A, 'IN')).toThrow(/timestamp/);
  });
  it('same-payload redelivery → byte-identical event_id (order / checkout / payment)', () => {
    const order = { moid: 'GK-RD-1', total: '99.00', updated_at: '2026-05-05T16:00:00Z' };
    expect(mapGokwikOrder(order, BRAND_A, SALT_A, 'IN').event_id)
      .toBe(mapGokwikOrder(order, BRAND_A, SALT_A, 'IN').event_id);
    const checkout = { checkout_id: 'CHK-RD-1', updated_at: '2026-05-05T16:00:00Z' };
    expect(mapGokwikCheckout(checkout, BRAND_A, SALT_A, 'IN', 'started').event_id)
      .toBe(mapGokwikCheckout(checkout, BRAND_A, SALT_A, 'IN', 'started').event_id);
    const payment = { order_id: 'GK-RD-2', updated_at: '2026-05-05T16:00:00Z' };
    expect(mapGokwikPayment(payment, BRAND_A, SALT_A, 'IN', 'attempted').event_id)
      .toBe(mapGokwikPayment(payment, BRAND_A, SALT_A, 'IN', 'attempted').event_id);
  });
});

describe('UT-8: null-payment-id event_id discriminator (payment_status folded into seed)', () => {
  const AT = '2026-05-05T16:05:00Z';
  it('distinct signals (initiated vs failed) with NO payment id at the same occurred_at → DISTINCT ids', () => {
    const initiated = mapGokwikPayment({ order_id: 'GK-P-1', updated_at: AT }, BRAND_A, SALT_A, 'IN', 'attempted');
    const failed = mapGokwikPayment({ order_id: 'GK-P-1', payment_status: 'failed', updated_at: AT }, BRAND_A, SALT_A, 'IN', 'attempted');
    expect(initiated.properties.payment_status).toBe('initiated');
    expect(failed.properties.payment_status).toBe('failed');
    expect(initiated.event_id).not.toBe(failed.event_id);
  });
  it('truly identical null-payment payloads still collapse to ONE id (same logical event)', () => {
    const a = mapGokwikPayment({ order_id: 'GK-P-2', updated_at: AT }, BRAND_A, SALT_A, 'IN', 'attempted');
    const b = mapGokwikPayment({ order_id: 'GK-P-2', updated_at: AT }, BRAND_A, SALT_A, 'IN', 'attempted');
    expect(a.event_id).toBe(b.event_id);
  });
  it('a present payment_id keeps the payment-id-keyed seed (distinct from the null-case seed)', () => {
    const withId = mapGokwikPayment({ order_id: 'GK-P-3', payment_id: 'pay_x', updated_at: AT }, BRAND_A, SALT_A, 'IN', 'attempted');
    const withoutId = mapGokwikPayment({ order_id: 'GK-P-3', updated_at: AT }, BRAND_A, SALT_A, 'IN', 'attempted');
    expect(withId.event_id).not.toBe(withoutId.event_id);
  });
});
