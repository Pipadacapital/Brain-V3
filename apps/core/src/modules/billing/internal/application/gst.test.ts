/**
 * gst.test.ts — the pure GST place-of-supply logic (no DB, no I/O).
 *
 * Asserts the regime decision (intra- vs inter-state), the exact CGST/SGST split (cgst+sgst==total,
 * remainder to SGST on odd totals), and the state-code extraction from GSTIN / place-of-supply.
 */
import { describe, it, expect } from 'vitest';
import { computeGstBreakdown, stateCode } from './gst.js';

describe('stateCode', () => {
  it('extracts the leading two-digit state code from a GSTIN', () => {
    expect(stateCode('29AAAAA0000A1Z5')).toBe('29');
  });
  it('extracts it from a "NN-State" place-of-supply string', () => {
    expect(stateCode('07-Delhi')).toBe('07');
  });
  it('returns empty when there is no leading code', () => {
    expect(stateCode('Karnataka')).toBe('');
  });
});

describe('computeGstBreakdown', () => {
  it('intra-state (same code) → CGST+SGST, each half, exact split on an even total', () => {
    const b = computeGstBreakdown(1800n, '29', '29');
    expect(b.regime).toBe('cgst_sgst');
    expect(b.cgst_minor).toBe(900n);
    expect(b.sgst_minor).toBe(900n);
    expect(b.igst_minor).toBe(0n);
    expect(b.cgst_minor + b.sgst_minor).toBe(b.tax_minor);
  });

  it('intra-state with an ODD total → remainder goes to SGST (invariant holds)', () => {
    const b = computeGstBreakdown(1801n, '29', '29');
    expect(b.cgst_minor).toBe(900n);
    expect(b.sgst_minor).toBe(901n);
    expect(b.cgst_minor + b.sgst_minor).toBe(1801n);
  });

  it('inter-state (different code) → IGST, full rate', () => {
    const b = computeGstBreakdown(1800n, '29', '07');
    expect(b.regime).toBe('igst');
    expect(b.igst_minor).toBe(1800n);
    expect(b.cgst_minor).toBe(0n);
    expect(b.sgst_minor).toBe(0n);
  });

  it('treats an unknown seller state as inter-state (never wrongly splits)', () => {
    const b = computeGstBreakdown(1800n, '', '29');
    expect(b.regime).toBe('igst');
  });
});
