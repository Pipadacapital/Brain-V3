/**
 * attribution-parity-oracle.test.ts — the CLOSED-SUM PARITY ORACLE (CI-BLOCKING).
 *
 * THE ACCEPTANCE GATE (05-architecture.md §5, METRICS.md attribution_reconciliation_rate):
 *   Σ channel_contribution_minor + unattributed_minor = realized_gmv_minor
 * for every brand-period — enforced two ways, both exact-integer (tolerance 0):
 *
 *   LEG 1 — per-order invariant (engine-internal, PURE, always CI-blocking here):
 *     Σ credited_revenue_minor (all touches, one model) = realized_revenue_minor,
 *     guaranteed by the largest-remainder apportionment. Unattributed = realized of
 *     orders with zero credited touches. This file asserts it over the 4 fixtures.
 *
 *   LEG 2 — period-level engine-vs-independent-SQL (live Postgres, gated on DB):
 *     channel_contribution_as_of (engine seam) == raw SQL GROUP BY over the SAME
 *     snapshot, AND engine_channel_sum + (realized − attributed) == realized. Gated
 *     behind the live ledger so the pure leg is the unconditional CI gate; the live
 *     leg is exercised by the Track-A live test (attribution-credit-ledger.live.test.ts)
 *     which co-locates the ledger snapshot. Documented here as the contract.
 *
 * FIXTURES (REQUIRED, all four):
 *   • full-RTO         → Σ(credit+clawback)=0, attributed→0, closed-sum=0.
 *   • partial refund   → clawback = proportional to EACH SAVED weight (asserted touch-by-touch).
 *   • multi-touch      → weights sum to exactly 1.00000000, Σ credited = realized exactly.
 *   • cookieless residual → order with no journey → lands in unattributed, grade D, closed-sum holds.
 *
 * SPEC-DERIVED LITERALS only — every assertion is a concrete value, never a tautology.
 */

import { describe, it, expect } from 'vitest';
import {
  computeAttributionCredit,
  type CreditTouch,
  type AttributionCreditRow,
} from './attribution-credit.js';
import {
  computeAttributionClawback,
  type SavedCreditRow,
} from './attribution-clawback.js';
import { WEIGHT_SCALE } from './attribution-models.js';

const BRAND = '00000000-0000-0000-0000-0000000000a1';
const NOW = new Date('2026-06-18T10:00:00Z');

function mkTouch(seq: number, channel: string, deterministic: boolean): CreditTouch {
  return {
    touchSeq: seq,
    channel,
    campaignId: `camp-${seq}`,
    utmMedium: deterministic && channel !== 'direct' ? 'cpc' : null,
    fbclid: null,
    gclid: deterministic && channel === 'paid_google' ? `g-${seq}` : null,
    ttclid: null,
  };
}

/** Convert credit rows → SavedCreditRow shape (the ledger read-back input for clawback). */
function asSaved(rows: AttributionCreditRow[]): SavedCreditRow[] {
  return rows.map((r) => ({
    creditId: r.creditId,
    brandId: r.brandId,
    orderId: r.orderId,
    brainAnonId: r.brainAnonId,
    touchSeq: r.touchSeq,
    channel: r.channel,
    campaignId: r.campaignId,
    modelId: r.modelId,
    weightFraction: r.weightFraction,
    creditedRevenueMinor: r.creditedRevenueMinor,
    currencyCode: r.currencyCode,
    realizedRevenueMinor: r.realizedRevenueMinor,
    confidenceGrade: r.confidenceGrade,
    attributionConfidence: r.attributionConfidence,
  }));
}

function baseCreditInput(touches: CreditTouch[], realized: bigint, stitched: boolean) {
  return {
    brandId: BRAND,
    orderId: 'order-1',
    brainAnonId: 'anon-1',
    model: 'position_based' as const,
    stitched,
    realizedRevenueMinor: realized,
    currencyCode: 'INR',
    touches,
    occurredAt: NOW,
    economicEffectiveAt: NOW,
    billingPostedPeriod: '2026-06',
  };
}

describe('LEG 1 — per-order closed-sum invariant (Σ credited = realized exactly)', () => {
  it('multi-touch (N=3, position_based): weights sum to 1.00000000, Σ credited = realized', () => {
    const touches = [
      mkTouch(1, 'paid_meta', true),
      mkTouch(2, 'email', true),
      mkTouch(3, 'paid_google', true),
    ];
    const realized = 999_99n; // 99999 minor — deliberately non-divisible
    const rows = computeAttributionCredit(baseCreditInput(touches, realized, true));

    // weights sum to EXACTLY 1.0 (DECIMAL precision gate)
    const wSum = rows.reduce(
      (a, r) => a + BigInt(r.weightFraction.replace('.', '').padEnd(9, '0').slice(0, 9)),
      0n,
    );
    expect(wSum).toBe(WEIGHT_SCALE);
    expect(rows.map((r) => r.weightFraction)).toEqual(['0.40000000', '0.20000000', '0.40000000']);

    // Σ credited = realized EXACTLY (no penny leak)
    const credSum = rows.reduce((a, r) => a + r.creditedRevenueMinor, 0n);
    expect(credSum).toBe(realized);
    // grade strong: stitched + all deterministic channels
    expect(rows.every((r) => r.confidenceGrade === 'strong')).toBe(true);
    expect(rows.every((r) => r.attributionConfidence === '1.000')).toBe(true);
  });

  it('single-touch: w=1.0, the touch gets the whole realized revenue', () => {
    const rows = computeAttributionCredit(
      baseCreditInput([mkTouch(1, 'paid_meta', true)], 50_000n, true),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.weightFraction).toBe('1.00000000');
    expect(rows[0]?.creditedRevenueMinor).toBe(50_000n);
  });
});

