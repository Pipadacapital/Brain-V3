/**
 * @brain/shopify-mapper/resources unit tests (ingestion-framework onboarding).
 *
 * Locks the pure mappers for the additional Shopify resources (products, customers, refunds,
 * fulfillments) AND the SHOPIFY_MANIFEST validity. Focus: money is exact minor-units (I-S07), PII is
 * hashed-only (D-10), the dedup identity is per-state for catalogue/profile resources and stable for
 * refunds/fulfillments, and the manifest passes assertManifestValid.
 */
import { describe, it, expect } from 'vitest';
import { assertManifestValid, backfillableResources } from '@brain/connector-core';
import {
  SHOPIFY_MANIFEST,
  SHOPIFY_PROVIDER,
  mapProductToDraft,
  mapCustomerToDraft,
  mapRefundToDraft,
  mapFulfillmentToDraft,
  PRODUCT_UPSERT_V1_EVENT_NAME,
  CUSTOMER_UPSERT_V1_EVENT_NAME,
  REFUND_RECORDED_V1_EVENT_NAME,
  FULFILLMENT_RECORDED_V1_EVENT_NAME,
  type ShopifyProductShape,
  type ShopifyCustomerShape,
  type ShopifyRefundShape,
  type ShopifyFulfillmentShape,
} from './index.js';

const BRAND = '11111111-1111-1111-1111-111111111111';
const SALT = 'a'.repeat(64);

describe('SHOPIFY_MANIFEST', () => {
  it('is internally valid (assertManifestValid does not throw)', () => {
    expect(() => assertManifestValid(SHOPIFY_MANIFEST)).not.toThrow();
  });

  it('declares the additional resources as backfillable REST resources', () => {
    expect(SHOPIFY_MANIFEST.provider).toBe(SHOPIFY_PROVIDER);
    const names = backfillableResources(SHOPIFY_MANIFEST).map((r) => r.name).sort();
    expect(names).toEqual(['customers', 'fulfillments', 'orders', 'products', 'refunds']);
  });

  it('every backfillable resource declares a cursorStrategy + a positive window', () => {
    for (const r of backfillableResources(SHOPIFY_MANIFEST)) {
      expect(r.cursorStrategy).toBeTruthy();
      expect(r.maxBackfillWindowMs).toBeGreaterThan(0);
    }
  });
});

describe('mapProductToDraft', () => {
  const product: ShopifyProductShape = {
    id: 900,
    title: 'Test Tee',
    handle: 'test-tee',
    status: 'active',
    product_type: 'apparel',
    vendor: 'Acme',
    updated_at: '2026-06-01T10:00:00Z',
    variants: [
      { id: 1, sku: 'TEE-S', title: 'S', price: '499.00', inventory_quantity: 10 },
      { id: 2, sku: 'TEE-M', title: 'M', price: '499.50', inventory_quantity: 5 },
    ],
  };

  it('projects variants with exact minor-units price (I-S07)', () => {
    const rec = mapProductToDraft(product, BRAND);
    expect(rec.events).toHaveLength(1);
    const props = rec.events[0]!.properties as Record<string, unknown>;
    expect(rec.events[0]!.event_name).toBe(PRODUCT_UPSERT_V1_EVENT_NAME);
    expect(props['product_id']).toBe('900');
    const variants = props['variants'] as Array<Record<string, unknown>>;
    expect(variants[0]!['price_minor']).toBe('49900');
    expect(variants[1]!['price_minor']).toBe('49950');
  });

  it('folds updated_at into the dedup identity (per-state restatement)', () => {
    const a = mapProductToDraft(product, BRAND);
    const b = mapProductToDraft({ ...product, updated_at: '2026-06-02T10:00:00Z' }, BRAND);
    expect(a.providerId).not.toBe(b.providerId);
    // same state → same identity
    const a2 = mapProductToDraft(product, BRAND);
    expect(a.providerId).toBe(a2.providerId);
  });
});

