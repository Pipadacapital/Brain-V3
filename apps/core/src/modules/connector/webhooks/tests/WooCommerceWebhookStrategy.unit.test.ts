/**
 * WooCommerceWebhookStrategy.unit.test.ts — pure unit tests (infra-free).
 *
 * Proves the orders-only gap is closed: every WooCommerce resource topic maps to the SAME canonical
 * event the backfill fetchers emit, the live event_id is byte-identical to the backfill-derived id
 * (no-duplicate-ingestion across lanes), delete/unknown/id-less topics fast-ack (no event loss), and
 * the HMAC gate fails closed.
 */

import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { WooCommerceWebhookStrategy } from '../strategies/WooCommerceWebhookStrategy.js';
import type { WebhookStrategyContext } from '../platform/IWebhookStrategy.js';
import {
  mapWooCustomerToDraft,
  mapWooProductToDraft,
  mapWooCouponToDraft,
  mapWooOrderRefundsToDrafts,
  uuidV5FromOrderLive,
  ORDER_LIVE_V1_EVENT_NAME,
  CUSTOMER_UPSERT_V1_EVENT_NAME,
  PRODUCT_UPSERT_V1_EVENT_NAME,
  COUPON_UPSERT_V1_EVENT_NAME,
  REFUND_RECORDED_V1_EVENT_NAME,
  WOOCOMMERCE_PROVIDER,
  WOOCOMMERCE_CUSTOMERS_RESOURCE,
  WOOCOMMERCE_PRODUCTS_RESOURCE,
  WOOCOMMERCE_COUPONS_RESOURCE,
  WOOCOMMERCE_REFUNDS_RESOURCE,
} from '@brain/woocommerce-mapper';
import { deterministicDedupKeyDeriver, type ResourceDescriptor } from '@brain/connector-core';

const BRAND_ID = '11111111-1111-4111-8111-111111111111';
const SALT = 'a'.repeat(64);
const REGION = 'IN';

function ctx(topic: string, body: unknown): WebhookStrategyContext {
  return {
    rawBody: Buffer.from(JSON.stringify(body), 'utf8'),
    headers: { 'x-wc-webhook-topic': topic },
    parsedBody: null,
    brandId: BRAND_ID,
    saltHex: SALT,
    regionCode: REGION,
    correlationId: 'corr-1',
    requestId: 'req-1',
  };
}

/** The id the resumable backfill driver would stamp for the same record state (parity oracle). */
function backfillId(providerId: string, eventName: string, resource: ResourceDescriptor): string {
  return deterministicDedupKeyDeriver.deriveEventId({
    brandId: BRAND_ID,
    provider: WOOCOMMERCE_PROVIDER,
    resource,
    providerId,
    eventName,
  });
}

