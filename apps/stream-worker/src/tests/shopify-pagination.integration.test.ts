/**
 * shopify-pagination.integration.test.ts — A1 slice
 * chore-connector-lifecycle-regression / defect #6 (D-4 / ADR-R1)
 *
 * Pins: ShopifyBackfillClient.fetchOrdersPage pagination with since_id=0 fix.
 * Code-under-test: apps/stream-worker/src/jobs/shopify-backfill/shopify-paged-client.ts:121
 *   const effectiveSinceId = sinceId ?? '0';
 *
 * MECHANISM (ADR-R1 hybrid — option a):
 *   vi.stubGlobal('fetch', ...) backed by a 600-order in-memory store (buildFakeStore).
 *   Real ShopifyBackfillClient instance; no port, no network. Deterministic, CI-safe.
 *
 * NON-INERT / REVERT-RED:
 *   If line 121 is reverted from `?? '0'` to `?? null`, the first request URL will
 *   contain `since_id=null` (or omit it entirely) instead of `since_id=0`.
 *   The assertion:
 *     expect(firstRequestUrl).toContain('since_id=0')
 *   goes RED on that revert. Additionally, the page walk may stall before reaching 600.
 *
 * CURSOR MONOTONIC assertion:
 *   After page 1 (ids 1..250): nextSinceId = '250'
 *   After page 2 (ids 251..500): nextSinceId = '500'
 *   After page 3 (ids 501..600, <250 orders): nextSinceId = null (last page)
 *   Cursor values are strictly increasing integer IDs — never repeating or out of order.
 *
 * DEDUP (extends T1 from backfill.e2e): re-running fetchOrdersPage with the same
 *   sinceId produces the same order IDs — idempotent at the fetch level. The
 *   upstream Bronze ON CONFLICT DO NOTHING ensures no double-count on replay.
 *
 * NO product code change. Tests only.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { ShopifyBackfillClient } from '../jobs/shopify-backfill/shopify-paged-client.js';
import {
  buildFakeStore,
  buildShopifyFetchStub,
} from './helpers/connector-lifecycle-fixtures.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const SHOP_DOMAIN = 'test-pagination.myshopify.com';
const ACCESS_TOKEN = 'test-access-token-pagination';
const CREATED_AT_MIN = '2022-01-01T00:00:00.000Z';
const STORE_SIZE = 600; // 3 pages: 250 / 250 / 100

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Walk all pages of the client, returning total order IDs collected + cursor sequence. */
async function walkAllPages(client: ShopifyBackfillClient): Promise<{
  allOrderIds: number[];
  cursorSequence: Array<string | null>;
}> {
  const allOrderIds: number[] = [];
  const cursorSequence: Array<string | null> = [];
  let sinceId: string | null = null;

  while (true) {
    const page = await client.fetchOrdersPage(sinceId, CREATED_AT_MIN);
    for (const order of page.orders) allOrderIds.push(order.id);
    cursorSequence.push(page.nextSinceId);
    sinceId = page.nextSinceId;
    if (sinceId === null) break;
  }

  return { allOrderIds, cursorSequence };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('A1: ShopifyBackfillClient pagination — since_id=0 fix (defect #6 / D-4)', () => {
  const store = buildFakeStore(STORE_SIZE);
  let fetchStub: ReturnType<typeof buildShopifyFetchStub>;
  let client: ShopifyBackfillClient;

  beforeAll(() => {
    fetchStub = buildShopifyFetchStub(store);
    vi.stubGlobal('fetch', fetchStub.fetchImpl);
    client = new ShopifyBackfillClient(SHOP_DOMAIN, ACCESS_TOKEN);
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  // ── Core: 600-order walk, 3 pages ─────────────────────────────────────────

  it('walks all 600 orders across exactly 3 pages (250 / 250 / 100)', async () => {
    fetchStub.recordedRequests.length = 0; // reset before walk

    const { allOrderIds, cursorSequence } = await walkAllPages(client);

    // Total count
    expect(allOrderIds.length).toBe(600);

    // Page breakdown via cursor sequence: 3 pages → 3 cursor values
    expect(cursorSequence.length).toBe(3);
    expect(cursorSequence[2]).toBeNull(); // last page
  });

  it('order IDs are sequential 1..600 (no gaps, no duplicates)', async () => {
    fetchStub.recordedRequests.length = 0;

    const { allOrderIds } = await walkAllPages(client);

    expect(allOrderIds.length).toBe(600);
    for (let i = 0; i < 600; i++) {
      expect(allOrderIds[i]).toBe(i + 1);
    }
  });

  // ── REVERT-RED: first fetch URL contains since_id=0 ─────────────────────

  it('REVERT-RED: first request URL contains since_id=0 (the ?? "0" fix, NOT ?? null)', async () => {
    fetchStub.recordedRequests.length = 0;

    await walkAllPages(client);

    // The first request URL MUST contain since_id=0.
    // REVERT `?? '0'` → `?? null`: the URL will contain since_id=null (or omit since_id),
    // and this assertion goes RED.
    const firstUrl = fetchStub.recordedRequests[0];
    expect(firstUrl).toBeDefined();
    expect(firstUrl).toContain('since_id=0');
  });

  it('REVERT-RED: first fetch carries since_id parameter (never omitted)', async () => {
    fetchStub.recordedRequests.length = 0;

    await walkAllPages(client);

    const firstUrl = fetchStub.recordedRequests[0]!;
    const parsedUrl = new URL(firstUrl);

    // since_id must be present and equal '0' on the first call
    expect(parsedUrl.searchParams.has('since_id')).toBe(true);
    expect(parsedUrl.searchParams.get('since_id')).toBe('0');
  });

  // ── Cursor monotonic ────────────────────────────────────────────────────

  it('cursor advances monotonically: [250, 500, null]', async () => {
    fetchStub.recordedRequests.length = 0;

    const { cursorSequence } = await walkAllPages(client);

    // After page 1 (ids 1..250): last id = 250 → nextSinceId = '250'
    expect(cursorSequence[0]).toBe('250');
    // After page 2 (ids 251..500): last id = 500 → nextSinceId = '500'
    expect(cursorSequence[1]).toBe('500');
    // Page 3 has <250 orders → nextSinceId = null
    expect(cursorSequence[2]).toBeNull();
  });

  it('cursor IDs are strictly increasing (monotonic, no regression)', async () => {
    fetchStub.recordedRequests.length = 0;

    const { cursorSequence } = await walkAllPages(client);
    const numericCursors = cursorSequence
      .filter((c): c is string => c !== null)
      .map((c) => parseInt(c, 10));

    for (let i = 1; i < numericCursors.length; i++) {
      expect(numericCursors[i]).toBeGreaterThan(numericCursors[i - 1]!);
    }
  });

  // ── Re-run dedup (idempotent fetch — extends T1 pattern) ────────────────

  it('re-running with the same sinceId returns identical order IDs (idempotent replay)', async () => {
    fetchStub.recordedRequests.length = 0;

    // First walk
    const { allOrderIds: run1 } = await walkAllPages(client);

    // Reset stub URL log but keep store intact
    fetchStub.recordedRequests.length = 0;

    // Second walk — same store, same starting sinceId=null
    const { allOrderIds: run2 } = await walkAllPages(client);

    // Same IDs in same order (the upstream Bronze ON CONFLICT DO NOTHING handles dedup)
    expect(run2).toEqual(run1);
  });

  // ── Page 2 carries since_id=250 (not 0, not null) ───────────────────────

  it('second request URL carries since_id=250 (cursor advanced correctly)', async () => {
    fetchStub.recordedRequests.length = 0;

    await walkAllPages(client);

    expect(fetchStub.recordedRequests.length).toBeGreaterThanOrEqual(3);
    const secondUrl = fetchStub.recordedRequests[1]!;
    const parsed = new URL(secondUrl);
    expect(parsed.searchParams.get('since_id')).toBe('250');
  });

  it('third request URL carries since_id=500', async () => {
    fetchStub.recordedRequests.length = 0;

    await walkAllPages(client);

    const thirdUrl = fetchStub.recordedRequests[2]!;
    const parsed = new URL(thirdUrl);
    expect(parsed.searchParams.get('since_id')).toBe('500');
  });
});
