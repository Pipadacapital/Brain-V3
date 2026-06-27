/**
 * journey-stitch-exit-code.test.ts — the poison-pill fix.
 *
 * A per-brand crypto error (unprovisioned / stale-KMS-wrapped salt) is an ISOLATED operational state
 * and must NOT fail the whole cross-brand batch (which would fail the v4-refresh step). The job exits
 * non-zero ONLY when EVERY attempted brand failed (a systemic infra problem).
 */
import { describe, it, expect } from 'vitest';
import { journeyStitchExitCode } from '../jobs/journey-stitch-from-identity.js';

describe('journeyStitchExitCode', () => {
  it('partial failure (some brands errored) → 0 — does not poison the batch', () => {
    // The exact observed case: 8 of 9 brands had stale crypto, 1 stitched fine.
    expect(journeyStitchExitCode({ brands: 9, errors: 8 })).toBe(0);
  });

  it('no errors → 0', () => {
    expect(journeyStitchExitCode({ brands: 9, errors: 0 })).toBe(0);
  });

  it('systemic failure (every attempted brand failed) → 1', () => {
    expect(journeyStitchExitCode({ brands: 9, errors: 9 })).toBe(1);
  });

  it('single brand that failed → 1 (all-failed is indistinguishable from systemic)', () => {
    expect(journeyStitchExitCode({ brands: 1, errors: 1 })).toBe(1);
  });

  it('no brands to process → 0 (nothing to do is not a failure)', () => {
    expect(journeyStitchExitCode({ brands: 0, errors: 0 })).toBe(0);
  });
});
