/**
 * attribution-datadriven.test.ts — Markov removal-effect model (pure, deterministic).
 *
 * The math is the reviewable IP, so the tests pin: (1) channel weights sum to WEIGHT_SCALE exactly;
 * (2) a NECESSARY channel (every conversion passes through it) earns ~all the credit; (3) a USELESS
 * channel (present only in non-converting journeys) earns ~zero; (4) determinism (same corpus → same
 * weights); (5) honest degenerate handling (no channels / no conversions → uniform); (6) the per-
 * journey weight mapping closes to WEIGHT_SCALE and feeds exact closed-sum money.
 */
import { describe, it, expect } from 'vitest';
import {
  computeMarkovChannelWeights,
  dataDrivenTouchWeightUnits,
  type DataDrivenJourney,
} from './attribution-datadriven.js';
import { WEIGHT_SCALE, computeTouchCreditsExplicit } from './attribution-models.js';

function sumUnits(m: Map<string, bigint>): bigint {
  let s = 0n;
  for (const v of m.values()) s += v;
  return s;
}

describe('computeMarkovChannelWeights', () => {
  it('channel weight units sum to WEIGHT_SCALE exactly', () => {
    const journeys: DataDrivenJourney[] = [
      { channels: ['paid_meta', 'referral'], converted: true },
      { channels: ['paid_google'], converted: true },
      { channels: ['paid_meta'], converted: false },
      { channels: ['referral', 'paid_google'], converted: true },
    ];
    const r = computeMarkovChannelWeights(journeys);
    expect(sumUnits(r.channelWeightUnits)).toBe(WEIGHT_SCALE);
    expect(r.channels).toEqual(['paid_google', 'paid_meta', 'referral']); // sorted
  });

  it('a NECESSARY channel (on every converting path) earns the dominant weight', () => {
    // Every conversion goes through paid_meta; removing it collapses conversion → high removal effect.
    const journeys: DataDrivenJourney[] = [
      { channels: ['paid_meta'], converted: true },
      { channels: ['paid_meta', 'referral'], converted: true },
      { channels: ['referral'], converted: false },
      { channels: ['paid_meta', 'email'], converted: true },
    ];
    const r = computeMarkovChannelWeights(journeys);
    const meta = r.channelWeightUnits.get('paid_meta')!;
    const referral = r.channelWeightUnits.get('referral')!;
    const email = r.channelWeightUnits.get('email')!;
    expect(meta).toBeGreaterThan(referral);
    expect(meta).toBeGreaterThan(email);
    // paid_meta is necessary → it should hold the majority of the weight.
    expect(meta * 2n).toBeGreaterThan(WEIGHT_SCALE);
  });

  it('a channel present ONLY in non-converting journeys earns ~zero weight', () => {
    const journeys: DataDrivenJourney[] = [
      { channels: ['paid_google'], converted: true },
      { channels: ['paid_google', 'email'], converted: true },
      { channels: ['spam_channel'], converted: false },
      { channels: ['spam_channel', 'spam_channel'], converted: false },
    ];
    const r = computeMarkovChannelWeights(journeys);
    const spam = r.channelWeightUnits.get('spam_channel') ?? 0n;
    const google = r.channelWeightUnits.get('paid_google')!;
    expect(spam).toBe(0n);
    expect(google).toBeGreaterThan(0n);
  });

  it('is deterministic — same corpus yields byte-identical weights', () => {
    const journeys: DataDrivenJourney[] = [
      { channels: ['a', 'b', 'c'], converted: true },
      { channels: ['b', 'c'], converted: false },
      { channels: ['a', 'c'], converted: true },
      { channels: ['c'], converted: true },
    ];
    const r1 = computeMarkovChannelWeights(journeys);
    const r2 = computeMarkovChannelWeights(journeys);
    expect([...r1.channelWeightUnits.entries()]).toEqual([...r2.channelWeightUnits.entries()]);
  });

  it('honest degenerate: no channels → empty; zero conversions → uniform', () => {
    expect(computeMarkovChannelWeights([]).channelWeightUnits.size).toBe(0);

    const noConv: DataDrivenJourney[] = [
      { channels: ['x'], converted: false },
      { channels: ['y'], converted: false },
    ];
    const r = computeMarkovChannelWeights(noConv);
    expect(sumUnits(r.channelWeightUnits)).toBe(WEIGHT_SCALE);
    // No conversion signal → uniform across the 2 channels seen.
    expect(r.channelWeightUnits.get('x')).toBe(r.channelWeightUnits.get('y'));
  });
});

describe('dataDrivenTouchWeightUnits + closed-sum money', () => {
  it('maps a journey to per-touch units summing to WEIGHT_SCALE and apportions money exactly', () => {
    const channelWeights = new Map<string, bigint>([
      ['paid_meta', 70_000_000n],
      ['referral', 30_000_000n],
    ]);
    const touchChannels = ['paid_meta', 'referral', 'paid_meta'];
    const units = dataDrivenTouchWeightUnits(touchChannels, channelWeights);
    expect(units.reduce((a, b) => a + b, 0n)).toBe(WEIGHT_SCALE);

    const credits = computeTouchCreditsExplicit(
      units,
      touchChannels.map((_, i) => ({ touchSeq: i + 1 })),
      1_000_000n,
    );
    const total = credits.reduce((a, c) => a + c.creditedRevenueMinor, 0n);
    expect(total).toBe(1_000_000n); // exact closed-sum at the order
    // paid_meta appears twice with higher channel weight → it gets the most credit.
    expect(credits[0]!.creditedRevenueMinor).toBeGreaterThan(credits[1]!.creditedRevenueMinor);
  });

  it('a journey whose channels carry no global weight → uniform (no signal, still closed-sum)', () => {
    const units = dataDrivenTouchWeightUnits(['unknown1', 'unknown2'], new Map());
    expect(units.reduce((a, b) => a + b, 0n)).toBe(WEIGHT_SCALE);
    expect(units[0]).toBe(units[1]); // uniform fallback
  });

  it('empty journey → no weights', () => {
    expect(dataDrivenTouchWeightUnits([], new Map())).toEqual([]);
  });
});