describe('WooCommerceWebhookStrategy.payloadMap — resource coverage', () => {
  it('customer.created → customer.upsert.v1 with backfill-identical event_id', async () => {
    const strat = new WooCommerceWebhookStrategy(async () => 'INR');
    const customer = {
      id: 501,
      email: 'buyer@example.com',
      date_modified_gmt: '2026-06-20T10:00:00',
      total_spent: '1250.00',
      billing: { country: 'IN', city: 'Pune', email: 'buyer@example.com' },
    };
    const res = await strat.payloadMap(ctx('customer.created', customer));

    expect(res.skip).toBe(false);
    expect(res.eventName).toBe(CUSTOMER_UPSERT_V1_EVENT_NAME);

    const record = mapWooCustomerToDraft(customer, BRAND_ID, SALT, REGION, 'INR');
    expect(res.eventId).toBe(backfillId(record.providerId, CUSTOMER_UPSERT_V1_EVENT_NAME, WOOCOMMERCE_CUSTOMERS_RESOURCE));
    expect(res.dedupKey).toBe(res.eventId);
    // PII hashed at the boundary — raw email never in the canonical properties.
    expect(JSON.stringify(res.properties)).not.toContain('buyer@example.com');
    expect((res.properties as { total_spent_minor?: string }).total_spent_minor).toBe('125000'); // INR 2dp
  });

  it('product.updated → product.upsert.v1, currency-aware price (no x100 / no INR default)', async () => {
    const strat = new WooCommerceWebhookStrategy(async () => 'INR');
    const product = { id: 88, name: 'Tee', sku: 'TEE-1', price: '250.00', date_modified_gmt: '2026-06-21T09:00:00' };
    const res = await strat.payloadMap(ctx('product.updated', product));

    expect(res.skip).toBe(false);
    expect(res.eventName).toBe(PRODUCT_UPSERT_V1_EVENT_NAME);
    const record = mapWooProductToDraft(product, BRAND_ID, 'INR');
    expect(res.eventId).toBe(backfillId(record.providerId, PRODUCT_UPSERT_V1_EVENT_NAME, WOOCOMMERCE_PRODUCTS_RESOURCE));
    expect((res.properties as { price_minor?: string }).price_minor).toBe('25000');
    expect((res.properties as { currency_code?: string }).currency_code).toBe('INR');
  });

  it('coupon.created → coupon.upsert.v1 (NEW grain); percent coupon is never scaled to money', async () => {
    const strat = new WooCommerceWebhookStrategy(async () => 'INR');
    const coupon = { id: 7, code: 'SAVE10', amount: '10', discount_type: 'percent', date_modified_gmt: '2026-06-22T08:00:00' };
    const res = await strat.payloadMap(ctx('coupon.created', coupon));

    expect(res.skip).toBe(false);
    expect(res.eventName).toBe(COUPON_UPSERT_V1_EVENT_NAME);
    const record = mapWooCouponToDraft(coupon, BRAND_ID, 'INR');
    expect(res.eventId).toBe(backfillId(record.providerId, COUPON_UPSERT_V1_EVENT_NAME, WOOCOMMERCE_COUPONS_RESOURCE));
    const props = res.properties as { amount_percent?: string; amount_minor?: string | null };
    expect(props.amount_percent).toBe('10'); // verbatim percent
    expect(props.amount_minor).toBeNull(); // a percentage is NOT money
  });

  it('product webhook with no store-currency resolver → honest-null price (never a guessed currency)', async () => {
    const strat = new WooCommerceWebhookStrategy(); // no resolver wired
    const product = { id: 88, name: 'Tee', sku: 'TEE-1', price: '250.00', date_modified_gmt: '2026-06-21T09:00:00' };
    const res = await strat.payloadMap(ctx('product.updated', product));

    expect(res.skip).toBe(false);
    expect((res.properties as { price_minor?: string | null }).price_minor).toBeNull();
    expect((res.properties as { currency_code?: string | null }).currency_code).toBeNull();
  });

  it('order.refunded → refund.recorded.v1 (newest refund), backfill-identical event_id', async () => {
    const strat = new WooCommerceWebhookStrategy();
    const order = {
      id: 9001,
      currency: 'INR',
      refunds: [
        { id: 11, total: '-100.00', reason: 'partial', date_created: '2026-06-20T10:00:00' },
        { id: 12, total: '-50.00', reason: 'second', date_created: '2026-06-24T10:00:00' },
      ],
    };
    const res = await strat.payloadMap(ctx('order.refunded', order));

    expect(res.skip).toBe(false);
    expect(res.eventName).toBe(REFUND_RECORDED_V1_EVENT_NAME);
    // newest refund (id 12, latest date) is the one this delivery is about.
    const newest = mapWooOrderRefundsToDrafts(order, BRAND_ID).reduce((a, b) => (b.occurredAt > a.occurredAt ? b : a));
    expect(res.eventId).toBe(backfillId(newest.providerId, REFUND_RECORDED_V1_EVENT_NAME, WOOCOMMERCE_REFUNDS_RESOURCE));
    expect((res.properties as { refund_id?: string }).refund_id).toBe('12');
    expect((res.properties as { amount_minor?: string }).amount_minor).toBe('5000'); // abs(50.00) INR
  });

  it('order.updated → order.live.v1 (FROZEN path, uuidV5 id unchanged)', async () => {
    const strat = new WooCommerceWebhookStrategy();
    const order = { id: 4242, currency: 'INR', total: '999.00', date_modified_gmt: '2026-06-25T12:00:00' };
    const res = await strat.payloadMap(ctx('order.updated', order));

    expect(res.skip).toBe(false);
    expect(res.eventName).toBe(ORDER_LIVE_V1_EVENT_NAME);
    const expectedId = uuidV5FromOrderLive(BRAND_ID, '4242', Date.parse(res.occurredAt));
    expect(res.eventId).toBe(expectedId);
    expect((res.properties as { amount_minor?: string }).amount_minor).toBe('99900');
  });
});

