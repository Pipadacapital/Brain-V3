/**
 * attribution-reconciliation.test.ts — the reconciliation RATE + window boundary, unit-tested
 * without a live ledger (D3 / R-46/47).
 *
 * Replaces the missing-coverage gap behind the live parity leg: the rate math, the closed-sum
 * residual, and the from−1 window boundary are now pinned by pure spec-literal assertions. The
 * closed-sum parity here is NON-tautological — `attributedGmvMinor` (scalar seam) and `byChannel`
 * (channel seam) are fed as INDEPENDENT inputs, and the test asserts they agree (Σ channels ==
 * attributed) the way a healthy snapshot must. A divergence — the real bug class when two SQL
 * seams drift — is caught here, not papered over by `x + (realized − x) == realized`.
 */
import { describe, it, expect } from 'vitest';
import {
  attributionRatePct,
  isoDate,
  previousDayIso,
  reconcileAttributionWindow,
  type ChannelContribution,
} from './attribution-reconciliation.js';

const ch = (channel: string, contributionMinor: bigint): ChannelContribution => ({
  channel,
  currencyCode: 'INR',
  contributionMinor,
});

describe('attributionRatePct — exact 2dp basis-point math (never float)', () => {
  it('truncates toward zero (does NOT round)', () => {
    // 2/3 = 66.666…% → bps = 6666 → "66.66" (truncated, not "66.67").
    expect(attributionRatePct(2n, 3n)).toBe('66.66');
  });

  it('exact whole/partial percentages', () => {
    expect(attributionRatePct(140_000n, 165_000n)).toBe('84.84'); // 8484 bps
    expect(attributionRatePct(1n, 1n)).toBe('100.00');
    expect(attributionRatePct(1n, 4n)).toBe('25.00');
    expect(attributionRatePct(0n, 100n)).toBe('0.00');
  });

  it('over-attribution (>100%) is rendered honestly, not clamped', () => {
    expect(attributionRatePct(150n, 100n)).toBe('150.00');
  });

  it('null on a non-positive denominator (honest — no division)', () => {
    expect(attributionRatePct(50n, 0n)).toBeNull();
    expect(attributionRatePct(50n, -10n)).toBeNull();
  });

  it('signed numerator (net clawback exceeds credit) → negative rate', () => {
    expect(attributionRatePct(-50n, 100n)).toBe('-50.00');
  });

  it('pads the fractional part to two digits', () => {
    expect(attributionRatePct(101n, 100n)).toBe('101.00');
    expect(attributionRatePct(1001n, 1000n)).toBe('100.10'); // 10010 bps → 100.10
  });
});

describe('window boundary — from−1 is the EXCLUSIVE lower edge (R-47)', () => {
  it('previousDayIso is exactly one UTC day before `from`', () => {
    expect(previousDayIso(new Date('2026-06-18T00:00:00Z'))).toBe('2026-06-17');
  });

  it('rolls back across a month boundary', () => {
    expect(previousDayIso(new Date('2026-07-01T00:00:00Z'))).toBe('2026-06-30');
  });

  it('rolls back across a year boundary', () => {
    expect(previousDayIso(new Date('2026-01-01T00:00:00Z'))).toBe('2025-12-31');
  });

  it('rolls back across a leap-day boundary', () => {
    expect(previousDayIso(new Date('2024-03-01T00:00:00Z'))).toBe('2024-02-29');
  });

  it('is stable regardless of the time-of-day component (UTC date only)', () => {
    expect(previousDayIso(new Date('2026-06-18T23:59:59Z'))).toBe('2026-06-17');
    expect(isoDate(new Date('2026-06-18T23:59:59Z'))).toBe('2026-06-18');
  });
});

describe('reconcileAttributionWindow — closed-sum oracle + residual + rate', () => {
  it('mixed period: Σ channels == attributed, attributed + unattributed == realized (concrete literals)', () => {
    // A fully-credited order (100000) + a 50%-refunded order (net 40000 attributed) → attributed 140000,
    // realized 165000 (incl. a 25000 unattributed order). Channels independently sum to 140000.
    const result = reconcileAttributionWindow({
      currencyCode: 'INR',
      realizedGmvMinor: 165_000n,
      attributedGmvMinor: 140_000n,
      byChannel: [ch('paid_google', 60_000n), ch('email', 20_000n), ch('paid_meta', 60_000n)],
    });

    expect(result.reconciliationRatePct).toBe('84.84');
    expect(result.unattributedMinor).toBe(25_000n);
    expect(result.hasData).toBe(true);

    // NON-tautological parity: the channel seam must agree with the scalar attributed seam.
    const channelSum = result.byChannel.reduce((a, c) => a + c.contributionMinor, 0n);
    expect(channelSum).toBe(result.attributedGmvMinor);
    // Closed-sum oracle: Σ channel + unattributed == realized.
    expect(channelSum + result.unattributedMinor).toBe(result.realizedGmvMinor);
  });

  it('sorts channels deterministically by name (stable render + oracle order)', () => {
    const result = reconcileAttributionWindow({
      currencyCode: 'INR',
      realizedGmvMinor: 100n,
      attributedGmvMinor: 100n,
      byChannel: [ch('paid_meta', 40n), ch('direct', 10n), ch('email', 50n)],
    });
    expect(result.byChannel.map((c) => c.channel)).toEqual(['direct', 'email', 'paid_meta']);
  });

  it('full RTO: attributed nets to 0 → rate 0.00, unattributed == realized', () => {
    const result = reconcileAttributionWindow({
      currencyCode: 'INR',
      realizedGmvMinor: 0n, // realized also reversed in the window
      attributedGmvMinor: 0n,
      byChannel: [],
    });
    expect(result.hasData).toBe(false);
    expect(result.reconciliationRatePct).toBeNull(); // realized 0 → honest null
    expect(result.unattributedMinor).toBe(0n);
  });

  it('hasData true when only attributed is non-zero (over-attribution / data-quality flag path)', () => {
    const result = reconcileAttributionWindow({
      currencyCode: 'INR',
      realizedGmvMinor: 0n,
      attributedGmvMinor: 5_000n,
      byChannel: [ch('paid_meta', 5_000n)],
    });
    expect(result.hasData).toBe(true);
    expect(result.reconciliationRatePct).toBeNull(); // denom 0 → null, not Infinity
    expect(result.unattributedMinor).toBe(-5_000n); // negative residual surfaced, not hidden
  });

  it('detects channel-seam divergence (the bug class the live parity leg must catch)', () => {
    // Scalar attributed says 140000 but the channel seam only sums to 130000 — a real drift.
    const result = reconcileAttributionWindow({
      currencyCode: 'INR',
      realizedGmvMinor: 165_000n,
      attributedGmvMinor: 140_000n,
      byChannel: [ch('paid_meta', 60_000n), ch('email', 20_000n), ch('paid_google', 50_000n)],
    });
    const channelSum = result.byChannel.reduce((a, c) => a + c.contributionMinor, 0n);
    expect(channelSum).not.toBe(result.attributedGmvMinor); // parity VIOLATED — surfaced, catchable
  });
});
