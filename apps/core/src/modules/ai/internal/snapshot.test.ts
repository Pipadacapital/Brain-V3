/**
 * snapshot.test.ts — the reproducibility-handle proof (D3).
 *
 * THE INVARIANT: a snapshot_id deterministically pins the read frame so re-running a binding
 * at the snapshot reproduces the SAME number. This unit test proves the encode/decode handle
 * is a stable, lossless round-trip (the engine-level reproduction is asserted by the eval gate
 * + the ai-provenance reproducibility path). A corrupt handle MUST fail closed — never silently
 * decode to a wrong as_of.
 */

import { describe, it, expect } from 'vitest';
import { encodeSnapshot, decodeSnapshot } from './snapshot.js';

describe('snapshot_id — deterministic reproducibility handle (D3)', () => {
  it('round-trips an as_of date losslessly (decode(encode(x)) === x)', () => {
    for (const asOf of ['2026-06-18', '2025-01-01', '2024-12-31']) {
      expect(decodeSnapshot(encodeSnapshot(asOf))).toBe(asOf);
    }
  });

  it('is deterministic — same as_of yields the SAME snapshot_id', () => {
    expect(encodeSnapshot('2026-06-18')).toBe(encodeSnapshot('2026-06-18'));
  });

  it('produces an opaque (base64url, no padding) handle — not the raw date', () => {
    const id = encodeSnapshot('2026-06-18');
    expect(id).not.toContain('2026-06-18');
    expect(id).not.toMatch(/[+/=]/); // url-safe, unpadded
  });

  it('rejects a non-date as_of (fail-closed — never pin a garbage frame)', () => {
    expect(() => encodeSnapshot('not-a-date')).toThrow();
    expect(() => encodeSnapshot('2026-6-1')).toThrow();
    expect(() => encodeSnapshot('')).toThrow();
  });

  it('rejects a corrupt / unknown-version snapshot_id (fail-closed decode)', () => {
    expect(() => decodeSnapshot('!!!not-base64!!!@@@')).toThrow();
    // A handle whose payload decodes to a non-date / wrong version must throw.
    const wrongVersion = Buffer.from('v9:2026-06-18', 'utf8').toString('base64url');
    expect(() => decodeSnapshot(wrongVersion)).toThrow();
    const nonDate = Buffer.from('v1:hello', 'utf8').toString('base64url');
    expect(() => decodeSnapshot(nonDate)).toThrow();
  });
});
