/**
 * capi-passback.orchestrator.test.ts — P0: the missing driver for Meta CAPI conversion feedback.
 *
 * passback() was never called by anything (the service was constructed then void-ed). This proves
 * the orchestrator enumerates brands, maps realistic finalized-purchase candidates to conversions,
 * drives passback() for each, skips candidates with no subject_hash (no consent key), and is
 * fail-isolated per brand/row. Pure unit test — enumerate/fetch/passback are injected.
 */
import { describe, it, expect, vi } from 'vitest';
import { runCapiPassbackOnce, mapCandidateToConversion } from '../internal/capi-passback.orchestrator.js';
import type { CapiSourceRow } from '../internal/capi-source.query.js';

const log = { info: () => {}, warn: () => {}, error: () => {} };

/** A realistic finalized-purchase candidate (the shape capi-source.query yields from the ledger). */
function candidate(over: Partial<CapiSourceRow> = {}): CapiSourceRow {
  return {
    brandId: '550e8400-e29b-41d4-a716-446655440000',
    eventId: 'evt_sha256_deadbeef',
    orderId: 'gid://shopify/Order/5123456789',
    ledgerEventId: 'ledger_evt_1',
    subjectHash: 'a'.repeat(64), // resolvable consent key
    valueMinor: '235882', // ₹2358.82
    currencyCode: 'INR',
    occurredAt: '2026-06-20T10:00:00.000Z',
    fbc: 'fb.1.1700000000.AbCdEf',
    fbp: 'fb.1.1700000000.1234567890',
    matchKeyCount: 1,
    ...over,
  };
}

describe('mapCandidateToConversion', () => {
  it('maps a realistic candidate to a CapiConversion (money → bigint, occurredAt → Date)', () => {
    const conv = mapCandidateToConversion(candidate())!;
    expect(conv.brandId).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(conv.valueMinor).toBe(235882n);
    expect(conv.currencyCode).toBe('INR');
    expect(conv.occurredAt).toBeInstanceOf(Date);
    expect(conv.subjectHash).toHaveLength(64);
    expect(conv.fbc).toContain('fb.1');
  });

  it('returns null when there is no subject_hash (no consent key → cannot passback)', () => {
    expect(mapCandidateToConversion(candidate({ subjectHash: null }))).toBeNull();
  });
});

describe('runCapiPassbackOnce (P0 orchestration)', () => {
  it('drives passback for every resolvable candidate across brands', async () => {
    const passback = vi.fn(async () => ({ status: 'would_send_dev' }));
    const result = await runCapiPassbackOnce({
      enumerateBrandIds: async () => ['brand-a', 'brand-b'],
      fetchCandidates: async (brandId) =>
        brandId === 'brand-a' ? [candidate(), candidate({ orderId: 'o2', ledgerEventId: 'l2' })] : [candidate({ orderId: 'o3', ledgerEventId: 'l3' })],
      passback,
      windowHours: 2,
      intervalMs: 1000,
      log,
    });
    expect(result.brands).toBe(2);
    expect(result.attempted).toBe(3); // 2 + 1 passbacks driven
    expect(passback).toHaveBeenCalledTimes(3);
  });

  it('skips candidates with no subject_hash (counted as skipped, not attempted)', async () => {
    const passback = vi.fn(async () => ({ status: 'would_send_dev' }));
    const result = await runCapiPassbackOnce({
      enumerateBrandIds: async () => ['brand-a'],
      fetchCandidates: async () => [candidate(), candidate({ orderId: 'o2', ledgerEventId: 'l2', subjectHash: null })],
      passback,
      windowHours: 2,
      intervalMs: 1000,
      log,
    });
    expect(result.attempted).toBe(1);
    expect(result.skipped).toBe(1);
    expect(passback).toHaveBeenCalledTimes(1);
  });

  it('is fail-isolated: a brand whose fetch throws does not stop the others', async () => {
    const passback = vi.fn(async () => ({ status: 'would_send_dev' }));
    const result = await runCapiPassbackOnce({
      enumerateBrandIds: async () => ['bad', 'good'],
      fetchCandidates: async (brandId) => {
        if (brandId === 'bad') throw new Error('db down for this brand');
        return [candidate()];
      },
      passback,
      windowHours: 2,
      intervalMs: 1000,
      log,
    });
    expect(result.attempted).toBe(1); // 'good' still processed
    expect(passback).toHaveBeenCalledTimes(1);
  });

  it('passes the trailing window to fetchCandidates (windowHours back from now)', async () => {
    const fetchCandidates = vi.fn(async () => []);
    const now = new Date('2026-06-20T12:00:00.000Z');
    await runCapiPassbackOnce({
      enumerateBrandIds: async () => ['brand-a'],
      fetchCandidates,
      passback: async () => ({ status: 'would_send_dev' }),
      windowHours: 3,
      intervalMs: 1000,
      log,
      now: () => now,
    });
    const call = fetchCandidates.mock.calls[0] as unknown as [string, Date, Date];
    expect(call[2].toISOString()).toBe('2026-06-20T12:00:00.000Z');
    expect(call[1].toISOString()).toBe('2026-06-20T09:00:00.000Z'); // 3h trailing
  });
});
