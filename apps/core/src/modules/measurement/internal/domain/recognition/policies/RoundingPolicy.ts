/**
 * RoundingPolicy — banker's rounding for sub-minor-unit amounts (D-7).
 * Uses roundToMinorBankers from @brain/money.
 * Never silent truncation — the delta is always recorded.
 */

import { roundToMinorBankers } from '@brain/money';

export interface RoundingInput {
  /** Raw value in 1/scale minor units (e.g. 150 for "1.50 paise" when scale=100). */
  readonly valueScaled: bigint;
  /** Denominator (e.g. 100n for hundredths of a minor unit). */
  readonly scale: bigint;
}

export interface RoundingOutput {
  readonly amountMinor: bigint;           // rounded minor units (bigint, I-S07)
  readonly roundingAdjustmentMinor: bigint; // delta written to rounding_adjustment_minor
}

/**
 * Apply banker's rounding to a sub-minor-unit scaled value.
 * Use this when a settlement/marketplace fee arrives with sub-minor precision.
 */
export function applyRounding(input: RoundingInput): RoundingOutput {
  const result = roundToMinorBankers(input.valueScaled, input.scale);
  return {
    amountMinor: result.minor,
    roundingAdjustmentMinor: result.adjustment_minor,
  };
}
