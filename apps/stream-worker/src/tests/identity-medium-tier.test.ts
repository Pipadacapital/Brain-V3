/**
 * C2 (identity) — device_id / anon_id are MEDIUM-tier RESOLUTION INPUTS that resolve-only and
 * NEVER force a cross-person merge. Pure-domain unit tests over IdentityResolver (no DB / Kafka).
 *
 * Invariants under test:
 *   1. A medium id (anon_id) matching an existing brain_id, with no strong match → LINK (adopt it).
 *   2. A medium id present on a NEW person (no match) → MINT (its link persists for future adoption).
 *   3. A SHARED medium id pointing at TWO different brain_ids, with no strong key → it is ambiguous
 *      evidence: the resolver MUST NOT merge them (it mints/links on its own, never folds people).
 *   4. Two STRONG ids still merge as before — medium ids never expand NOR block the strong merge set.
 */
import { describe, it, expect } from 'vitest';
import {
  IdentityResolver,
  type ExtractedIdentifier,
  type ExistingLink,
  type BrandPhoneGuardConfig,
} from '../domain/identity/IdentityResolver.js';

const BRAND = '11111111-1111-1111-1111-111111111111';
const BRAIN_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const BRAIN_B = 'bbbbbbbb-0000-0000-0000-000000000002';

const cfg: BrandPhoneGuardConfig = { phone_guard_threshold: 10, suppression_window_days: 30 };

function link(brainId: string, type: string, hash: string, tier = 'strong'): ExistingLink {
  return { brain_id: brainId, identifier_type: type, identifier_value: hash, is_active: true, tier } as ExistingLink;
}

function id(type: ExtractedIdentifier['type'], hash: string, tier: ExtractedIdentifier['tier']): ExtractedIdentifier {
  return { type, hash, tier, confidence: tier === 'medium' ? 'low' : 'high' };
}

const r = new IdentityResolver();

describe('C2 medium-tier (device_id / anon_id) — resolve-only, never-merge', () => {
  it('adopts an existing brain_id via an anon_id match (LINK, not mint)', () => {
    const existing = [link(BRAIN_A, 'anon_id', 'anonhash1', 'medium')];
    const out = r.resolve(BRAND, [id('anon_id', 'anonhash1', 'medium')], existing, new Map(), new Map(), cfg, new Set());
    expect(out.action).toBe('linked');
    expect(out.brainId).toBe(BRAIN_A);
  });

  it('mints when a medium id is brand-new (its link persists for future adoption)', () => {
    const out = r.resolve(BRAND, [id('device_id', 'devhashNew', 'medium')], [], new Map(), new Map(), cfg, new Set());
    expect(out.action).toBe('minted');
    // the medium id is carried as a new link so a later strong-id event can adopt this brain_id
    expect(out.newLinks.some((l) => l.type === 'device_id' && l.hash === 'devhashNew')).toBe(true);
  });

  it('NEVER merges two people via a shared anon_id (ambiguous evidence is dropped)', () => {
    // Same anon_id seen on BRAIN_A and BRAIN_B, no strong identifier on this event.
    const existing = [
      link(BRAIN_A, 'anon_id', 'sharedAnon', 'medium'),
      link(BRAIN_B, 'anon_id', 'sharedAnon', 'medium'),
    ];
    const out = r.resolve(BRAND, [id('anon_id', 'sharedAnon', 'medium')], existing, new Map(), new Map(), cfg, new Set());
    // union.size === 2 → medium evidence ignored → it mints/links on its own, it does NOT merge.
    expect(out.action).not.toBe('merged');
  });

  it('a strong id still adopts via a medium id when both point at the same person', () => {
    // Strong email is NEW (no match); medium anon_id matches BRAIN_A → adopt BRAIN_A (single union).
    const existing = [link(BRAIN_A, 'anon_id', 'anonForA', 'medium')];
    const out = r.resolve(
      BRAND,
      [id('email', 'emailNew', 'strong'), id('anon_id', 'anonForA', 'medium')],
      existing, new Map(), new Map(), cfg, new Set(),
    );
    expect(out.action).toBe('linked');
    expect(out.brainId).toBe(BRAIN_A);
  });

  it('two STRONG ids still merge — medium ids neither block nor expand the strong merge set', () => {
    const existing = [
      link(BRAIN_A, 'email', 'emailA', 'strong'),
      link(BRAIN_B, 'phone', 'phoneB', 'strong'),
    ];
    const out = r.resolve(
      BRAND,
      [id('email', 'emailA', 'strong'), id('phone', 'phoneB', 'strong'), id('anon_id', 'irrelevant', 'medium')],
      existing, new Map(), new Map(), cfg, new Set(),
    );
    expect(out.action).toBe('merged');
    // canonical = lowest UUID = BRAIN_A
    expect(out.brainId).toBe(BRAIN_A);
  });
});