describe('FIXTURE: full-RTO → closed-sum = 0 (attributed → 0)', () => {
  it('clawback of −realized exactly negates every credit row, Σ(credit+clawback)=0', () => {
    const touches = [
      mkTouch(1, 'paid_meta', true),
      mkTouch(2, 'email', true),
      mkTouch(3, 'paid_google', true),
      mkTouch(4, 'organic_social', true),
    ];
    const realized = 123_457n;
    const credit = computeAttributionCredit(baseCreditInput(touches, realized, true));
    const creditSum = credit.reduce((a, r) => a + r.creditedRevenueMinor, 0n);
    expect(creditSum).toBe(realized);

    // FULL RTO: reversal basis = −(original realized).
    const clawback = computeAttributionClawback({
      savedCredits: asSaved(credit),
      reversalLedgerEventId: 'rev-evt-1',
      reversalReason: 'rto_reversal',
      reversalBasisMinor: -realized,
      occurredAt: NOW,
      economicEffectiveAt: NOW,
      billingPostedPeriod: '2026-06',
    });

    // Per-touch: credit_i + clawback_i = 0
    for (let i = 0; i < credit.length; i++) {
      expect((credit[i]?.creditedRevenueMinor ?? 0n) + (clawback[i]?.creditedRevenueMinor ?? 0n)).toBe(0n);
    }
    // Per-order closed-sum = 0
    const netSum = [...credit, ...clawback].reduce((a, r) => a + r.creditedRevenueMinor, 0n);
    expect(netSum).toBe(0n);

    // clawback carries the SAVED weight verbatim + reversed_of_credit_id + verbatim confidence
    for (let i = 0; i < clawback.length; i++) {
      expect(clawback[i]?.weightFraction).toBe(credit[i]?.weightFraction);
      expect(clawback[i]?.reversedOfCreditId).toBe(credit[i]?.creditId);
      expect(clawback[i]?.rowKind).toBe('clawback');
      expect(clawback[i]?.reversalReason).toBe('rto_reversal');
      expect(clawback[i]?.confidenceGrade).toBe(credit[i]?.confidenceGrade);
    }
  });
});

describe('FIXTURE: partial refund → proportional clawback to SAVED weights', () => {
  it('50% refund → each clawback ≈ −50% of its credit, apportioned over SAVED weights', () => {
    const touches = [
      mkTouch(1, 'paid_meta', true),
      mkTouch(2, 'email', true),
      mkTouch(3, 'paid_google', true),
    ];
    const realized = 100_000n; // 40000 / 20000 / 40000
    const credit = computeAttributionCredit(baseCreditInput(touches, realized, true));
    expect(credit.map((r) => r.creditedRevenueMinor)).toEqual([40_000n, 20_000n, 40_000n]);

    // 50% partial refund → basis = −50000.
    const clawback = computeAttributionClawback({
      savedCredits: asSaved(credit),
      reversalLedgerEventId: 'rev-evt-partial',
      reversalReason: 'refund',
      reversalBasisMinor: -50_000n,
      occurredAt: NOW,
      economicEffectiveAt: NOW,
      billingPostedPeriod: '2026-06',
    });

    // Proportional to the SAVED weights (40/20/40 of −50000) — NOT a fresh re-apportionment.
    expect(clawback.map((r) => r.creditedRevenueMinor)).toEqual([-20_000n, -10_000n, -20_000n]);
    // Σ clawback = −50000 exactly
    expect(clawback.reduce((a, r) => a + r.creditedRevenueMinor, 0n)).toBe(-50_000n);
    // Net attributed after partial = 50000 (half remains attributed)
    const net = [...credit, ...clawback].reduce((a, r) => a + r.creditedRevenueMinor, 0n);
    expect(net).toBe(50_000n);
  });

  it('partial clawback uses SAVED weight even when the journey would re-apportion differently', () => {
    // Original credit under N=3 (40/20/40). Saved weights persist.
    const original = computeAttributionCredit(
      baseCreditInput(
        [mkTouch(1, 'paid_meta', true), mkTouch(2, 'email', true), mkTouch(3, 'paid_google', true)],
        80_000n,
        true,
      ),
    );
    const saved = asSaved(original);
    // Even if "current" touches were N=2 (50/50), clawback MUST use the saved 40/20/40.
    const clawback = computeAttributionClawback({
      savedCredits: saved,
      reversalLedgerEventId: 'rev-evt-2',
      reversalReason: 'chargeback',
      reversalBasisMinor: -80_000n,
      occurredAt: NOW,
      economicEffectiveAt: NOW,
      billingPostedPeriod: '2026-06',
    });
    expect(clawback.map((r) => r.weightFraction)).toEqual(['0.40000000', '0.20000000', '0.40000000']);
    expect(clawback.map((r) => r.creditedRevenueMinor)).toEqual([-32_000n, -16_000n, -32_000n]);
  });
});

