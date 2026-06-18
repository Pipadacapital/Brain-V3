/**
 * cod-mix.test.ts — unit tests for computeCodMix (CoD CM2 + mix)
 *
 * Tests the pure math paths (ratePct + signed-sum assembly) by injecting
 * a fully-mocked PoolClient via a vitest mock of deps.js.  No DB required.
 *
 * Naming convention: SPEC-DERIVED LITERALS only — every assertion is a
 * concrete value derived from the spec, not a tautology.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock deps BEFORE importing the module under test ────────────────────────
vi.mock('./deps.js', async () => {
  const actual = await vi.importActual<typeof import('./deps.js')>('./deps.js');
  return {
    ...actual,
    // withBrandTxn is replaced with a pass-through that calls fn(mockClient)
    // without touching a real Postgres pool.
    withBrandTxn: vi.fn(),
  };
});

import { computeCodMix } from './cod-mix.js';
import { withBrandTxn } from './deps.js';

const withBrandTxnMock = vi.mocked(withBrandTxn);

/** Minimal EngineDeps stub — pool is never reached under the mock. */
const fakeDeps = { pool: {} as never };
const BRAND_ID = '00000000-0000-0000-0000-000000000001';

/** Build a PoolClient stub whose .query() returns rows on demand. */
function makeClient(queryResults: Array<{ rows: unknown[] }>) {
  let call = 0;
  return {
    query: vi.fn(async () => queryResults[call++] ?? { rows: [] }),
  };
}

