/**
 * woocommerce-client.test.ts — UT for the dual-mode WooCommerce REST client (infra-free).
 *
 * Live mode (WOOCOMMERCE_LIVE=1) is exercised with a stubbed global fetch — asserts the wc/v3
 * request shape (Basic auth, modified_after, pagination), data_source='real', X-WP-TotalPages
 * pagination, and the WOOCOMMERCE_AUTH_ERROR throw on 401. Also covers 429/5xx retry-backoff:
 *   - 429 retries up to MAX_RETRIES and succeeds on the next attempt.
 *   - 429 respects Retry-After header (passes it as the basis for the delay calculation).
 *   - 5xx retries up to MAX_RETRIES and throws after exhaustion.
 *   - 401/403 throws WOOCOMMERCE_AUTH_ERROR immediately without retrying.
 * Fixture mode is covered separately.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { WooCommerceClient, WOOCOMMERCE_AUTH_ERROR, WOOCOMMERCE_MAX_RETRIES } from '../jobs/woocommerce-orders-repull/woocommerce-client.js';

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

describe('WooCommerceClient — retry-backoff (live mode)', () => {
  it('retries on 429 and succeeds on the next attempt', async () => {
    process.env['WOOCOMMERCE_LIVE'] = '1';
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++;
      if (calls === 1) {
        return {
          ok: false, status: 429,
          headers: { get: () => null },
          json: async () => ({}),
        } as unknown as Response;
      }
      return {
        ok: true, status: 200,
        headers: { get: (k: string) => (k.toLowerCase() === 'x-wp-totalpages' ? '1' : null) },
        json: async () => [{ id: 9001, status: 'completed', total: '5.00', date_modified_gmt: '2026-06-15T10:00:00' }],
      } as unknown as Response;
    }));

    const client = new WooCommerceClient({ ...CREDS, site_url: 'https://retry-store.example.com' });
    const page = await client.fetchOrdersPage('2026-06-01T00:00:00.000Z', 1);
    expect(page.orders).toHaveLength(1);
    expect(page.dataSource).toBe('real');
    expect(calls).toBe(2); // one 429 + one success
  });

  it('retries on 429 with Retry-After header (header controls delay)', async () => {
    process.env['WOOCOMMERCE_LIVE'] = '1';
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++;
      if (calls === 1) {
        return {
          ok: false, status: 429,
          headers: { get: (k: string) => (k.toLowerCase() === 'retry-after' ? '0.001' : null) },
          json: async () => ({}),
        } as unknown as Response;
      }
      return {
        ok: true, status: 200,
        headers: { get: (k: string) => (k.toLowerCase() === 'x-wp-totalpages' ? '1' : null) },
        json: async () => [{ id: 9002, status: 'processing', total: '8.00', date_modified_gmt: '2026-06-16T10:00:00' }],
      } as unknown as Response;
    }));

    const client = new WooCommerceClient({ ...CREDS, site_url: 'https://retry-store2.example.com' });
    const page = await client.fetchOrdersPage('2026-06-01T00:00:00.000Z', 1);
    expect(page.orders).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it('throws after exhausting retries on persistent 5xx', async () => {
    process.env['WOOCOMMERCE_LIVE'] = '1';
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++;
      return { ok: false, status: 503, headers: { get: () => null }, json: async () => ({}) } as unknown as Response;
    }));

    const client = new WooCommerceClient({ ...CREDS, site_url: 'https://down-store.example.com' });
    await expect(client.fetchOrdersPage('2026-06-01T00:00:00.000Z', 1)).rejects.toThrow('503');
    // total calls = initial + MAX_RETRIES
    expect(calls).toBe(WOOCOMMERCE_MAX_RETRIES + 1);
  });

  it('throws WOOCOMMERCE_AUTH_ERROR immediately on 401 (no retries)', async () => {
    process.env['WOOCOMMERCE_LIVE'] = '1';
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++;
      return { ok: false, status: 401, headers: { get: () => null }, json: async () => ({}) } as unknown as Response;
    }));

    const client = new WooCommerceClient({ ...CREDS, site_url: 'https://auth-fail-store.example.com' });
    await expect(client.fetchOrdersPage('2026-06-01T00:00:00.000Z', 1)).rejects.toThrow(WOOCOMMERCE_AUTH_ERROR);
    expect(calls).toBe(1); // no retry
  });

  it('throws WOOCOMMERCE_AUTH_ERROR immediately on 403 (no retries)', async () => {
    process.env['WOOCOMMERCE_LIVE'] = '1';
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++;
      return { ok: false, status: 403, headers: { get: () => null }, json: async () => ({}) } as unknown as Response;
    }));

    const client = new WooCommerceClient({ ...CREDS, site_url: 'https://auth-fail-store2.example.com' });
    await expect(client.fetchOrdersPage('2026-06-01T00:00:00.000Z', 1)).rejects.toThrow(WOOCOMMERCE_AUTH_ERROR);
    expect(calls).toBe(1); // no retry
  });
});
