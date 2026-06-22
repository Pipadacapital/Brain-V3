import { describe, it, expect } from 'vitest';
import { computeAttributionCredit, type CreditInput, type CreditTouch } from './attribution-credit.js';

/**
 * DB-AUDIT H4 regression guard — campaign-level attribution. The audit reported campaign_id as a
 * "dead column never populated"; in fact the full chain IS wired (attribution-writer reads
 * utm_campaign → CreditTouch.campaignId → computeAttributionCredit → AttributionCreditRow.campaignId →
 * INSERT campaign_id). The empty column is only because attribution wasn't flowing (data-starvation),
 * not a code gap. This pins the compute leg: every credit row carries its touch's campaign, enabling
 * campaign/ad-level attributed revenue (joined to ad-spend campaign_id at read).
 */
function touch(seq: number, campaignId: string | null, channel = 'paid_google'): CreditTouch {
  return { touchSeq: seq, channel, campaignId, utmMedium: 'cpc', fbclid: null, gclid: 'g', ttclid: null };
}

function input(touches: CreditTouch[]): CreditInput {
  return {
    brandId: '11111111-1111-4111-8111-111111111111',
    orderId: 'order-h4',
    brainAnonId: 'anon-h4',
    model: 'linear',
    stitched: true,
    realizedRevenueMinor: 90000n,
    currencyCode: 'INR',
    touches,
    occurredAt: new Date('2026-06-01T00:00:00Z'),
    economicEffectiveAt: new Date('2026-06-01T00:00:00Z'),
    billingPostedPeriod: '2026-06',
  };
}

describe('campaign attribution (H4) — credit rows carry the touch campaign', () => {
  it('propagates each touch campaign_id onto its credit row', () => {
    const rows = computeAttributionCredit(input([
      touch(1, 'summer_sale'),
      touch(2, 'retargeting'),
      touch(3, null), // organic/no-campaign touch → null, honestly preserved
    ]));
    expect(rows.map((r) => r.campaignId)).toEqual(['summer_sale', 'retargeting', null]);
    // each credit row is tied to its own touch (no campaign bleed across touches)
    expect(rows.find((r) => r.touchSeq === 1)!.campaignId).toBe('summer_sale');
    expect(rows.find((r) => r.touchSeq === 2)!.campaignId).toBe('retargeting');
  });

  it('credited revenue still sums to the realized basis exactly (campaign tagging is additive-safe)', () => {
    const rows = computeAttributionCredit(input([touch(1, 'a'), touch(2, 'b')]));
    const sum = rows.reduce((acc, r) => acc + r.creditedRevenueMinor, 0n);
    expect(sum).toBe(90000n);
  });
});