/** Wire withBrandTxn to call fn with the provided stub client. */
function setupClient(queryResults: Array<{ rows: unknown[] }>) {
  const client = makeClient(queryResults);
  withBrandTxnMock.mockImplementation(async (_pool, _brandId, fn) =>
    fn(client as never),
  );
  return client;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('computeCodMix — CoD CM2 + mix', () => {

  // ── no-data path ──────────────────────────────────────────────────────────

  it('hasData=false when no cod_* ledger rows exist', async () => {
    setupClient([
      { rows: [{ currency_code: 'INR' }] },
      { rows: [] }, // no event_type rows
    ]);

    const result = await computeCodMix(BRAND_ID, fakeDeps);

    expect(result.hasData).toBe(false);
    expect(result.codSharePct).toBe(null);
    expect(result.codNetMinor).toBe(0n);
    expect(result.codDeliveredMinor).toBe(0n);
    expect(result.codRtoClawbackMinor).toBe(0n);
    expect(result.prepaidMinor).toBe(0n);
  });

  it('hasData=false when currencyCode is null (brand row missing)', async () => {
    setupClient([
      { rows: [] }, // no brand row → currencyCode = null
      { rows: [{ event_type: 'cod_delivery_confirmed', sum_minor: '50000' }] },
    ]);

    const result = await computeCodMix(BRAND_ID, fakeDeps);

    expect(result.hasData).toBe(false);
    expect(result.currencyCode).toBe(null);
  });

  // ── net CoD can be NEGATIVE when clawback exceeds delivered ──────────────

  it('codNetMinor is NEGATIVE when RTO clawback exceeds delivered', async () => {
    // Delivered: +30000 minor; Clawback: −45000 minor (signed negative in ledger)
    // Net = 30000 + (−45000) = −15000
    setupClient([
      { rows: [{ currency_code: 'INR' }] },
      {
        rows: [
          { event_type: 'cod_delivery_confirmed', sum_minor: '30000' },
          { event_type: 'cod_rto_clawback',       sum_minor: '-45000' },
        ],
      },
    ]);

    const result = await computeCodMix(BRAND_ID, fakeDeps);

    expect(result.hasData).toBe(true);
    expect(result.codDeliveredMinor).toBe(30000n);
    expect(result.codRtoClawbackMinor).toBe(45000n); // positive magnitude for display
    expect(result.codNetMinor).toBe(-15000n);         // signed truth — NEGATIVE
  });

  // ── codSharePct = null when denominator is non-positive ──────────────────

  it('codSharePct is null when net CoD + prepaid = 0 (zero denominator)', async () => {
    // netCod=0, prepaid=0 → denom=0n → ratePct guard fires
    setupClient([
      { rows: [{ currency_code: 'INR' }] },
      {
        rows: [
          { event_type: 'cod_delivery_confirmed', sum_minor: '0' },
          { event_type: 'cod_rto_clawback',       sum_minor: '0' },
        ],
      },
    ]);

    const result = await computeCodMix(BRAND_ID, fakeDeps);

    expect(result.codSharePct).toBe(null);
  });

  it('codSharePct is null when denominator is negative (clawback > delivered + prepaid)', async () => {
    // netCod = 10000 + (−60000) = −50000; prepaid = 0
    // denom = −50000 + 0 = −50000 (≤ 0n) → null guard fires
    setupClient([
      { rows: [{ currency_code: 'INR' }] },
      {
        rows: [
          { event_type: 'cod_delivery_confirmed', sum_minor: '10000' },
          { event_type: 'cod_rto_clawback',       sum_minor: '-60000' },
        ],
      },
    ]);

    const result = await computeCodMix(BRAND_ID, fakeDeps);

    expect(result.codNetMinor).toBe(-50000n);
    expect(result.codSharePct).toBe(null);
  });

  // ── codSharePct exact basis-point value (normal case) ────────────────────

  it('codSharePct exact percentage string for a normal case', async () => {
    // codNetMinor = 75000 (delivered=75000, no clawback)
    // prepaid     = 25000
    // denom       = 75000 + 25000 = 100000
    // bps         = (75000 * 10000) / 100000 = 7500
    // whole=75, frac=0 → '75.00'
    setupClient([
      { rows: [{ currency_code: 'INR' }] },
      {
        rows: [
          { event_type: 'cod_delivery_confirmed', sum_minor: '75000'  },
          { event_type: 'finalization',           sum_minor: '25000'  },
        ],
      },
    ]);

    const result = await computeCodMix(BRAND_ID, fakeDeps);

    expect(result.hasData).toBe(true);
    expect(result.codNetMinor).toBe(75000n);
    expect(result.prepaidMinor).toBe(25000n);
    expect(result.codSharePct).toBe('75.00');
  });

  it('codSharePct exact percentage string with partial bps (non-round ratio)', async () => {
    // codNetMinor = 1000; prepaid = 2000; denom = 3000
    // bps = (1000 * 10000) / 3000 = 10000000 / 3000 = 3333n (integer division)
    // whole = 33, frac = 33 → '33.33'
    setupClient([
      { rows: [{ currency_code: 'INR' }] },
      {
        rows: [
          { event_type: 'cod_delivery_confirmed', sum_minor: '1000' },
          { event_type: 'finalization',           sum_minor: '2000' },
        ],
      },
    ]);

    const result = await computeCodMix(BRAND_ID, fakeDeps);

    expect(result.codSharePct).toBe('33.33');
  });

  it('codSharePct 100.00 when prepaid is zero and net CoD is positive', async () => {
    // netCod=50000, prepaid=0, denom=50000
    // bps = (50000 * 10000) / 50000 = 10000
    // whole=100, frac=0 → '100.00'
    setupClient([
      { rows: [{ currency_code: 'INR' }] },
      {
        rows: [
          { event_type: 'cod_delivery_confirmed', sum_minor: '50000' },
        ],
      },
    ]);

    const result = await computeCodMix(BRAND_ID, fakeDeps);

    expect(result.codSharePct).toBe('100.00');
  });

  // ── money is BIGINT minor units (I-S07) ──────────────────────────────────

  it('money values are all bigint (I-S07 — no floats)', async () => {
    setupClient([
      { rows: [{ currency_code: 'INR' }] },
      {
        rows: [
          { event_type: 'cod_delivery_confirmed', sum_minor: '12345' },
          { event_type: 'cod_rto_clawback',       sum_minor: '-1000' },
          { event_type: 'finalization',            sum_minor: '5000'  },
        ],
      },
    ]);

    const result = await computeCodMix(BRAND_ID, fakeDeps);

    expect(typeof result.codDeliveredMinor).toBe('bigint');
    expect(typeof result.codRtoClawbackMinor).toBe('bigint');
    expect(typeof result.codNetMinor).toBe('bigint');
    expect(typeof result.prepaidMinor).toBe('bigint');
    // Exact values: net = 12345 + (−1000) = 11345; clawback magnitude = 1000
    expect(result.codNetMinor).toBe(11345n);
    expect(result.codRtoClawbackMinor).toBe(1000n);
  });

  // ── fractional-cent input → BigInt() throws (I-S07 enforcement) ──────────

  it('throws on fractional-minor-unit ledger value (I-S07 boundary)', async () => {
    // The source coerces via BigInt(r.sum_minor); '100.50' is not a valid BigInt literal
    // and BigInt('100.50') throws a SyntaxError — this is the runtime I-S07 guard.
    setupClient([
      { rows: [{ currency_code: 'INR' }] },
      {
        rows: [
          { event_type: 'cod_delivery_confirmed', sum_minor: '100.50' }, // fractional paise
        ],
      },
    ]);

    await expect(computeCodMix(BRAND_ID, fakeDeps)).rejects.toThrow(SyntaxError);
  });

  // ── clawback magnitude is always positive for display ────────────────────

  it('codRtoClawbackMinor is positive magnitude even when ledger value is negative', async () => {
    setupClient([
      { rows: [{ currency_code: 'INR' }] },
      {
        rows: [
          { event_type: 'cod_delivery_confirmed', sum_minor: '20000'  },
          { event_type: 'cod_rto_clawback',       sum_minor: '-8000'  },
        ],
      },
    ]);

    const result = await computeCodMix(BRAND_ID, fakeDeps);

    expect(result.codRtoClawbackMinor).toBe(8000n);   // positive magnitude
    expect(result.codNetMinor).toBe(12000n);            // 20000 + (−8000)
  });

});
