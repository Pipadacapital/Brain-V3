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
  PRODUCT_UPSERT_V1_EVENT_NAME,
  ORDER_LIVE_V1_EVENT_NAME,
  type WooProductShape,
  type WooOrderShape,
} from './index.js';

const BRAND = '22222222-2222-2222-2222-222222222222';
const SALT = 'b'.repeat(64);

describe('WOOCOMMERCE_MANIFEST', () => {
  it('is internally valid', () => {
    expect(() => assertManifestValid(WOOCOMMERCE_MANIFEST)).not.toThrow();
  });

  it('declares orders + products as backfillable REST resources', () => {
    expect(WOOCOMMERCE_MANIFEST.provider).toBe(WOOCOMMERCE_PROVIDER);
    const names = backfillableResources(WOOCOMMERCE_MANIFEST).map((r) => r.name).sort();
    expect(names).toEqual(['orders', 'products']);
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

  it('projects price in exact minor units and a per-state dedup identity', () => {
    const rec = mapWooProductToDraft(product, BRAND);
    expect(rec.events[0]!.event_name).toBe(PRODUCT_UPSERT_V1_EVENT_NAME);
    const props = rec.events[0]!.properties as Record<string, unknown>;
    expect(props['product_id']).toBe('700');
    expect(props['price_minor']).toBe('29900');
    expect(props['stock_quantity']).toBe(42);

    const b = mapWooProductToDraft({ ...product, date_modified_gmt: '2026-06-05T10:00:00' }, BRAND);
    expect(rec.providerId).not.toBe(b.providerId);
  });
});
