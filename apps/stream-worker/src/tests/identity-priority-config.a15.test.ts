/**
 * SPEC: A.1.5 (WA-12) — per-brand ORDERED identity priority (mParticle-style IDSync).
 *
 * Pure-domain unit tests over IdentityResolver (no DB / Kafka). Behind the `identity.priority_config`
 * flag: when a versioned priority config is threaded into resolve(), resolution walks the brand's
 * ORDERED precedence — highest-priority matching identifier wins; a lower-priority identifier matching
 * a DIFFERENT brain_id routes to review (A.2.3), NEVER a silent overwrite/merge. Flag OFF (no config)
 * → the legacy fixed-tier union-find runs byte-identically.
 *
 * Invariants (spec-named A1.5.*):
 *   A1.5.1 default priority order is applied (highest-priority class = platform_customer_id wins).
 *   A1.5.2 a custom per-brand order is respected (email over platform_customer_id flips the winner).
 *   A1.5.3 a lower-priority conflict routes to REVIEW and NEVER overwrites the higher-priority winner.
 *   A1.5.4 flag OFF (no config) is byte-identical to today's fixed-tier behavior (auto-merge).
 *   A1.5.5 the config VERSION is stamped on the outcome (mint / link / review alike).
 *   A1.5.6 consensus (all classes agree on one brain_id) → LINK; top-tier ambiguity → review.
 */
import { describe, it, expect } from 'vitest';
import {
  IdentityResolver,
  DEFAULT_IDENTITY_PRIORITY,
  type ExtractedIdentifier,
  type ExistingLink,
  type BrandPhoneGuardConfig,
  type IdentityPriorityConfig,
} from '../domain/identity/IdentityResolver.js';

const BRAND = '11111111-1111-1111-1111-111111111111';
const BRAIN_A = 'aaaaaaaa-0000-0000-0000-000000000001'; // lowest UUID (legacy merge canonical)
const BRAIN_B = 'bbbbbbbb-0000-0000-0000-000000000002';

const cfg: BrandPhoneGuardConfig = { phone_guard_threshold: 10, suppression_window_days: 30 };

function link(brainId: string, type: string, hash: string, tier = 'strong'): ExistingLink {
  return { brain_id: brainId, identifier_type: type, identifier_value: hash, is_active: true, tier } as ExistingLink;
}
function id(type: ExtractedIdentifier['type'], hash: string, tier: ExtractedIdentifier['tier']): ExtractedIdentifier {
  return { type, hash, tier, confidence: tier === 'medium' || tier === 'weak' ? 'low' : 'high' };
}

/** Default (version 0) config — the resolver falls back to DEFAULT_IDENTITY_PRIORITY when order is []. */
const DEFAULT_CFG: IdentityPriorityConfig = { version: 0, order: [] };

const r = new IdentityResolver();

// A cross-class conflict fixture reused across tests: the SAME event carries a platform id that
// resolves to BRAIN_A and an email that resolves to BRAIN_B (two different people).
const conflictEvent: ExtractedIdentifier[] = [
  id('storefront_customer_id', 'sfHashA', 'strong_on_link'),
  id('email', 'emailHashB', 'strong'),
];
const conflictLinks: ExistingLink[] = [
  link(BRAIN_A, 'storefront_customer_id', 'sfHashA'),
  link(BRAIN_B, 'email', 'emailHashB'),
];

