/**
 * woocommerce-resource-fetchers.test.ts — UT for the WooCommerce resumable-backfill page fetchers
 * (products / customers / coupons / refunds), infra-free (stubbed global fetch, live HTTP mode).
 *
 * Asserts the Slice-4 guarantees for the non-order resources:
 *   - CANONICAL MAPPING — each fetcher emits the SHARED canonical type (product.upsert.v1 /
 *     customer.upsert.v1 / coupon.upsert.v1 / refund.recorded.v1) the existing silver builders
 *     consume; refunds are fanned out of each order's nested refunds[].
 *   - PAGINATION — page_number cursor "page#modifiedAfterIso"; X-WP-TotalPages drives hasMore; the
 *     modified_after lower bound is carried across pages so resume re-uses the window floor.
 *   - IDEMPOTENCY — the dedup providerId is stable across a re-map (id+date_modified for the
 *     per-state resources; the globally-unique refund id for refunds).
 *   - MONEY (currency-aware) — JPY (0dp, no x100 inflation) + KWD (3dp) + INR (2dp) are scaled by the
 *     store currency passed in, never a hardcoded x100 / INR default.
 *   - PII — customer raw email/phone are hashed + dropped (only salted hashes leave).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { getResource, type ResourceDescriptor } from '@brain/connector-core';
import { WOOCOMMERCE_MANIFEST } from '@brain/woocommerce-mapper';
import {
  WooProductsFetcher,
  WooCustomersFetcher,
  WooCouponsFetcher,
  WooRefundsFetcher,
  parsePageCursor,
  buildPageCursor,
} from '../jobs/ingestion-backfill/woocommerce-resource-fetchers.js';

const CREDS = { consumer_key: 'ck_x', consumer_secret: 'cs_y', site_url: 'https://store.example.com/' };
const BRAND = '5b2e975c-7186-4608-84d6-760f51fe2389';
const SALT = 'a'.repeat(64);
const REGION = 'IN';
const FLOOR = new Date('2024-06-01T00:00:00.000Z');

const PRODUCTS = getResource(WOOCOMMERCE_MANIFEST, 'products');
const CUSTOMERS = getResource(WOOCOMMERCE_MANIFEST, 'customers');
const COUPONS = getResource(WOOCOMMERCE_MANIFEST, 'coupons');
const REFUNDS = getResource(WOOCOMMERCE_MANIFEST, 'refunds');

/** Stub global fetch with a single 200 JSON-array response + an X-WP-TotalPages header. */
function stubList(body: unknown[], totalPages: string | null): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: (k: string) => (k.toLowerCase() === 'x-wp-totalpages' ? totalPages : null) },
    json: async () => body,
  } as unknown as Response));
  vi.stubGlobal('fetch', fn);
  return fn;
}

function props(rec: { events: readonly { properties: Record<string, unknown> }[] }): Record<string, unknown> {
  return rec.events[0]!.properties;
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env['WOOCOMMERCE_LIVE'];
});

describe('page cursor codec', () => {
  it('round-trips page + modifiedAfter and floors a null cursor to page 1', () => {
    expect(parsePageCursor(null, FLOOR)).toEqual({ page: 1, modifiedAfterIso: FLOOR.toISOString() });
    const c = buildPageCursor(3, '2025-01-02T03:04:05.000Z');
    expect(parsePageCursor(c, FLOOR)).toEqual({ page: 3, modifiedAfterIso: '2025-01-02T03:04:05.000Z' });
  });
});

describe('WooProductsFetcher — canonical mapping + currency + pagination', () => {
  it('emits product.upsert.v1 with currency-aware price (JPY 0dp, no x100) and a next cursor', async () => {
    process.env['WOOCOMMERCE_LIVE'] = '1';
    const fetchFn = stubList(
      [{ id: 7001, name: 'Tee', price: '1200', date_modified_gmt: '2025-03-01T10:00:00' }],
      '2', // page 1 of 2 → hasMore
    );
    const fetcher = new WooProductsFetcher(CREDS, BRAND, 'JPY');
    const page = await fetcher.fetchPage({ resource: PRODUCTS as ResourceDescriptor, cursor: null, floorAt: FLOOR });

    expect(page.records).toHaveLength(1);
    expect(page.records[0]!.events[0]!.event_name).toBe('product.upsert.v1');
    const p = props(page.records[0]!);
    expect(p['currency_code']).toBe('JPY');
    expect(p['price_minor']).toBe('1200'); // JPY is 0dp → no x100 inflation
    expect(page.nextCursor).toBe(buildPageCursor(2, FLOOR.toISOString()));
    // request shape: wc/v3 /products with modified_after window
    expect((fetchFn.mock.calls[0]![0] as string)).toContain('/wp-json/wc/v3/products');
    expect((fetchFn.mock.calls[0]![0] as string)).toContain('modified_after=2024-06-01');
  });

  it('KWD (3dp) scales correctly and the last page reports no next cursor', async () => {
    process.env['WOOCOMMERCE_LIVE'] = '1';
    stubList([{ id: 7002, name: 'Bag', price: '12.345', date_modified_gmt: '2025-03-02T10:00:00' }], '1');
    const fetcher = new WooProductsFetcher(CREDS, BRAND, 'KWD');
    const page = await fetcher.fetchPage({ resource: PRODUCTS as ResourceDescriptor, cursor: null, floorAt: FLOOR });
    expect(props(page.records[0]!)['price_minor']).toBe('12345'); // 3dp
    expect(page.nextCursor).toBeNull();
  });

  it('providerId folds id+date_modified and is stable across a re-map (idempotent)', async () => {
    process.env['WOOCOMMERCE_LIVE'] = '1';
    const make = () => {
      stubList([{ id: 7003, name: 'Cap', price: '500.00', date_modified_gmt: '2025-03-03T10:00:00' }], '1');
      return new WooProductsFetcher(CREDS, BRAND, 'INR').fetchPage({
        resource: PRODUCTS as ResourceDescriptor, cursor: null, floorAt: FLOOR,
      });
    };
    const a = await make();
    const b = await make();
    expect(a.records[0]!.providerId).toBe(b.records[0]!.providerId);
    expect(a.records[0]!.providerId).toContain('7003:');
  });
});

