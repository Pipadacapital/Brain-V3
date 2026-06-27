/**
 * resolverBridge.test.ts — the Confidence Engine grading the EXISTING IdentityResolver's decision.
 *
 * Confirms the engine WRAPS (does not replace) the resolver: feeding the resolver's own
 * ExtractedIdentifier + ExistingLink + ResolveOutcome through the bridge yields a verdict whose
 * band matches the resolver's action (mint → none, link → exact, merge → exact+eligible,
 * cycle-guard skip → capped below exact, device adoption → resolve-only sub-exact).
 *
 * @effort("deterministic").
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  IdentityResolver,
  type ExtractedIdentifier,
  type ExistingLink,
  type BrandPhoneGuardConfig,
} from '../IdentityResolver.js';
import { ConfidenceEngine } from './ConfidenceEngine.js';
import { gradeResolverOutcome, evidenceFromResolver } from './resolverBridge.js';

const BRAND = '22222222-2222-2222-2222-222222222222';
const BRAIN_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const BRAIN_B = 'bbbbbbbb-0000-0000-0000-000000000002';
const cfg: BrandPhoneGuardConfig = { phone_guard_threshold: 10, suppression_window_days: 30 };

const h = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const EMAIL = h('user@example.com');
const PHONE = h('+919876543210');
const DEVICE = h('device-xyz');

const resolver = new IdentityResolver();
const engine = new ConfidenceEngine();

function emailId(hash = EMAIL): ExtractedIdentifier {
  return { type: 'email', hash, tier: 'strong', confidence: 'high', rawValue: 'user@example.com' };
}
function phoneId(hash = PHONE): ExtractedIdentifier {
  return { type: 'phone', hash, tier: 'strong', confidence: 'high', rawValue: '+919876543210' };
}
function deviceId(hash = DEVICE): ExtractedIdentifier {
  return { type: 'device_id', hash, tier: 'medium', confidence: 'low' };
}
function link(brainId: string, type: string, hash: string): ExistingLink {
  return { brain_id: brainId, identifier_type: type, identifier_value: hash, is_active: true };
}

describe('resolverBridge — grade the IdentityResolver outcome', () => {
  it('MINT (no existing links) → band none, not merge-eligible', () => {
    const ids = [emailId()];
    const outcome = resolver.resolve(BRAND, ids, [], new Map(), new Map(), cfg, new Set());
    expect(outcome.action).toBe('minted');
    const v = gradeResolverOutcome(engine, { brand_id: BRAND, identifiers: ids, existingLinks: [], outcome });
    expect(v.band).toBe('none');
    expect(v.score).toBe(0);
    expect(engine.isMergeEligible(v)).toBe(false);
  });

  it('LINK (one strong match) → band exact, score 100', () => {
    const ids = [emailId()];
    const existing = [link(BRAIN_A, 'email', EMAIL)];
    const outcome = resolver.resolve(BRAND, ids, existing, new Map(), new Map(), cfg, new Set());
    expect(outcome.action).toBe('linked');
    const v = gradeResolverOutcome(engine, { brand_id: BRAND, identifiers: ids, existingLinks: existing, outcome });
    expect(v.band).toBe('exact');
    expect(v.score).toBe(100);
    expect(engine.isMergeEligible(v)).toBe(true);
  });

  it('MERGE (≥2 strong brain_ids) → exact + merge-eligible, canonical lowest UUID', () => {
    const ids = [emailId(), phoneId()];
    const existing = [link(BRAIN_A, 'email', EMAIL), link(BRAIN_B, 'phone', PHONE)];
    const outcome = resolver.resolve(BRAND, ids, existing, new Map(), new Map(), cfg, new Set());
    expect(outcome.action).toBe('merged');
    const v = gradeResolverOutcome(engine, { brand_id: BRAND, identifiers: ids, existingLinks: existing, outcome });
    expect(v.band).toBe('exact');
    expect(engine.isMergeEligible(v)).toBe(true);
    const canonical = [BRAIN_A, BRAIN_B].sort()[0]!;
    expect(v.reasons).toContain(`merge:canonical=${canonical}`);
  });

  it('CYCLE-GUARD skip (routeToReview) → capped below exact, not merge-eligible', () => {
    const ids = [emailId(), phoneId()];
    const existing = [link(BRAIN_A, 'email', EMAIL), link(BRAIN_B, 'phone', PHONE)];
    // Seed the alias chain so the merge is skipped → routeToReview.
    const outcome = resolver.resolve(BRAND, ids, existing, new Map(), new Map(), cfg, new Set([BRAIN_A]));
    expect(outcome.action).toBe('skipped');
    expect(outcome.routeToReview).toBe(true);
    const v = gradeResolverOutcome(engine, { brand_id: BRAND, identifiers: ids, existingLinks: existing, outcome });
    expect(v.band).not.toBe('exact');
    expect(engine.isMergeEligible(v)).toBe(false);
    expect(v.reasons.some((r) => r.startsWith('route_to_review:'))).toBe(true);
  });

  it('DEVICE adoption (medium match, no strong) → resolve-only sub-exact, not merge-eligible', () => {
    const ids = [deviceId()];
    const existing = [link(BRAIN_A, 'device_id', DEVICE)];
    const outcome = resolver.resolve(BRAND, ids, existing, new Map(), new Map(), cfg, new Set());
    // resolver adopts the brain_id via the medium identifier (linked outcome)
    const ev = evidenceFromResolver({ brand_id: BRAND, identifiers: ids, existingLinks: existing, outcome });
    expect(ev.mediumMatches.length).toBe(1);
    expect(ev.strongMatches.length).toBe(0);
    const v = engine.assess(ev);
    expect(v.band).not.toBe('exact');
    expect(engine.isMergeEligible(v)).toBe(false);
    expect(v.reasons).toContain('cross_device:deterministic_adopt');
  });
});