describe('A1.5 per-brand ordered identity priority', () => {
  it('A1.5.1 default order — highest-priority class (platform_customer_id) wins the resolution', () => {
    // Default order = [platform_customer_id, email, phone, anonymous_id]. platform_customer_id
    // (BRAIN_A) outranks email (BRAIN_B) → the winner is BRAIN_A, not the lowest-UUID merge.
    const out = r.resolve(
      BRAND, conflictEvent, conflictLinks, new Map(), new Map(), cfg, new Set(), undefined, DEFAULT_CFG,
    );
    expect(out.brainId).toBe(BRAIN_A);            // platform_customer_id (highest) wins
    expect(out.routeToReview).toBe(true);         // email (lower) conflicts → review
    expect(out.action).toBe('skipped');
    expect(out.priorityConfigVersion).toBe(0);
  });

  it('A1.5.2 custom per-brand order is respected — email over platform_customer_id flips the winner', () => {
    const custom: IdentityPriorityConfig = {
      version: 7,
      order: ['email', 'phone', 'platform_customer_id', 'anonymous_id'],
    };
    const out = r.resolve(
      BRAND, conflictEvent, conflictLinks, new Map(), new Map(), cfg, new Set(), undefined, custom,
    );
    expect(out.brainId).toBe(BRAIN_B);            // email is now highest → BRAIN_B wins
    expect(out.routeToReview).toBe(true);         // platform_customer_id (now lower) conflicts
    expect(out.priorityConfigVersion).toBe(7);
  });

  it('A1.5.3 lower-priority conflict routes to REVIEW and never silently overwrites the winner', () => {
    const out = r.resolve(
      BRAND, conflictEvent, conflictLinks, new Map(), new Map(), cfg, new Set(), undefined, DEFAULT_CFG,
    );
    expect(out.action).toBe('skipped');           // NOT 'linked'/'merged' — no silent overwrite
    expect(out.routeToReview).toBe(true);
    expect(out.brainId).toBe(BRAIN_A);            // the higher-priority winner is preserved, not flipped to B
    expect(out.newLinks).toHaveLength(0);         // the conflicting lower id is NOT linked over
    expect(out.reviewReason).toMatch(/priority-conflict/);
    expect(out.merge).toBeUndefined();            // never an auto-merge
  });

  it('A1.5.4 flag OFF (no config) is byte-identical to the legacy fixed-tier union-find (auto-merge)', () => {
    // SAME inputs, but NO priorityConfig → legacy path: two strong keys → deterministic merge.
    const legacy = r.resolve(BRAND, conflictEvent, conflictLinks, new Map(), new Map(), cfg, new Set());
    expect(legacy.action).toBe('merged');
    expect(legacy.brainId).toBe(BRAIN_A);         // lowest-UUID canonical (AMD-09), unchanged
    expect(legacy.routeToReview).toBe(false);
    expect(legacy.merge?.canonicalBrainId).toBe(BRAIN_A);
    expect(legacy.merge?.mergedBrainId).toBe(BRAIN_B);
    expect(legacy.priorityConfigVersion).toBeUndefined(); // never stamped on the legacy path

    // And the ON path genuinely differs (proves the flag is the ONLY thing that changed behavior).
    const on = r.resolve(
      BRAND, conflictEvent, conflictLinks, new Map(), new Map(), cfg, new Set(), undefined, DEFAULT_CFG,
    );
    expect(on.action).toBe('skipped');
    expect(on.routeToReview).toBe(true);
  });

  it('A1.5.5 no match → MINT, and the config version is stamped on the outcome', () => {
    const out = r.resolve(
      BRAND, [id('email', 'brandNewEmail', 'strong')], [], new Map(), new Map(), cfg, new Set(), undefined,
      { version: 4, order: [] },
    );
    expect(out.action).toBe('minted');
    expect(out.newLinks.some((l) => l.type === 'email' && l.hash === 'brandNewEmail')).toBe(true);
    expect(out.priorityConfigVersion).toBe(4);
  });

  it('A1.5.6 consensus across classes → LINK; top-tier ambiguity → review', () => {
    // Consensus: platform id + email both resolve to BRAIN_A → LINK (no conflict, no review).
    const consensus = r.resolve(
      BRAND,
      [id('storefront_customer_id', 'sfA', 'strong_on_link'), id('email', 'emA', 'strong')],
      [link(BRAIN_A, 'storefront_customer_id', 'sfA'), link(BRAIN_A, 'email', 'emA')],
      new Map(), new Map(), cfg, new Set(), undefined, DEFAULT_CFG,
    );
    expect(consensus.action).toBe('linked');
    expect(consensus.brainId).toBe(BRAIN_A);
    expect(consensus.routeToReview).toBe(false);

    // Top-tier ambiguity: the WINNING class (platform_customer_id) itself matches two people →
    // never silent-overwrite → review, anchored on the deterministic lowest-UUID (BRAIN_A).
    const ambiguous = r.resolve(
      BRAND,
      [id('storefront_customer_id', 'sharedSf', 'strong_on_link')],
      [link(BRAIN_A, 'storefront_customer_id', 'sharedSf'), link(BRAIN_B, 'storefront_customer_id', 'sharedSf')],
      new Map(), new Map(), cfg, new Set(), undefined, DEFAULT_CFG,
    );
    expect(ambiguous.routeToReview).toBe(true);
    expect(ambiguous.action).toBe('skipped');
    expect(ambiguous.brainId).toBe(BRAIN_A);      // lowest-UUID anchor keeps the outcome replay-stable
  });

  it('A1.5 DEFAULT_IDENTITY_PRIORITY matches the spec order exactly', () => {
    expect([...DEFAULT_IDENTITY_PRIORITY]).toEqual([
      'platform_customer_id', 'email', 'phone', 'anonymous_id',
    ]);
  });
});
