/**
 * checkout-funnel.test.ts — unit tests for computeCheckoutFunnel (Shopflo abandoned checkout)
 *
 * Tests the funnel ratio, no-data guard (abandonedCount===0n), and BigInt
 * minor-unit enforcement via a fully-mocked PoolClient.  No DB required.
 *
 * All assertions are SPEC-DERIVED LITERALS.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./deps.js', async () => {
  const actual = await vi.importActual<typeof import('./deps.js')>('./deps.js');
  return {
    ...actual,
    withBrandTxn: vi.fn(),
  };
});

import { computeCheckoutFunnel } from './checkout-funnel.js';
import { withBrandTxn } from './deps.js';

const withBrandTxnMock = vi.mocked(withBrandTxn);
const fakeDeps = { pool: {} as never };
const BRAND_ID = '00000000-0000-0000-0000-000000000003';

function makeClient(queryResults: Array<{ rows: unknown[] }>) {
  let call = 0;
  return { query: vi.fn(async () => queryResults[call++] ?? { rows: [] }) };
}

function setupClient(queryResults: Array<{ rows: unknown[] }>) {
  const client = makeClient(queryResults);
  withBrandTxnMock.mockImplementation(async (_pool, _brandId, fn) =>
    fn(client as never),
  );
  return client;
}

beforeEach(() => vi.clearAllMocks());

// ── Helper: builds a funnel aggregate row ────────────────────────────────────

interface FunnelRow {
  abandoned: string;
  discount_applied: string;
  with_address: string;
  abandoned_value: string;
  synthetic_cnt: string;
}

function funnelRow(overrides: Partial<FunnelRow> = {}): FunnelRow {
  return {
    abandoned: '0',
    discount_applied: '0',
    with_address: '0',
    abandoned_value: '0',
    synthetic_cnt: '0',
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('computeCheckoutFunnel — Shopflo abandoned-checkout funnel', () => {

  // ── no-data: abandonedCount === 0n ───────────────────────────────────────

  it('hasData=false when abandonedCount is 0 (no checkout_abandoned rows in window)', async () => {
    setupClient([
      { rows: [{ currency_code: 'INR' }] },
      { rows: [funnelRow({ abandoned: '0' })] },
    ]);

    const result = await computeCheckoutFunnel(BRAND_ID, fakeDeps);

    expect(result.hasData).toBe(false);
    expect(result.abandonedCount).toBe(0n);
    expect(result.discountAppliedCount).toBe(0n);
    expect(result.withAddressCount).toBe(0n);
    expect(result.abandonedValueMinor).toBe(0n);
    expect(result.dataSource).toBe('live');
  });

  it('hasData=false when currencyCode is null (brand row missing)', async () => {
    setupClient([
      { rows: [] }, // no brand row → currencyCode = null
      { rows: [funnelRow({ abandoned: '5' })] },
    ]);

    const result = await computeCheckoutFunnel(BRAND_ID, fakeDeps);

    expect(result.hasData).toBe(false);
    expect(result.currencyCode).toBe(null);
  });

  // ── normal case → exact values ────────────────────────────────────────────

  it('returns exact funnel counts and abandonedValueMinor for a normal case', async () => {
    setupClient([
      { rows: [{ currency_code: 'INR' }] },
      {
        rows: [
          funnelRow({
            abandoned:        '10',
            discount_applied: '4',
            with_address:     '7',
            abandoned_value:  '250000', // INR 2500.00 in minor units (paise)
            synthetic_cnt:    '0',
          }),
        ],
      },
    ]);

    const result = await computeCheckoutFunnel(BRAND_ID, fakeDeps);

    expect(result.hasData).toBe(true);
    expect(result.currencyCode).toBe('INR');
    expect(result.abandonedCount).toBe(10n);
    expect(result.discountAppliedCount).toBe(4n);
    expect(result.withAddressCount).toBe(7n);
    expect(result.abandonedValueMinor).toBe(250000n);
    expect(result.dataSource).toBe('live');
  });

  // ── money is BIGINT minor units (I-S07) ──────────────────────────────────

  it('all money and count fields are bigint (I-S07 — no floats)', async () => {
    setupClient([
      { rows: [{ currency_code: 'INR' }] },
      {
        rows: [
          funnelRow({
            abandoned:        '3',
            discount_applied: '1',
            with_address:     '2',
            abandoned_value:  '99900',
            synthetic_cnt:    '0',
          }),
        ],
      },
    ]);

    const result = await computeCheckoutFunnel(BRAND_ID, fakeDeps);

    expect(typeof result.abandonedCount).toBe('bigint');
    expect(typeof result.discountAppliedCount).toBe('bigint');
    expect(typeof result.withAddressCount).toBe('bigint');
    expect(typeof result.abandonedValueMinor).toBe('bigint');
    expect(result.abandonedCount).toBe(3n);
    expect(result.abandonedValueMinor).toBe(99900n);
  });

  // ── fractional-cent input → BigInt() throws (I-S07 enforcement) ──────────

  it('throws on fractional-minor-unit abandonedCount (I-S07 boundary)', async () => {
    // BigInt('10.5') throws SyntaxError — the engine enforces integer-only
    setupClient([
      { rows: [{ currency_code: 'INR' }] },
      {
        rows: [
          funnelRow({ abandoned: '10.5' }), // not a valid integer string
        ],
      },
    ]);

    await expect(computeCheckoutFunnel(BRAND_ID, fakeDeps)).rejects.toThrow(SyntaxError);
  });

  // ── dataSource propagation ────────────────────────────────────────────────

  it('dataSource is "synthetic" when synthetic_cnt > 0', async () => {
    setupClient([
      { rows: [{ currency_code: 'INR' }] },
      {
        rows: [
          funnelRow({
            abandoned:     '5',
            abandoned_value: '10000',
            synthetic_cnt: '3', // some rows synthetic-stamped
          }),
        ],
      },
    ]);

    const result = await computeCheckoutFunnel(BRAND_ID, fakeDeps);

    expect(result.dataSource).toBe('synthetic');
  });

  it('dataSource is "live" when synthetic_cnt is 0', async () => {
    setupClient([
      { rows: [{ currency_code: 'INR' }] },
      {
        rows: [
          funnelRow({
            abandoned:       '2',
            abandoned_value: '5000',
            synthetic_cnt:   '0',
          }),
        ],
      },
    ]);

    const result = await computeCheckoutFunnel(BRAND_ID, fakeDeps);

    expect(result.dataSource).toBe('live');
  });

  // ── abandonedValueMinor strips decimal from numeric text ─────────────────

  it('abandonedValueMinor truncates trailing ".00" from SQL numeric text (split on ".")', async () => {
    // The source does: BigInt(String(row.abandoned_value).split('.')[0])
    // SQL SUM returns e.g. '250000.00' for a numeric cast — split keeps '250000'
    setupClient([
      { rows: [{ currency_code: 'INR' }] },
      {
        rows: [
          funnelRow({
            abandoned:        '5',
            abandoned_value:  '250000.00', // simulates SQL numeric text with trailing .00
            synthetic_cnt:    '0',
          }),
        ],
      },
    ]);

    const result = await computeCheckoutFunnel(BRAND_ID, fakeDeps);

    expect(result.abandonedValueMinor).toBe(250000n);
  });

  // ── zero discount / zero address ──────────────────────────────────────────

  it('discountAppliedCount=0n and withAddressCount=0n when no discount or address rows', async () => {
    setupClient([
      { rows: [{ currency_code: 'INR' }] },
      {
        rows: [
          funnelRow({
            abandoned:        '8',
            discount_applied: '0',
            with_address:     '0',
            abandoned_value:  '80000',
            synthetic_cnt:    '0',
          }),
        ],
      },
    ]);

    const result = await computeCheckoutFunnel(BRAND_ID, fakeDeps);

    expect(result.hasData).toBe(true);
    expect(result.discountAppliedCount).toBe(0n);
    expect(result.withAddressCount).toBe(0n);
    expect(result.abandonedValueMinor).toBe(80000n);
  });

});
