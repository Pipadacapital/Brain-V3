/**
 * ConfidenceEngine.test.ts — pure-domain unit tests for the Confidence Engine.
 *
 * Verifies the deterministic-first scoring contract:
 *   • STRONG exact hash match → score 100, band 'exact', MERGE-eligible.
 *   • ≥2 strong brain_ids → merge reason, canonical = lowest UUID (order-independent).
 *   • MEDIUM-tier (device/anon) single-brain_id adoption → sub-'exact' band, RESOLVE-ONLY,
 *     isMergeEligible === false (never a merge).
 *   • per-tenant band boundaries reconfigurable; the medium score is structurally clamped below
 *     'exact' (never-merge guarantee) even if a tenant misconfigures it.
 *   • integer score 0–100 (never money/float), hash-only combo, versioned verdict, tenant isolation,
 *     disabled matchers skipped.
 *
 * @effort("deterministic") — no model calls; pure aggregation + threshold banding.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { DisabledMatcher, type Identifier, type ConfidenceVerdict } from '@brain/contracts';
import {
  ConfidenceEngine,
  DEFAULT_CONFIDENCE_CONFIG,
  type ConfidenceEvidence,
  type IdentifierMatch,
  type TenantConfidenceOverride,
} from './ConfidenceEngine.js';
import { DeterministicUnionFindMatcher } from '../matchers/DeterministicUnionFindMatcher.js';
import { RULE_VERSION } from '../IdentityResolver.js';

const BRAND = '22222222-2222-2222-2222-222222222222';
const OTHER_BRAND = '33333333-3333-3333-3333-333333333333';
const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000002';
const C = 'cccccccc-0000-0000-0000-000000000003';

function h(seed: string): string {
  return createHash('sha256').update(seed, 'utf8').digest('hex');
}

const EMAIL_HASH = h('user@example.com');
const PHONE_HASH = h('+919876543210');
const DEVICE_HASH = h('device-xyz');

function strongEmail(brand = BRAND, hash = EMAIL_HASH): Identifier {
  return { brand_id: brand, identifier_type: 'email', identifier_hash: hash, tier: 'strong' };
}
function strongPhone(brand = BRAND, hash = PHONE_HASH): Identifier {
  return { brand_id: brand, identifier_type: 'phone', identifier_hash: hash, tier: 'strong' };
}
function mediumDevice(brand = BRAND, hash = DEVICE_HASH): Identifier {
  return { brand_id: brand, identifier_type: 'device_id', identifier_hash: hash, tier: 'medium' };
}
function match(id: Identifier, brainId: string): IdentifierMatch {
  return { identifier: id, brain_id: brainId };
}

const engine = new ConfidenceEngine();

describe('ConfidenceEngine — STRONG deterministic path', () => {
  it('exact strong-identifier hash match → score 100, band exact, merge-eligible', () => {
    const id = strongEmail();
    const ev: ConfidenceEvidence = {
      brand_id: BRAND,
      identifiers: [id],
      strongMatches: [match(id, A)],
      mediumMatches: [],
    };
    const v = engine.assess(ev);
    expect(v.score).toBe(100);
    expect(v.band).toBe('exact');
    expect(engine.isMergeEligible(v)).toBe(true);
    expect(v.reasons).toContain('strong_key:email');
    expect(v.matcher_id).toBe('deterministic-union-find');
    expect(v.rule_version).toBe(RULE_VERSION);
    // combo is hash-only — never raw PII.
    expect(v.identifier_combo).toEqual([{ identifier_type: 'email', identifier_hash: EMAIL_HASH }]);
  });

  it('≥2 distinct strong brain_ids → still exact/100, with a deterministic merge reason + lowest-UUID canonical', () => {
    const email = strongEmail();
    const phone = strongPhone();
    const ev: ConfidenceEvidence = {
      brand_id: BRAND,
      identifiers: [email, phone],
      strongMatches: [match(email, B), match(phone, A)], // two distinct brain_ids
      mediumMatches: [],
    };
    const v = engine.assess(ev);
    expect(v.score).toBe(100);
    expect(v.band).toBe('exact');
    expect(engine.isMergeEligible(v)).toBe(true);
    expect(v.reasons).toContain('merge:deterministic_union_find');
    expect(v.reasons).toContain(`merge:canonical=${A}`); // A < B → canonical
  });

  it('is order-independent — shuffling the strong matches yields a byte-identical verdict', () => {
    const email = strongEmail();
    const phone = strongPhone();
    const base = { brand_id: BRAND, identifiers: [email, phone], mediumMatches: [] as IdentifierMatch[] };
    const v1 = engine.assess({ ...base, strongMatches: [match(email, B), match(phone, A)] });
    const v2 = engine.assess({ ...base, strongMatches: [match(phone, A), match(email, B)] });
    expect(v2).toEqual(v1);
  });

  it('route-to-review caps a strong verdict BELOW exact (no auto-merge) and is not merge-eligible', () => {
    const email = strongEmail();
    const phone = strongPhone();
    const v = engine.assess({
      brand_id: BRAND,
      identifiers: [email, phone],
      strongMatches: [match(email, B), match(phone, A)],
      mediumMatches: [],
      routeToReview: true,
      routeReason: 'cycle-guard: alias chain collision',
    });
    expect(v.score).toBe(99); // exact(100) - 1
    expect(v.band).toBe('high');
    expect(engine.isMergeEligible(v)).toBe(false);
    expect(v.reasons.some((r) => r.startsWith('route_to_review:'))).toBe(true);
  });
});

describe('ConfidenceEngine — MEDIUM cross-device path (resolve-only, NEVER merge)', () => {
  it('single medium brain_id, no strong → sub-exact band, NOT merge-eligible', () => {
    const device = mediumDevice();
    const v = engine.assess({
      brand_id: BRAND,
      identifiers: [device],
      strongMatches: [],
      mediumMatches: [match(device, A)],
    });
    expect(v.score).toBe(DEFAULT_CONFIDENCE_CONFIG.mediumAdoptionScore); // 60
    expect(v.band).toBe('medium');
    expect(v.band).not.toBe('exact');
    expect(engine.isMergeEligible(v)).toBe(false);
    expect(v.reasons).toContain('cross_device:deterministic_adopt');
    expect(v.reasons).toContain('cross_device:adopt:device_id');
    // combo is the medium identifier (hash-only).
    expect(v.identifier_combo).toEqual([{ identifier_type: 'device_id', identifier_hash: DEVICE_HASH }]);
  });

  it('ambiguous medium (two brain_ids) → mint (score 0, band none) with an ambiguity reason', () => {
    const device = mediumDevice();
    const device2 = mediumDevice(BRAND, h('device-2'));
    const v = engine.assess({
      brand_id: BRAND,
      identifiers: [device, device2],
      strongMatches: [],
      mediumMatches: [match(device, A), match(device2, B)],
    });
    expect(v.score).toBe(0);
    expect(v.band).toBe('none');
    expect(engine.isMergeEligible(v)).toBe(false);
    expect(v.reasons).toContain('cross_device:ambiguous');
    expect(v.reasons).toContain('no_match:mint');
  });
});

describe('ConfidenceEngine — mint (no match)', () => {
  it('no matches → score 0, band none, combo = all input identifiers', () => {
    const email = strongEmail();
    const v = engine.assess({
      brand_id: BRAND,
      identifiers: [email],
      strongMatches: [],
      mediumMatches: [],
    });
    expect(v.score).toBe(0);
    expect(v.band).toBe('none');
    expect(v.reasons).toContain('no_match:mint');
    expect(v.identifier_combo).toEqual([{ identifier_type: 'email', identifier_hash: EMAIL_HASH }]);
  });
});

describe('ConfidenceEngine — per-tenant band boundaries', () => {
  it('a tenant can re-band the same score (medium threshold raised → adoption falls to band low)', () => {
    const perTenant = new Map<string, TenantConfidenceOverride>([
      [BRAND, { bandThresholds: { medium: 65 } }], // 60 < 65 now → 'low'
    ]);
    const e = new ConfidenceEngine({ perTenant });
    const device = mediumDevice();
    const v = e.assess({
      brand_id: BRAND,
      identifiers: [device],
      strongMatches: [],
      mediumMatches: [match(device, A)],
    });
    expect(v.score).toBe(60);
    expect(v.band).toBe('low'); // re-banded per tenant
    expect(e.isMergeEligible(v)).toBe(false);
  });

  it('NEVER-MERGE GUARANTEE: a misconfigured medium score ≥ exact is clamped strictly below exact', () => {
    const perTenant = new Map<string, TenantConfidenceOverride>([
      [BRAND, { mediumAdoptionScore: 100 }], // illegal: would tie 'exact'
    ]);
    const e = new ConfidenceEngine({ perTenant });
    const device = mediumDevice();
    const v = e.assess({
      brand_id: BRAND,
      identifiers: [device],
      strongMatches: [],
      mediumMatches: [match(device, A)],
    });
    expect(v.score).toBe(99); // clamped to exact - 1
    expect(v.band).not.toBe('exact'); // band 'high', but NEVER exact
    expect(e.isMergeEligible(v)).toBe(false);
    expect(v.reasons).toContain('config_guard:medium_capped_below_exact');
  });
});

describe('ConfidenceEngine — invariants', () => {
  it('score is an INTEGER in [0,100] (never a float, never money) on every branch', () => {
    const email = strongEmail();
    const device = mediumDevice();
    const verdicts: ConfidenceVerdict[] = [
      engine.assess({ brand_id: BRAND, identifiers: [email], strongMatches: [match(email, A)], mediumMatches: [] }),
      engine.assess({ brand_id: BRAND, identifiers: [device], strongMatches: [], mediumMatches: [match(device, A)] }),
      engine.assess({ brand_id: BRAND, identifiers: [email], strongMatches: [], mediumMatches: [] }),
    ];
    for (const v of verdicts) {
      expect(Number.isInteger(v.score)).toBe(true);
      expect(v.score).toBeGreaterThanOrEqual(0);
      expect(v.score).toBeLessThanOrEqual(100);
    }
  });

  it('rejects a cross-tenant identifier (brand_id isolation, defense-in-depth)', () => {
    const foreign = strongEmail(OTHER_BRAND);
    expect(() =>
      engine.assess({
        brand_id: BRAND,
        identifiers: [foreign],
        strongMatches: [match(foreign, A)],
        mediumMatches: [],
      }),
    ).toThrow(/tenant breach/i);
  });

  it('every verdict is versioned (rule_version === RULE_VERSION)', () => {
    const email = strongEmail();
    const v = engine.assess({ brand_id: BRAND, identifiers: [email], strongMatches: [match(email, A)], mediumMatches: [] });
    expect(v.rule_version).toBe(RULE_VERSION);
  });

  it('a DISABLED matcher in the matcher list is SKIPPED (never invoked → never throws)', () => {
    const disabled = new DisabledMatcher('probabilistic-fellegi-sunter', 'v0', 'probabilistic');
    const e = new ConfidenceEngine({ matchers: [disabled, new DeterministicUnionFindMatcher()] });
    const email = strongEmail();
    // If the engine invoked the disabled matcher it would throw NotImplementedYet.
    const v = e.assess({ brand_id: BRAND, identifiers: [email], strongMatches: [match(email, A)], mediumMatches: [] });
    expect(v.score).toBe(100);
    expect(v.band).toBe('exact');
  });

  it('canonical merge survivor is the lowest UUID across three strong brain_ids', () => {
    const email = strongEmail();
    const phone = strongPhone();
    const sfid: Identifier = { brand_id: BRAND, identifier_type: 'storefront_customer_id', identifier_hash: h('sf-1'), tier: 'strong' };
    const v = engine.assess({
      brand_id: BRAND,
      identifiers: [email, phone, sfid],
      strongMatches: [match(email, C), match(phone, B), match(sfid, A)],
      mediumMatches: [],
    });
    expect(v.reasons).toContain(`merge:canonical=${A}`);
  });
});

// ── PROB: the rule-based probabilistic matcher → ROUTE TO REVIEW, never auto-merge ──────────────
const FP_HASH = h('fingerprint-xyz');
const COOKIE_HASH = h('cookie-xyz');

function weakFingerprint(brand = BRAND, hash = FP_HASH): Identifier {
  return { brand_id: brand, identifier_type: 'device_fingerprint', identifier_hash: hash, tier: 'weak' };
}
function weakCookie(brand = BRAND, hash = COOKIE_HASH): Identifier {
  return { brand_id: brand, identifier_type: 'cookie_id', identifier_hash: hash, tier: 'weak' };
}

describe('ConfidenceEngine — PROBABILISTIC weak-signal path (route-to-review, NEVER merge)', () => {
  it('strong weak-signal agreement, no strong key → high-confidence but SUB-EXACT, routed to review, NOT merged', () => {
    const fp = weakFingerprint();
    const cookie = weakCookie();
    const v = engine.assess({
      brand_id: BRAND,
      identifiers: [fp, cookie],
      strongMatches: [],
      mediumMatches: [],
      weakMatches: [match(fp, A), match(cookie, A)], // both weak signals point at the same brain_id
    });
    // High confidence (fingerprint+cookie+co-occurrence = 95) but the band is NEVER 'exact'.
    expect(v.score).toBe(95);
    expect(v.band).toBe('high');
    expect(v.band).not.toBe('exact');
    expect(engine.isMergeEligible(v)).toBe(false); // ← the critical guarantee: cannot auto-merge
    expect(v.matcher_id).toBe('probabilistic-fellegi-sunter');
    expect(v.reasons).toContain('route_to_review:probabilistic_match');
    expect(v.reasons).toContain('never_merge:route_to_review');
    expect(v.identifier_combo).toEqual(
      expect.arrayContaining([
        { identifier_type: 'device_fingerprint', identifier_hash: FP_HASH },
        { identifier_type: 'cookie_id', identifier_hash: COOKIE_HASH },
      ]),
    );
  });

  it('a probabilistic verdict is NEVER merge-eligible — across every weak-agreement strength', () => {
    const fp = weakFingerprint();
    const cookie = weakCookie();
    const ip: Identifier = { brand_id: BRAND, identifier_type: 'ip', identifier_hash: h('ip-1'), tier: 'weak' };
    const cases: Identifier[][] = [[ip], [fp], [fp, cookie], [fp, cookie, ip]];
    for (const ids of cases) {
      const v = engine.assess({
        brand_id: BRAND,
        identifiers: ids,
        strongMatches: [],
        mediumMatches: [],
        weakMatches: ids.map((i) => match(i, A)),
      });
      expect(v.band).not.toBe('exact');
      expect(v.score).toBeLessThan(100);
      expect(engine.isMergeEligible(v)).toBe(false);
    }
  });

  it('DETERMINISTIC-FIRST: a strong-key match WINS over a weak-signal agreement (probabilistic does not interfere)', () => {
    const email = strongEmail();
    const fp = weakFingerprint();
    const v = engine.assess({
      brand_id: BRAND,
      identifiers: [email, fp],
      strongMatches: [match(email, A)], // strong key present
      mediumMatches: [],
      weakMatches: [match(fp, A)],
    });
    // Deterministic exact wins; the probabilistic contribution is NOT consulted.
    expect(v.score).toBe(100);
    expect(v.band).toBe('exact');
    expect(v.matcher_id).toBe('deterministic-union-find');
    expect(engine.isMergeEligible(v)).toBe(true);
    expect(v.reasons).not.toContain('route_to_review:probabilistic_match');
  });

  it('weak signals with NO graph agreement → mint (probabilistic contributes nothing)', () => {
    const fp = weakFingerprint();
    const v = engine.assess({
      brand_id: BRAND,
      identifiers: [fp],
      strongMatches: [],
      mediumMatches: [],
      weakMatches: [], // no candidate agreement
    });
    expect(v.score).toBe(0);
    expect(v.band).toBe('none');
    expect(v.reasons).toContain('no_match:mint');
    expect(engine.isMergeEligible(v)).toBe(false);
  });

  it('deterministic email merge still works unchanged with the probabilistic matcher enabled', () => {
    const email = strongEmail();
    const phone = strongPhone();
    const v = engine.assess({
      brand_id: BRAND,
      identifiers: [email, phone],
      strongMatches: [match(email, B), match(phone, A)],
      mediumMatches: [],
    });
    expect(v.score).toBe(100);
    expect(v.band).toBe('exact');
    expect(engine.isMergeEligible(v)).toBe(true);
    expect(v.reasons).toContain('merge:deterministic_union_find');
    expect(v.reasons).toContain(`merge:canonical=${A}`);
  });
});
