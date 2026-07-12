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
  SHOPIFY_INVENTORY_LEVELS_RESOURCE,
  mapProductToDraft,
  mapCustomerToDraft,
  mapRefundToDraft,
  mapFulfillmentToDraft,
  mapInventoryLevelToDraft,
  PRODUCT_UPSERT_V1_EVENT_NAME,
  CUSTOMER_UPSERT_V1_EVENT_NAME,
  REFUND_RECORDED_V1_EVENT_NAME,
  FULFILLMENT_RECORDED_V1_EVENT_NAME,
  INVENTORY_LEVEL_V1_EVENT_NAME,
  type ShopifyProductShape,
  type ShopifyCustomerShape,
  type ShopifyRefundShape,
  type ShopifyFulfillmentShape,
  type ShopifyInventoryLevelShape,
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

  it('declares inventory_levels as a WEBHOOK resource that can NEVER reach the backfill driver', () => {
    expect(SHOPIFY_MANIFEST.resources).toContain(SHOPIFY_INVENTORY_LEVELS_RESOURCE);
    expect(SHOPIFY_INVENTORY_LEVELS_RESOURCE.kind).toBe('webhook');
    expect(SHOPIFY_INVENTORY_LEVELS_RESOURCE.backfillSupported).toBe(false);
    // backfillableResources filters kind==='rest' — the live-only lane is excluded by construction.
    expect(backfillableResources(SHOPIFY_MANIFEST).map((r) => r.name)).not.toContain('inventory_levels');
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

  it('projects inventory_item_id + compare_at_price_minor (mapper widening) and honest-nulls them when absent', () => {
    const widened = mapProductToDraft(
      {
        ...product,
        variants: [
          { id: 1, sku: 'TEE-S', title: 'S', price: '499.00', inventory_quantity: 10, inventory_item_id: 39072856, compare_at_price: '599.00' },
          { id: 2, sku: 'TEE-M', title: 'M', price: '499.50', inventory_quantity: 5 }, // legacy payload
        ],
      },
      BRAND,
    );
    const variants = (widened.events[0]!.properties as Record<string, unknown>)['variants'] as Array<Record<string, unknown>>;
    expect(variants[0]!['inventory_item_id']).toBe('39072856');
    expect(variants[0]!['compare_at_price_minor']).toBe('59900'); // exact minor units (I-S07)
    expect(variants[1]!['inventory_item_id']).toBeNull();
    expect(variants[1]!['compare_at_price_minor']).toBeNull();
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

  it('projects coarse default_address geo + consent states (mapper widening) — no street/name PII', () => {
    const rec = mapCustomerToDraft(
      {
        ...customer,
        default_address: { city: 'Mumbai', province: 'Maharashtra', province_code: 'MH', zip: '400001', country_code: 'IN' },
        email_marketing_consent: { state: 'subscribed', opt_in_level: 'single_opt_in' },
        sms_marketing_consent: { state: 'not_subscribed' },
        accepts_marketing: true,
      },
      BRAND,
      SALT,
      'IN',
    );
    const props = rec.events[0]!.properties as Record<string, unknown>;
    expect(props['default_address_city']).toBe('Mumbai');
    expect(props['default_address_province']).toBe('MH'); // province_code preferred over the name
    expect(props['default_address_zip']).toBe('400001');
    expect(props['default_address_country_code']).toBe('IN');
    expect(props['email_marketing_consent_state']).toBe('subscribed');
    expect(props['sms_marketing_consent_state']).toBe('not_subscribed');
    expect(props['accepts_marketing']).toBe(true);
  });

  it('leaves the widened fields honest-absent on a legacy payload (byte-identical pre-widening output)', () => {
    const rec = mapCustomerToDraft(customer, BRAND, SALT, 'IN');
    const props = rec.events[0]!.properties as Record<string, unknown>;
    for (const k of [
      'default_address_city', 'default_address_province', 'default_address_zip',
      'default_address_country_code', 'email_marketing_consent_state',
      'sms_marketing_consent_state', 'accepts_marketing',
    ]) {
      expect(props[k]).toBeUndefined();
    }
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

describe('mapInventoryLevelToDraft (inventory_levels/update — P1 webhook expansion)', () => {
  const level: ShopifyInventoryLevelShape = {
    inventory_item_id: 39072856,
    location_id: 905684977,
    available: 6,
    updated_at: '2026-06-05T10:00:00Z',
  };

  it('emits inventory.level.v1 at the item×location grain (NOT product.upsert.v1 — no product_id exists)', () => {
    const rec = mapInventoryLevelToDraft(level, BRAND);
    expect(rec.events).toHaveLength(1);
    const draft = rec.events[0]!;
    expect(draft.event_name).toBe(INVENTORY_LEVEL_V1_EVENT_NAME);
    const props = draft.properties as Record<string, unknown>;
    expect(props['inventory_item_id']).toBe('39072856');
    expect(props['location_id']).toBe('905684977');
    expect(props['available']).toBe(6);
    expect(draft.provenance.brand_id).toBe(BRAND);
  });

  it('folds updated_at into the dedup identity — distinct states land, same-state retries dedup', () => {
    const a = mapInventoryLevelToDraft(level, BRAND);
    const retry = mapInventoryLevelToDraft(level, BRAND);
    const nextState = mapInventoryLevelToDraft({ ...level, available: 5, updated_at: '2026-06-05T10:05:00Z' }, BRAND);
    expect(a.providerId).toBe(retry.providerId);
    expect(a.providerId).not.toBe(nextState.providerId);
  });

  it('passes negative (oversold) and null (untracked) available through honestly', () => {
    const oversold = mapInventoryLevelToDraft({ ...level, available: -2 }, BRAND);
    expect((oversold.events[0]!.properties as Record<string, unknown>)['available']).toBe(-2);
    const untracked = mapInventoryLevelToDraft({ ...level, available: null }, BRAND);
    expect((untracked.events[0]!.properties as Record<string, unknown>)['available']).toBeNull();
  });

  it('throws on a missing inventory_item_id (unaddressable observation — fail loud)', () => {
    expect(() => mapInventoryLevelToDraft({ ...level, inventory_item_id: null }, BRAND)).toThrow();
  });
});