describe('WooCustomersFetcher — directory + hashed PII', () => {
  it('emits customer.upsert.v1 with hashed email and NO raw PII, currency-aware LTV', async () => {
    process.env['WOOCOMMERCE_LIVE'] = '1';
    stubList(
      [{
        id: 9100, email: 'buyer@example.com', total_spent: '99.99', orders_count: 3,
        date_modified_gmt: '2025-04-01T10:00:00', billing: { phone: '+919812345678', country: 'IN' },
      }],
      '1',
    );
    const fetcher = new WooCustomersFetcher(CREDS, BRAND, SALT, REGION, 'INR');
    const page = await fetcher.fetchPage({ resource: CUSTOMERS as ResourceDescriptor, cursor: null, floorAt: FLOOR });
    const p = props(page.records[0]!);
    expect(page.records[0]!.events[0]!.event_name).toBe('customer.upsert.v1');
    expect(p['total_spent_minor']).toBe('9999'); // INR 2dp
    expect(p['currency_code']).toBe('INR');
    expect(typeof p['hashed_customer_email']).toBe('string');
    expect(JSON.stringify(p)).not.toContain('buyer@example.com'); // raw PII dropped
    expect(JSON.stringify(p)).not.toContain('9812345678');
    expect(p['billing_country']).toBe('IN'); // coarse geo (non-PII) carried
  });
});

describe('WooCouponsFetcher — fixed vs percent (money discipline)', () => {
  it('fixed coupon → amount_minor (currency-aware), percent coupon → amount_percent (never scaled)', async () => {
    process.env['WOOCOMMERCE_LIVE'] = '1';
    stubList(
      [
        { id: 11, code: 'FLAT200', amount: '200.00', discount_type: 'fixed_cart', date_modified_gmt: '2025-05-01T10:00:00' },
        { id: 12, code: 'SAVE10', amount: '10', discount_type: 'percent', date_modified_gmt: '2025-05-02T10:00:00' },
      ],
      '1',
    );
    const fetcher = new WooCouponsFetcher(CREDS, BRAND, 'INR');
    const page = await fetcher.fetchPage({ resource: COUPONS as ResourceDescriptor, cursor: null, floorAt: FLOOR });
    expect(page.records).toHaveLength(2);
    const fixed = props(page.records[0]!);
    expect(fixed['amount_minor']).toBe('20000'); // 200.00 INR
    expect(fixed['amount_percent']).toBeNull();
    expect(fixed['currency_code']).toBe('INR');
    const pct = props(page.records[1]!);
    expect(pct['amount_percent']).toBe('10'); // verbatim — NOT scaled to money
    expect(pct['amount_minor']).toBeNull();
    expect(pct['currency_code']).toBeNull();
  });
});

describe('WooRefundsFetcher — fans order.refunds[] into standalone refund.recorded.v1', () => {
  it('walks orders and emits one refund per nested refund, ABS minor units from the order currency', async () => {
    process.env['WOOCOMMERCE_LIVE'] = '1';
    stubList(
      [{
        id: 4001, currency: 'INR', date_modified_gmt: '2025-06-01T10:00:00',
        refunds: [
          { id: 5001, total: '-500.00', reason: 'damaged', date_created: '2025-06-01T11:00:00' },
          { id: 5002, total: '-120.50', reason: 'late', date_created: '2025-06-02T11:00:00' },
        ],
      }],
      '1',
    );
    const fetcher = new WooRefundsFetcher(CREDS, BRAND);
    const page = await fetcher.fetchPage({ resource: REFUNDS as ResourceDescriptor, cursor: null, floorAt: FLOOR });
    expect(page.records).toHaveLength(2);
    expect(page.records[0]!.events[0]!.event_name).toBe('refund.recorded.v1');
    const r0 = props(page.records[0]!);
    expect(r0['amount_minor']).toBe('50000'); // abs(-500.00) INR 2dp
    expect(r0['order_id']).toBe('4001');
    expect(r0['currency_code']).toBe('INR');
    // refund dedup identity is the globally-unique refund id (provider_id strategy)
    expect(page.records[0]!.providerId).toBe('5001');
    expect(page.records[1]!.providerId).toBe('5002');
  });

  it('an order with no refunds contributes no records', async () => {
    process.env['WOOCOMMERCE_LIVE'] = '1';
    stubList([{ id: 4002, currency: 'INR', date_modified_gmt: '2025-06-03T10:00:00', refunds: [] }], '1');
    const fetcher = new WooRefundsFetcher(CREDS, BRAND);
    const page = await fetcher.fetchPage({ resource: REFUNDS as ResourceDescriptor, cursor: null, floorAt: FLOOR });
    expect(page.records).toHaveLength(0);
    expect(page.nextCursor).toBeNull();
  });
});
