/**
 * woocommerce-client.test.ts — UT for the dual-mode WooCommerce REST client (infra-free).
 *
 * Live mode (WOOCOMMERCE_LIVE=1) is exercised with a stubbed global fetch — asserts the wc/v3
 * request shape (Basic auth, modified_after, pagination), data_source='real', X-WP-TotalPages
 * pagination, and the WOOCOMMERCE_AUTH_ERROR throw on 401. Fixture mode is covered separately.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { WooCommerceClient, WOOCOMMERCE_AUTH_ERROR } from '../jobs/woocommerce-orders-repull/woocommerce-client.js';

const CREDS = { consumer_key: 'ck_x', consumer_secret: 'cs_y', site_url: 'https://store.example.com/' };

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env['WOOCOMMERCE_LIVE'];
});

describe('WooCommerceClient — live HTTP mode', () => {
  it('issues a Basic-auth wc/v3 request with modified_after + pagination, returns data_source=real', async () => {
    process.env['WOOCOMMERCE_LIVE'] = '1';
    const calls: { url: string; headers: Record<string, string> }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, headers: init.headers });
      return {
        ok: true,
        status: 200,
        headers: { get: (k: string) => (k.toLowerCase() === 'x-wp-totalpages' ? '2' : null) },
        json: async () => [{ id: 4001, status: 'processing', total: '10.00', date_modified_gmt: '2026-06-11T09:30:00' }],
      } as unknown as Response;
    }));

    const client = new WooCommerceClient(CREDS);
    const page = await client.fetchOrdersPage('2026-06-01T00:00:00.000Z', 1);

    expect(page.dataSource).toBe('real');
    expect(page.orders).toHaveLength(1);
    expect(page.hasMore).toBe(true); // page 1 of 2
    // request shape
    expect(calls[0]!.url).toContain('/wp-json/wc/v3/orders');
    expect(calls[0]!.url).toContain('modified_after=2026-06-01');
    expect(calls[0]!.url).toContain('per_page=100');
    expect(calls[0]!.headers['Authorization']).toBe(
      'Basic ' + Buffer.from('ck_x:cs_y').toString('base64'),
    );
  });

  it('throws WOOCOMMERCE_AUTH_ERROR on 401 (reconnect signal)', async () => {
    process.env['WOOCOMMERCE_LIVE'] = '1';
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 401,
      headers: { get: () => null },
      json: async () => ({}),
    } as unknown as Response)));

    const client = new WooCommerceClient(CREDS);
    await expect(client.fetchOrdersPage('2026-06-01T00:00:00.000Z', 1)).rejects.toThrow(WOOCOMMERCE_AUTH_ERROR);
  });

  it('last page (page >= totalPages) reports hasMore=false', async () => {
    process.env['WOOCOMMERCE_LIVE'] = '1';
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: (k: string) => (k.toLowerCase() === 'x-wp-totalpages' ? '2' : null) },
      json: async () => [{ id: 4002, status: 'completed', total: '20.00', date_modified_gmt: '2026-06-12T00:00:00' }],
    } as unknown as Response)));

    const client = new WooCommerceClient(CREDS);
    const page = await client.fetchOrdersPage('2026-06-01T00:00:00.000Z', 2);
    expect(page.hasMore).toBe(false);
  });
});

describe('WooCommerceClient — dev fixture mode (default, no live flag)', () => {
  it('reads the synthetic fixture and stamps data_source=synthetic', async () => {
    const client = new WooCommerceClient(CREDS);
    const page = await client.fetchOrdersPage('2026-01-01T00:00:00.000Z', 1);
    expect(page.dataSource).toBe('synthetic');
    // the committed fixture has 4 synthetic orders within a recent window
    expect(page.orders.length).toBeGreaterThan(0);
  });
});
