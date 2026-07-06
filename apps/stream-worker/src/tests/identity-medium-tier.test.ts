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

// SPEC: A.2.3.4 (WA-16) — shared-device guard. A shared anon must NOT pull a NEW strong id into a brain
// already owned by a DIFFERENT strong identity (shared_device_family). The guard is active only when the
// caller threads strongOwnedBrainIds (flag identity.shared_device_guard ON); absent ⇒ byte-identical.
describe('A.2.3.4 shared-device guard (strongOwnedBrainIds)', () => {
  // The event: a NEW member email (matches nothing) + the shared anon already linked to BRAIN_A.
  // Per Option-A fetch, existingLinks only exposes the anon→BRAIN_A row; BRAIN_A's own email is NOT here —
  // its strong ownership is conveyed solely via strongOwnedBrainIds.
  const sharedDeviceEvent = () => [
    id('email', 'emailMemberB', 'strong'),
    id('anon_id', 'sharedFamilyAnon', 'medium'),
  ];
  const anonToBrainA: ExistingLink[] = [link(BRAIN_A, 'anon_id', 'sharedFamilyAnon', 'medium')];

  it('GUARD ON + brain strong-owned → MINTS a new brain for the new email; anon stays with its owner', () => {
    const out = r.resolve(
      BRAND, sharedDeviceEvent(), anonToBrainA, new Map(), new Map(), cfg, new Set(),
      undefined, undefined, new Set([BRAIN_A]), // BRAIN_A already owns a strong id (emailMemberA)
    );
    expect(out.action).toBe('minted');
    expect(out.brainId).not.toBe(BRAIN_A);
    // the new member email founds the new person …
    expect(out.newLinks.some((l) => l.type === 'email' && l.hash === 'emailMemberB')).toBe(true);
    // … but the SHARED anon is NOT re-linked onto it (it stays with BRAIN_A) — no merge via the device.
    expect(out.newLinks.some((l) => l.type === 'anon_id' && l.hash === 'sharedFamilyAnon')).toBe(false);
  });

  it('GUARD ON + brain NOT strong-owned (anon_to_known) → still ADOPTS (LINK), journey preserved', () => {
    // Same shape, but BRAIN_A was minted from an anonymous browse (no strong owner) → adoption is correct.
    const out = r.resolve(
      BRAND, sharedDeviceEvent(), anonToBrainA, new Map(), new Map(), cfg, new Set(),
      undefined, undefined, new Set<string>(), // empty ⇒ BRAIN_A owns no strong id yet
    );
    expect(out.action).toBe('linked');
    expect(out.brainId).toBe(BRAIN_A);
  });

  it('GUARD OFF (strongOwnedBrainIds undefined) → byte-identical legacy adoption (LINK to BRAIN_A)', () => {
    const out = r.resolve(
      BRAND, sharedDeviceEvent(), anonToBrainA, new Map(), new Map(), cfg, new Set(),
      // no strongOwnedBrainIds arg → guard inert
    );
    expect(out.action).toBe('linked');
    expect(out.brainId).toBe(BRAIN_A);
  });

  it('GUARD ON but the event strong id MATCHES the brain (multi_device) → adopts, anon linked', () => {
    // emailA already owns BRAIN_A and is present on this event (matched, not new) + a fresh anon → the
    // guard must NOT fire (no unmatched-new strong) → LINK, and the new anon is adopted onto BRAIN_A.
    const out = r.resolve(
      BRAND,
      [id('email', 'emailA', 'strong'), id('anon_id', 'freshAnon', 'medium')],
      [link(BRAIN_A, 'email', 'emailA', 'strong')],
      new Map(), new Map(), cfg, new Set(),
      undefined, undefined, new Set([BRAIN_A]),
    );
    expect(out.action).toBe('linked');
    expect(out.brainId).toBe(BRAIN_A);
    expect(out.newLinks.some((l) => l.type === 'anon_id' && l.hash === 'freshAnon')).toBe(true);
  });
});
