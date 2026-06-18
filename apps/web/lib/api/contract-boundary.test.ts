/**
 * Web BFF contract-boundary tests (feat-shared-bff-read-contracts, Track B seam).
 *
 * Proves the runtime invariant of the slice: parseData() validates an unwrapped envelope
 * body against the @brain/contracts Zod single-source-of-truth, so a core<->web money/field
 * DRIFT throws a CLEAR, field-named BffApiError(code:'CONTRACT_DRIFT') AT THE SEAM — never a
 * deep `BigInt(undefined)` white-screen inside a component. On valid data it returns the SAME
 * object (no behavior change, identical money formatting downstream).
 *
 * NON-INERT: each negative case asserts the SPECIFIC drifted field path is named in the error.
 */
import { describe, it, expect } from 'vitest';
import {
  KpiSummarySchema,
  AttributionByChannelSchema,
  RevenueSnapshotSchema,
  AskBrainResultSchema,
  JourneyTimelineSchema,
} from '@brain/contracts';
import { parseData, BffApiError } from './client';

const env = (data: unknown) => ({ request_id: 'req-test', data });

describe('parseData — the web contract boundary', () => {
  // ── No behavior change: valid payloads round-trip identically ──
  it('returns the SAME object on a valid has_data KPI payload (no transform)', () => {
    const data = {
      state: 'has_data',
      as_of: '2026-06-18',
      kpis: [
        {
          currency_code: 'INR',
          realized_minor: '123450',
          provisional_minor: '0',
          order_count: '12',
          aov_minor: '10287',
          rto_rate_pct: '3.25',
        },
      ],
    };
    const out = parseData(KpiSummarySchema, env(data));
    expect(out).toEqual(data); // identical → identical formatMoneyDisplay downstream
  });

  it('preserves the honest-empty no_data arm exactly (revenue snapshot)', () => {
    const data = { state: 'no_data', as_of: '2026-06-18', realized: null, provisional: null };
    expect(parseData(RevenueSnapshotSchema, env(data))).toEqual(data);
  });

  it('round-trips a MoneyRecord (per-currency bigint strings, incl. honest 0)', () => {
    const data = {
      state: 'has_data',
      as_of: '2026-06-18',
      realized: { INR: '500000', AED: '0' },
      provisional: {},
    };
    expect(parseData(RevenueSnapshotSchema, env(data))).toEqual(data);
  });

  // ── Drift containment: a renamed money field throws a FIELD-NAMED error, NOT BigInt(undefined) ──
  it('REJECTS the renamed money field attributed_minor (must be attributed_gmv_minor) with a clear named error', () => {
    const drifted = {
      state: 'has_data',
      from: '2026-06-01',
      to: '2026-06-18',
      model: 'position_based',
      currency_code: 'INR',
      attributed_minor: '999', // DRIFT: should be attributed_gmv_minor
      realized_gmv_minor: '1000',
      unattributed_minor: '1',
      reconciliation_rate_pct: '99.90',
      by_channel: [],
      data_source: 'synthetic',
    };
    let err: unknown;
    try {
      parseData(AttributionByChannelSchema, env(drifted));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BffApiError);
    const be = err as BffApiError;
    expect(be.code).toBe('CONTRACT_DRIFT');
    expect(be.message).toContain('attributed_gmv_minor'); // names the missing field
    expect(be.requestId).toBe('req-test');
  });

  it('REJECTS a float money value (number-not-string) — never a silent coercion', () => {
    const drifted = {
      state: 'has_data',
      as_of: '2026-06-18',
      kpis: [
        {
          currency_code: 'INR',
          realized_minor: 1234.5, // DRIFT: float, not a bigint-string
          provisional_minor: '0',
          order_count: '12',
          aov_minor: '10287',
          rto_rate_pct: '3.25',
        },
      ],
    };
    let err: unknown;
    try {
      parseData(KpiSummarySchema, env(drifted));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BffApiError);
    expect((err as BffApiError).message).toContain('kpis.0.realized_minor');
  });

  it('REJECTS the historical order_id drift on journey timeline (must be brain_anon_id)', () => {
    const drifted = {
      state: 'has_data',
      order_id: 'ord_1', // DRIFT: core sends brain_anon_id
      stitched: true,
      touches: [],
      data_source: 'live',
    };
    let err: unknown;
    try {
      parseData(JourneyTimelineSchema, env(drifted));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BffApiError);
    expect((err as BffApiError).message).toContain('brain_anon_id');
  });

  it('REJECTS a wrong ask discriminant (state instead of kind)', () => {
    const drifted = { state: 'answer', reason: 'x' }; // DRIFT: discriminant is `kind`
    let err: unknown;
    try {
      parseData(AskBrainResultSchema, env(drifted));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BffApiError);
    expect((err as BffApiError).code).toBe('CONTRACT_DRIFT');
  });
});
