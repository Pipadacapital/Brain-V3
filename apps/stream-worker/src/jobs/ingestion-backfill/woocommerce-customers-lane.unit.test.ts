/**
 * woocommerce-customers-lane.unit.test.ts — regression coverage for the historically-FAILED
 * WooCommerce customers poll lane.
 *
 * ROOT CAUSE: the generic wc/v3 list client sent `?orderby=modified&modified_after=…&dates_are_gmt=true`
 * to EVERY list endpoint, but /customers supports NONE of those params (its `orderby` enum is
 * id|include|name|registered_date and the controller has no date filters) → WooCommerce answered
 * 400 rest_invalid_param on every live poll → the customers resource backfill failed every tick.
 *
 * FIX: windowing:'none' for customers — full-directory walk ordered by registered_date asc (the only
 * chronological orderby the endpoint accepts); the framework's deterministic dedup keeps the re-walk
 * idempotent. Products/coupons keep the modified window (they support it).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WooCustomersFetcher, WooProductsFetcher } from './woocommerce-resource-fetchers.js';
import {
  WOOCOMMERCE_CUSTOMERS_RESOURCE,
  WOOCOMMERCE_PRODUCTS_RESOURCE,
} from '@brain/woocommerce-mapper';

const BRAND = '11111111-1111-1111-1111-111111111111';
const SALT = 'a'.repeat(64);
const CREDS = {
  consumer_key: 'ck_test',
  consumer_secret: 'cs_test',
  site_url: 'https://store.example.com',
};

const FLOOR = new Date('2024-01-01T00:00:00Z');

function stubFetch(): { urls: string[] } {
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    urls.push(String(url));
    return {
      ok: true,
      status: 200,
      headers: { get: () => '1' },
      json: async () => [],
    } as unknown as Response;
  }));
  return { urls };
}

beforeEach(() => {
  process.env['WOOCOMMERCE_LIVE'] = '1';
});

afterEach(() => {
  delete process.env['WOOCOMMERCE_LIVE'];
  vi.unstubAllGlobals();
});

describe('WooCommerce customers lane (windowing fix)', () => {
  it('customers live URL uses orderby=registered_date and NO modified-window params (the 400 fix)', async () => {
    const { urls } = stubFetch();
    const fetcher = new WooCustomersFetcher(CREDS, BRAND, SALT, 'IN', 'INR');

    await fetcher.fetchPage({ resource: WOOCOMMERCE_CUSTOMERS_RESOURCE, cursor: null, floorAt: FLOOR });

    expect(urls).toHaveLength(1);
    const url = urls[0]!;
    expect(url).toContain('/wp-json/wc/v3/customers');
    expect(url).toContain('orderby=registered_date');
    expect(url).toContain('order=asc');
    // The three params /customers rejects (rest_invalid_param) must NOT be sent:
    expect(url).not.toContain('orderby=modified');
    expect(url).not.toContain('modified_after');
    expect(url).not.toContain('dates_are_gmt');
  });

  it('products live URL KEEPS the modified window (supported there — no behaviour change)', async () => {
    const { urls } = stubFetch();
    const fetcher = new WooProductsFetcher(CREDS, BRAND, 'INR');

    await fetcher.fetchPage({ resource: WOOCOMMERCE_PRODUCTS_RESOURCE, cursor: null, floorAt: FLOOR });

    expect(urls).toHaveLength(1);
    const url = urls[0]!;
    expect(url).toContain('/wp-json/wc/v3/products');
    expect(url).toContain('orderby=modified');
    expect(url).toContain(`modified_after=${encodeURIComponent(FLOOR.toISOString())}`);
  });

  it('customers walk terminates (empty page → nextCursor null, no records)', async () => {
    stubFetch();
    const fetcher = new WooCustomersFetcher(CREDS, BRAND, SALT, 'IN', 'INR');

    const page = await fetcher.fetchPage({ resource: WOOCOMMERCE_CUSTOMERS_RESOURCE, cursor: null, floorAt: FLOOR });

    expect(page.records).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });
});
