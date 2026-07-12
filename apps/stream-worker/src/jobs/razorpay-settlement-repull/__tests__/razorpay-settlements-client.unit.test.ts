/**
 * razorpay-settlements-client unit tests — DOCUMENTED recon query shape (audit fix).
 *
 * razorpay.com/docs/api/settlements/fetch-recon (verified 2026-07-12): recon/combined takes
 * year (YYYY, required) + month (MM, required) [+ day] + count + skip — NOT from/to Unix
 * timestamps. These tests pin:
 *   CL-1: fetchReconMonthPage sends year/month/count/skip (and NEVER from/to)
 *   CL-2: fetchReconMonthPage skip pagination + hasMore
 *   CL-3: reconMonthsForWindow — IST month walk covering the window (±1 day pad)
 *   CL-4: reconItemWithinWindow — settled_at/created_at window filter (timestampless kept)
 *   CL-5: fetchAllReconItems — month walk × skip pages × window filter, against recorded
 *         docs-shape fixtures (type/settlement_utr/debit/credit fields)
 *   CL-6: 429 → Retry-After back-off then success
 *   CL-7: 401 → RAZORPAY_AUTH_ERROR thrown (repull lane keys its RECONNECT_REQUIRED on it)
 *
 * No network: global fetch is stubbed with recorded response fixtures.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  RazorpaySettlementsClient,
  reconMonthsForWindow,
  reconItemWithinWindow,
  type RazorpayReconItem,
} from '../razorpay-settlements-client.js';

// ── Recorded docs-shape fixtures (razorpay.com/docs/api/settlements/fetch-recon example) ──

function reconItem(overrides: Partial<RazorpayReconItem> = {}): RazorpayReconItem {
  return {
    entity_id: 'txn_DocsExample00001',
    type: 'payment',
    debit: 0,
    credit: 97300,
    amount: 100000,
    currency: 'INR',
    fee: 2000,
    tax: 360,
    on_hold: false,
    settled: true,
    created_at: 1751328000,        // 2025-07-01T00:00:00Z
    settled_at: 1751414400,        // 2025-07-02T00:00:00Z
    settlement_id: 'setl_DocsExample0001',
    payment_id: 'pay_DocsExample00001',
    settlement_utr: 'UTR2025070200000001',
    order_id: 'order_DocsExample0001',
    ...overrides,
  };
}

type FetchCall = { url: URL };

/** Install a fetch stub that answers each recon request via `respond(url)`. */
function stubFetch(respond: (url: URL, callIndex: number) => Response | Promise<Response>): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    calls.push({ url });
    return respond(url, calls.length - 1);
  }));
  return calls;
}

function jsonResponse(items: RazorpayReconItem[], status = 200): Response {
  return new Response(JSON.stringify({ entity: 'collection', count: items.length, items }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const CREDS = { keyId: 'rzp_test_key', keySecret: 'rzp_test_secret' };

// July 2025 window (IST + UTC agree away from month edges)
const FROM_TS = 1751500800; // 2025-07-03T00:00:00Z
const TO_TS = 1752105600;   // 2025-07-10T00:00:00Z

describe('CL-1: fetchReconMonthPage — documented query shape', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends year/month/count/skip and NEVER from/to', async () => {
    const calls = stubFetch(() => jsonResponse([reconItem()]));
    const client = new RazorpaySettlementsClient(CREDS);

    const page = await client.fetchReconMonthPage(2025, 7, 0);

    expect(calls).toHaveLength(1);
    const url = calls[0]!.url;
    expect(url.pathname).toBe('/v1/settlements/recon/combined');
    expect(url.searchParams.get('year')).toBe('2025');
    expect(url.searchParams.get('month')).toBe('7');
    expect(url.searchParams.get('count')).toBe('100');
    expect(url.searchParams.get('skip')).toBe('0');
    // The audit blocker: from/to are NOT documented params — they must never be sent.
    expect(url.searchParams.has('from')).toBe(false);
    expect(url.searchParams.has('to')).toBe(false);
    expect(page.items).toHaveLength(1);
    expect(page.hasMore).toBe(false);
  });

  it('includes day only when provided', async () => {
    const calls = stubFetch(() => jsonResponse([]));
    const client = new RazorpaySettlementsClient(CREDS);
    await client.fetchReconMonthPage(2025, 7, 0, 11);
    expect(calls[0]!.url.searchParams.get('day')).toBe('11');
  });
});

describe('CL-2: skip pagination', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('hasMore=true when a full page (100) returns', async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => reconItem({ payment_id: `pay_${i}` }));
    stubFetch(() => jsonResponse(fullPage));
    const client = new RazorpaySettlementsClient(CREDS);
    const page = await client.fetchReconMonthPage(2025, 7, 0);
    expect(page.hasMore).toBe(true);
  });
});

describe('CL-3: reconMonthsForWindow — IST month walk', () => {
  it('single mid-month window → exactly that month', () => {
    expect(reconMonthsForWindow(FROM_TS, TO_TS)).toEqual([{ year: 2025, month: 7 }]);
  });

  it('window spanning a year boundary walks Dec → Jan', () => {
    const dec = 1734912000;  // 2024-12-23T00:00:00Z
    const jan = 1736294400;  // 2025-01-08T00:00:00Z
    expect(reconMonthsForWindow(dec, jan)).toEqual([
      { year: 2024, month: 12 },
      { year: 2025, month: 1 },
    ]);
  });

  it('month-edge window is padded so the neighbouring bucket is included (tz-skew safety)', () => {
    // 2025-07-01T00:30:00Z = 06:00 IST on July 1 — the ±1 day pad must pull June in.
    const start = 1751329800;
    const months = reconMonthsForWindow(start, start + 3600);
    expect(months).toEqual([
      { year: 2025, month: 6 },
      { year: 2025, month: 7 },
    ]);
  });

  it('a 180-day reserves window walks ~7 months', () => {
    const months = reconMonthsForWindow(TO_TS - 180 * 86400, TO_TS);
    expect(months.length).toBeGreaterThanOrEqual(7);
    expect(months[months.length - 1]).toEqual({ year: 2025, month: 7 });
  });
});