describe('mapCustomerToDraft (hashed PII only — D-10)', () => {
  const customer: ShopifyCustomerShape = {
    id: 555,
    email: 'shopper@example.com',
    phone: '+919876543210',
    updated_at: '2026-06-01T10:00:00Z',
    orders_count: 3,
    total_spent: '1500.00',
    state: 'enabled',
    currency: 'INR',
  };

  it('emits ONLY hashed identifiers — no raw email/phone in the payload', () => {
    const rec = mapCustomerToDraft(customer, BRAND, SALT, 'IN');
    const props = rec.events[0]!.properties as Record<string, unknown>;
    expect(rec.events[0]!.event_name).toBe(CUSTOMER_UPSERT_V1_EVENT_NAME);
    expect(props['customer_id']).toBe('555');
    expect(props['total_spent_minor']).toBe('150000');
    expect(typeof props['hashed_customer_email']).toBe('string');
    expect((props['hashed_customer_email'] as string)).toMatch(/^[0-9a-f-]{36}$|^[0-9a-f]{64}$/);
    // No raw PII leaks
    expect(JSON.stringify(props)).not.toContain('shopper@example.com');
    expect(JSON.stringify(props)).not.toContain('9876543210');
  });

  it('omits hashed identifiers entirely when the customer has no email/phone', () => {
    const rec = mapCustomerToDraft({ id: 7, updated_at: '2026-06-01T10:00:00Z' }, BRAND, SALT, 'IN');
    const props = rec.events[0]!.properties as Record<string, unknown>;
    expect(props['hashed_customer_email']).toBeUndefined();
    expect(props['hashed_customer_phone']).toBeUndefined();
  });
});

describe('mapRefundToDraft', () => {
  const refund: ShopifyRefundShape = {
    id: 7001,
    order_id: 12345,
    processed_at: '2026-06-03T10:00:00Z',
    note: 'damaged',
    currency: 'INR',
    transactions: [
      { amount: '200.00', kind: 'refund', status: 'success' },
      { amount: '50.00', kind: 'refund', status: 'success' },
      { amount: '999.00', kind: 'refund', status: 'failure' }, // ignored
    ],
  };

  it('sums only SETTLED refund transactions (exact minor units)', () => {
    const rec = mapRefundToDraft(refund, BRAND, null);
    const props = rec.events[0]!.properties as Record<string, unknown>;
    expect(rec.events[0]!.event_name).toBe(REFUND_RECORDED_V1_EVENT_NAME);
    expect(props['amount_minor']).toBe('25000'); // 200 + 50, the failed 999 excluded
    expect(props['order_id']).toBe('12345');
    expect(rec.providerId).toBe('7001'); // stable id (provider_id dedup)
  });

  it('falls back to the order currency when the refund omits one', () => {
    const rec = mapRefundToDraft({ ...refund, currency: null }, BRAND, 'USD');
    const props = rec.events[0]!.properties as Record<string, unknown>;
    expect(props['currency_code']).toBe('USD');
  });

  it('throws on a refund with no id (fail loud, never fabricate identity)', () => {
    expect(() => mapRefundToDraft({ ...refund, id: null }, BRAND, null)).toThrow();
  });
});

describe('mapFulfillmentToDraft', () => {
  const fulfillment: ShopifyFulfillmentShape = {
    id: 8001,
    order_id: 12345,
    status: 'success',
    shipment_status: 'in_transit',
    tracking_company: 'BlueDart',
    tracking_number: 'BD123',
    updated_at: '2026-06-04T10:00:00Z',
  };

  it('projects the logistics facts with a stable id', () => {
    const rec = mapFulfillmentToDraft(fulfillment, BRAND);
    const props = rec.events[0]!.properties as Record<string, unknown>;
    expect(rec.events[0]!.event_name).toBe(FULFILLMENT_RECORDED_V1_EVENT_NAME);
    expect(props['fulfillment_id']).toBe('8001');
    expect(props['shipment_status']).toBe('in_transit');
    expect(rec.providerId).toBe('8001');
  });

  it('throws on a fulfillment with no id', () => {
    expect(() => mapFulfillmentToDraft({ ...fulfillment, id: null }, BRAND)).toThrow();
  });
});