describe('WooCommerceWebhookStrategy.payloadMap — fast-ack (no event loss, no 400 storm)', () => {
  const strat = new WooCommerceWebhookStrategy(async () => 'INR');

  it('product.deleted → skip (no canonical hard-delete grain)', async () => {
    const res = await strat.payloadMap(ctx('product.deleted', { id: 88 }));
    expect(res.skip).toBe(true);
  });

  it('unknown topic → skip', async () => {
    const res = await strat.payloadMap(ctx('subscription.created', { id: 1 }));
    expect(res.skip).toBe(true);
  });

  it('registration ping (id-less customer payload) → skip', async () => {
    const res = await strat.payloadMap(ctx('customer.updated', { webhook_id: 99 }));
    expect(res.skip).toBe(true);
  });

  it('order.refunded with no refunds → skip', async () => {
    const res = await strat.payloadMap(ctx('order.refunded', { id: 5, currency: 'INR', refunds: [] }));
    expect(res.skip).toBe(true);
  });
});

describe('WooCommerceWebhookStrategy.signatureVerify — fail-closed HMAC', () => {
  const strat = new WooCommerceWebhookStrategy();
  const SECRET = 'whsec_test_value';
  const raw = Buffer.from(JSON.stringify({ id: 1 }), 'utf8');
  const validSig = createHmac('sha256', SECRET).update(raw).digest('base64');
  const getSecret = async () => ({ webhookSecret: SECRET, connectorLookupKey: 'https://store.example.com' });

  it('accepts a valid signature and returns the normalised source as the lookup key', async () => {
    const result = await strat.signatureVerify(
      raw,
      { 'x-wc-webhook-source': 'https://store.example.com/', 'x-wc-webhook-signature': validSig },
      getSecret,
    );
    expect(result.lookupKey).toBe('https://store.example.com');
  });

  it('rejects a bad signature (HMAC_INVALID)', async () => {
    await expect(
      strat.signatureVerify(
        raw,
        { 'x-wc-webhook-source': 'https://store.example.com', 'x-wc-webhook-signature': 'not-the-sig' },
        getSecret,
      ),
    ).rejects.toMatchObject({ code: 'HMAC_INVALID' });
  });

  it('rejects when the connector has no webhook_secret (fail-closed)', async () => {
    await expect(
      strat.signatureVerify(
        raw,
        { 'x-wc-webhook-source': 'https://store.example.com', 'x-wc-webhook-signature': validSig },
        async () => ({ webhookSecret: '', connectorLookupKey: 'https://store.example.com' }),
      ),
    ).rejects.toMatchObject({ code: 'HMAC_INVALID' });
  });

  it('rejects when the source header is missing', async () => {
    await expect(
      strat.signatureVerify(raw, { 'x-wc-webhook-signature': validSig }, getSecret),
    ).rejects.toMatchObject({ code: 'HMAC_INVALID' });
  });
});