describe('CL-4: reconItemWithinWindow', () => {
  it('keeps items with settled_at inside the window, drops outside', () => {
    expect(reconItemWithinWindow(reconItem({ settled_at: FROM_TS + 10 }), FROM_TS, TO_TS)).toBe(true);
    expect(reconItemWithinWindow(reconItem({ settled_at: FROM_TS - 10 }), FROM_TS, TO_TS)).toBe(false);
    expect(reconItemWithinWindow(reconItem({ settled_at: TO_TS + 10 }), FROM_TS, TO_TS)).toBe(false);
  });

  it('falls back to created_at when settled_at is absent', () => {
    expect(reconItemWithinWindow(reconItem({ settled_at: null, created_at: FROM_TS + 5 }), FROM_TS, TO_TS)).toBe(true);
    expect(reconItemWithinWindow(reconItem({ settled_at: null, created_at: FROM_TS - 5 }), FROM_TS, TO_TS)).toBe(false);
  });

  it('keeps timestampless items (no event loss — deterministic ids dedupe in Bronze)', () => {
    expect(reconItemWithinWindow(reconItem({ settled_at: null, created_at: null }), FROM_TS, TO_TS)).toBe(true);
  });
});

describe('CL-5: fetchAllReconItems — walk × pagination × filter (recorded fixtures)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('collects in-window items across skip pages and filters out-of-window rows', async () => {
    const inWindow1 = reconItem({ payment_id: 'pay_in_1', settled_at: FROM_TS + 100 });
    const inWindow2 = reconItem({ payment_id: 'pay_in_2', type: 'refund', debit: 50000, credit: 0, settled_at: TO_TS - 100 });
    const outOfWindow = reconItem({ payment_id: 'pay_out', settled_at: FROM_TS - 9999 });

    // page 0 = 100 items (99 filler in-window + 1 out-of-window) → hasMore; page 1 = 1 item.
    const filler = Array.from({ length: 99 }, (_, i) => reconItem({ payment_id: `pay_fill_${i}`, settled_at: FROM_TS + 200 + i }));
    const calls = stubFetch((url) => {
      const skip = url.searchParams.get('skip');
      if (skip === '0') return jsonResponse([...filler, outOfWindow, inWindow1].slice(0, 100));
      return jsonResponse([inWindow2]);
    });

    const client = new RazorpaySettlementsClient(CREDS);
    const items = await client.fetchAllReconItems(FROM_TS, TO_TS);

    // 2 requests for July (skip 0 + skip 100), single-month window
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url.searchParams.get('year')).toBe('2025');
    expect(calls[0]!.url.searchParams.get('month')).toBe('7');
    expect(calls[1]!.url.searchParams.get('skip')).toBe('100');

    const ids = items.map((i) => i.payment_id);
    expect(ids).not.toContain('pay_out');
    expect(ids).toContain('pay_fill_0');
    expect(ids).toContain('pay_in_2');
    // docs-shape payout fields survive untouched for the mapper
    const refundRow = items.find((i) => i.payment_id === 'pay_in_2')!;
    expect(refundRow.type).toBe('refund');
    expect(refundRow.debit).toBe(50000);
    expect(refundRow.settlement_utr).toBe('UTR2025070200000001');
  }, 20_000);

  it('queries every month bucket of a multi-month window', async () => {
    const calls = stubFetch(() => jsonResponse([]));
    const client = new RazorpaySettlementsClient(CREDS);
    const from = 1746057600; // 2025-05-01T00:00:00Z
    const to = 1751500800;   // 2025-07-03T00:00:00Z
    await client.fetchAllReconItems(from, to);
    const buckets = calls.map((c) => `${c.url.searchParams.get('year')}-${c.url.searchParams.get('month')}`);
    expect(buckets).toEqual(['2025-4', '2025-5', '2025-6', '2025-7']); // April via the -1d pad
  });
});

describe('CL-6/CL-7: rate limit + auth errors', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('429 with Retry-After backs off then succeeds', async () => {
    stubFetch((_url, i) => {
      if (i === 0) return new Response('', { status: 429, headers: { 'Retry-After': '1' } });
      return jsonResponse([reconItem()]);
    });
    const client = new RazorpaySettlementsClient(CREDS);
    const pagePromise = client.fetchReconMonthPage(2025, 7, 0);
    await vi.advanceTimersByTimeAsync(1100);
    const page = await pagePromise;
    expect(page.items).toHaveLength(1);
  });

  it('401 throws RAZORPAY_AUTH_ERROR (repull lane keys RECONNECT_REQUIRED on it)', async () => {
    stubFetch(() => new Response('', { status: 401 }));
    const client = new RazorpaySettlementsClient(CREDS);
    await expect(client.fetchReconMonthPage(2025, 7, 0)).rejects.toThrow('RAZORPAY_AUTH_ERROR');
  });
});