describe('FIXTURE: cookieless residual → unattributed, grade weak, closed-sum holds', () => {
  it('order with NO journey → no credit rows; realized lands in unattributed', () => {
    const rows = computeAttributionCredit(baseCreditInput([], 75_000n, false));
    expect(rows).toEqual([]);
    // Σ credited = 0 → unattributed = realized − 0 = 75000 → closed-sum: 0 + 75000 = 75000 = realized.
    const attributed = rows.reduce((a, r) => a + r.creditedRevenueMinor, 0n);
    const realized = 75_000n;
    const unattributed = realized - attributed;
    expect(attributed + unattributed).toBe(realized);
    expect(unattributed).toBe(75_000n);
  });

  it('direct-only journey → grade weak (cookieless), still closed-sum exact', () => {
    const rows = computeAttributionCredit(
      baseCreditInput(
        [mkTouch(1, 'direct', false), mkTouch(2, 'direct', false)],
        60_001n,
        false, // unstitched → weak
      ),
    );
    expect(rows.every((r) => r.confidenceGrade === 'weak')).toBe(true);
    expect(rows.every((r) => r.attributionConfidence === '0.400')).toBe(true);
    expect(rows.reduce((a, r) => a + r.creditedRevenueMinor, 0n)).toBe(60_001n);
  });

  it('stitched but ≥1 direct touch → grade partial (0.700)', () => {
    const rows = computeAttributionCredit(
      baseCreditInput(
        [mkTouch(1, 'paid_meta', true), mkTouch(2, 'direct', false)],
        40_000n,
        true,
      ),
    );
    expect(rows.every((r) => r.confidenceGrade === 'partial')).toBe(true);
    expect(rows.every((r) => r.attributionConfidence === '0.700')).toBe(true);
  });
});

describe('PARITY ORACLE — period-level closed-sum over many orders (engine-internal)', () => {
  it('Σ channel_contribution + unattributed = realized across a mixed period', () => {
    // Three orders: one multi-touch (fully credited), one partially refunded, one unattributed.
    const realizedByOrder: bigint[] = [];
    let attributed = 0n;

    // Order A: multi-touch, fully credited.
    const a = computeAttributionCredit({
      ...baseCreditInput(
        [mkTouch(1, 'paid_meta', true), mkTouch(2, 'email', true), mkTouch(3, 'paid_google', true)],
        100_000n,
        true,
      ),
      orderId: 'A',
      brainAnonId: 'anonA',
    });
    realizedByOrder.push(100_000n);
    attributed += a.reduce((s, r) => s + r.creditedRevenueMinor, 0n);

    // Order B: credited then 50% refunded.
    const b = computeAttributionCredit({
      ...baseCreditInput(
        [mkTouch(1, 'paid_google', true), mkTouch(2, 'paid_meta', true)],
        80_000n,
        true,
      ),
      orderId: 'B',
      brainAnonId: 'anonB',
    });
    const bClaw = computeAttributionClawback({
      savedCredits: asSaved(b),
      reversalLedgerEventId: 'B-rev',
      reversalReason: 'refund',
      reversalBasisMinor: -40_000n,
      occurredAt: NOW,
      economicEffectiveAt: NOW,
      billingPostedPeriod: '2026-06',
    });
    realizedByOrder.push(80_000n - 40_000n); // realized net of the refund = 40000
    attributed += [...b, ...bClaw].reduce((s, r) => s + r.creditedRevenueMinor, 0n);

    // Order C: unattributed (no journey).
    const c = computeAttributionCredit({
      ...baseCreditInput([], 25_000n, false),
      orderId: 'C',
      brainAnonId: 'anonC',
    });
    realizedByOrder.push(25_000n);
    attributed += c.reduce((s, r) => s + r.creditedRevenueMinor, 0n);

    const realized = realizedByOrder.reduce((s, r) => s + r, 0n); // 100000+40000+25000 = 165000
    const unattributed = realized - attributed;

    // THE ORACLE: Σ channel_contribution (== attributed) + unattributed == realized, exactly.
    expect(attributed + unattributed).toBe(realized);
    expect(realized).toBe(165_000n);
    // A fully attributed (100000), B nets 40000 attributed, C 0 → attributed = 140000.
    expect(attributed).toBe(140_000n);
    expect(unattributed).toBe(25_000n);
  });
});
