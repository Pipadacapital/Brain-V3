/**
 * ProbabilisticMatcher.test.ts — the RULE-BASED, REVIEW-GATED Fellegi–Sunter matcher (PROB).
 *
 * CRITICAL safety properties proved here:
 *   • A weak-signal verdict is SUB-EXACT by construction — band ∈ {high,medium,low,none}, NEVER
 *     'exact', score NEVER 100 (hard-capped at MAX_PROBABILISTIC_SCORE). It can never auto-merge.
 *   • Strong agreement across weak signals → a HIGH-confidence (but sub-exact) verdict.
 *   • Weak / no agreement → low / none.
 *   • It reads ONLY weak signals — strong/medium identifiers are ignored (never a merge key); the
 *     deterministic union-find is unaffected.
 *   • Pure: order-independent, brand_id-first tenant isolation, integer 0–100, hash-only combo.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import type { Identifier, MatcherInput } from '@brain/contracts';
import {
  ProbabilisticMatcher,
  MAX_PROBABILISTIC_SCORE,
  DEFAULT_PROBABILISTIC_WEIGHTS,
} from './ProbabilisticMatcher.js';

const BRAND = '44444444-4444-4444-4444-444444444444';
const OTHER_BRAND = '55555555-5555-5555-5555-555555555555';

function h(seed: string): string {
  return createHash('sha256').update(seed, 'utf8').digest('hex');
}

const FP = h('fingerprint-abc');
const COOKIE = h('cookie-abc');
const SESSION = h('session-abc');
const IP = h('203.0.113.7');

function weak(type: Identifier['identifier_type'], hash: string, brand = BRAND): Identifier {
  return { brand_id: brand, identifier_type: type, identifier_hash: hash, tier: 'weak' };
}

const matcher = new ProbabilisticMatcher();

function run(identifiers: Identifier[], candidates: Identifier[], brand = BRAND) {
  const input: MatcherInput = { brand_id: brand, identifiers, candidates };
  return matcher.match(input);
}

describe('ProbabilisticMatcher — SUB-EXACT by construction (never auto-merge)', () => {
  it('strong weak-signal agreement (fingerprint + cookie) → HIGH band, sub-exact, never 100/exact', () => {
    const ids = [weak('device_fingerprint', FP), weak('cookie_id', COOKIE)];
    const v = run(ids, ids);
    // 45 (fingerprint) + 35 (cookie) + 15 (co-occurrence) = 95 → high, but NEVER exact.
    expect(v.score).toBe(95);
    expect(v.band).toBe('high');
    expect(v.band).not.toBe('exact');
    expect(v.score).toBeLessThan(100);
    expect(v.matcher_id).toBe('probabilistic-fellegi-sunter');
    expect(v.reasons).toContain('weak_agree:device_fingerprint');
    expect(v.reasons).toContain('weak_agree:cookie_id');
    expect(v.reasons).toContain('co_occurrence:2');
    expect(v.reasons).toContain('never_merge:route_to_review');
    // combo is hash-only (I-S02).
    expect(v.identifier_combo).toEqual(
      expect.arrayContaining([
        { identifier_type: 'device_fingerprint', identifier_hash: FP },
        { identifier_type: 'cookie_id', identifier_hash: COOKIE },
      ]),
    );
  });

  it('ALL four weak signals agreeing is STILL capped below exact (hard never-merge floor)', () => {
    const ids = [
      weak('device_fingerprint', FP),
      weak('cookie_id', COOKIE),
      weak('session_id', SESSION),
      weak('ip', IP),
    ];
    const v = run(ids, ids);
    expect(v.score).toBe(MAX_PROBABILISTIC_SCORE); // 95, hard cap
    expect(v.score).toBeLessThan(100);
    expect(v.band).not.toBe('exact');
    expect(v.band).toBe('high');
  });

  it('a single WEAK agreement (ip only) → low band, low score', () => {
    const ids = [weak('ip', IP)];
    const v = run(ids, ids);
    expect(v.score).toBe(DEFAULT_PROBABILISTIC_WEIGHTS.ip); // 15
    expect(v.band).toBe('low');
    expect(v.reasons).toContain('weak_agree:ip');
    expect(v.reasons).not.toContain('co_occurrence:2');
  });

  it('a single device_fingerprint agreement → medium band', () => {
    const ids = [weak('device_fingerprint', FP)];
    const v = run(ids, ids);
    expect(v.score).toBe(45);
    expect(v.band).toBe('medium');
  });

  it('NO weak-signal agreement → score 0, band none', () => {
    const ids = [weak('device_fingerprint', FP)];
    const v = run(ids, [weak('device_fingerprint', h('different'))]); // no overlap
    expect(v.score).toBe(0);
    expect(v.band).toBe('none');
    expect(v.reasons).toContain('no_weak_signal_agreement');
  });
});

describe('ProbabilisticMatcher — reads ONLY weak signals (deterministic union-find unaffected)', () => {
  it('strong/medium identifier agreement is IGNORED — only weak signals contribute', () => {
    const strongEmail: Identifier = { brand_id: BRAND, identifier_type: 'email', identifier_hash: h('e'), tier: 'strong' };
    const mediumDevice: Identifier = { brand_id: BRAND, identifier_type: 'device_id', identifier_hash: h('d'), tier: 'medium' };
    // Both strong + medium agree, but they are NOT weak signals → no probabilistic score.
    const v = run([strongEmail, mediumDevice], [strongEmail, mediumDevice]);
    expect(v.score).toBe(0);
    expect(v.band).toBe('none');
    expect(v.reasons).toContain('no_weak_signal_agreement');
  });

  it('weak score is computed even when strong/medium are present (strong simply ignored here)', () => {
    const strongEmail: Identifier = { brand_id: BRAND, identifier_type: 'email', identifier_hash: h('e'), tier: 'strong' };
    const fp = weak('device_fingerprint', FP);
    const v = run([strongEmail, fp], [strongEmail, fp]);
    expect(v.score).toBe(45); // only the fingerprint contributes
    expect(v.identifier_combo).toEqual([{ identifier_type: 'device_fingerprint', identifier_hash: FP }]);
  });
});

describe('ProbabilisticMatcher — purity invariants', () => {
  it('brand_id-first isolation: a cross-brand candidate never agrees', () => {
    const ids = [weak('device_fingerprint', FP)];
    const foreign = [weak('device_fingerprint', FP, OTHER_BRAND)];
    const v = run(ids, foreign);
    expect(v.score).toBe(0);
    expect(v.band).toBe('none');
  });

  it('order-independent — shuffling identifiers/candidates yields a byte-identical verdict', () => {
    const a = weak('device_fingerprint', FP);
    const b = weak('cookie_id', COOKIE);
    const v1 = run([a, b], [a, b]);
    const v2 = run([b, a], [b, a]);
    expect(v2).toEqual(v1);
  });

  it('score is an INTEGER in [0,100] on every branch (never money/float)', () => {
    const samples = [
      run([weak('ip', IP)], [weak('ip', IP)]),
      run([weak('device_fingerprint', FP), weak('cookie_id', COOKIE)], [weak('device_fingerprint', FP), weak('cookie_id', COOKIE)]),
      run([weak('session_id', SESSION)], []),
    ];
    for (const v of samples) {
      expect(Number.isInteger(v.score)).toBe(true);
      expect(v.score).toBeGreaterThanOrEqual(0);
      expect(v.score).toBeLessThanOrEqual(100);
      expect(v.band).not.toBe('exact');
    }
  });

  it('weights are configurable per deployment', () => {
    const custom = new ProbabilisticMatcher({ ip: 5 });
    const v = custom.match({ brand_id: BRAND, identifiers: [weak('ip', IP)], candidates: [weak('ip', IP)] });
    expect(v.score).toBe(5);
    expect(v.band).toBe('low');
  });
});
