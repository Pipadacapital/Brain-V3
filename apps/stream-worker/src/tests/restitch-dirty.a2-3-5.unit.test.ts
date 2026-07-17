/**
 * SPEC: A.2.3.5 (WA-18, AMD-08) — re-stitch dirty-set — unit tests.
 *
 * ADR-0015 WS3: the RestitchDirtyConsumer is REMOVED — the Silver identity stage
 * (jobs/silver-identity/side-effects.ts) invokes the SAME pure mapper directly after each resolve
 * outcome (flag-gated `stitch.v2`, covered by silver-identity-side-effects.unit.test.ts). These
 * tests keep exercising the PRESERVED pure mapper (RestitchDirty). Verifies:
 *   1. identity.linked → identifier_hash dirty keys for the WHOLE affected set (anchor + verdict combo) —
 *      critically the ANON hash, which is what lifts an A.5.5 late-identify persona's day-1..6 sessions.
 *   2. identity.minted → same full-hash extraction.
 *   3. identity.merged → verdict-combo identifier_hash keys + brain_id keys for both merged brains.
 *   4. identity.unmerged → brain_id keys for survivor + restored (no identifier hashes exist).
 *   5. DIRTY-SET IDEMPOTENCY: same mutation re-delivered → byte-identical entry set (within-event dedupe);
 *      and duplicated identifiers within one event collapse to one entry (the PG PK makes the upsert a
 *      no-op on replay).
 *   6. LOOKBACK WINDOWING is DRAIN-SIDE: the mapper emits timeless keys (no time field) — the
 *      attribution-lookback window is applied by the Spark drain, never here.
 *   7. Tenant isolation: every entry carries the event's brand_id FIRST.
 * (The `stitch.v2` flag gate + non-trigger skips are covered by the silver-identity side-effects
 *  unit test, where the gating now lives.)
 */
import { createHash, randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  mintedToDirty,
  linkedToDirty,
  mergedToDirty,
  unmergedToDirty,
} from '../domain/identity/RestitchDirty.js';
import type {
  IdentityMintedEvent,
  IdentityLinkedEvent,
  IdentityMergedEvent,
  IdentityUnmergedEvent,
} from '@brain/contracts';

// ── Fixtures ────────────────────────────────────────────────────────────────────

const BRAND_A = randomUUID();
const BRAIN_1 = randomUUID();
const BRAIN_CANON = randomUUID();
const BRAIN_MERGED = randomUUID();
const BRAIN_RESTORED = randomUUID();

/** A 64-hex identifier hash (the salted/plain identifier space). */
const h = (seed: string): string => createHash('sha256').update(seed).digest('hex');
const ANON_HASH = h('anon:device-1');
const EMAIL_HASH = h('email:jane@example.com');
const PHONE_HASH = h('phone:+919999999999');

const occurredAt = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

function verdict(combo: Array<{ identifier_type: string; identifier_hash: string }>) {
  return {
    score: 100,
    band: 'exact' as const,
    reasons: ['test'],
    matcher_id: 'deterministic-union-find',
    rule_version: 'v1-deterministic',
    identifier_combo: combo,
  };
}

function mintedEnvelope(brandId = BRAND_A): Record<string, unknown> {
  return {
    schema_version: '1',
    event_id: randomUUID(),
    brand_id: brandId,
    correlation_id: 'test-corr',
    event_name: 'identity.minted',
    occurred_at: occurredAt(),
    payload: {
      brand_id: brandId,
      brain_id: BRAIN_1,
      anonymous_id: ANON_HASH,
      identifier_type: 'email',
      tier: 'strong',
      identifier_hash: EMAIL_HASH, // anchor = strongest identifier
      rule_version: 'v1-deterministic',
      // the FULL affected set — anon (weak) + email (strong) — rides the verdict combo:
      verdict: verdict([
        { identifier_type: 'anon_id', identifier_hash: ANON_HASH },
        { identifier_type: 'email', identifier_hash: EMAIL_HASH },
      ]),
    },
  };
}

function linkedEnvelope(brandId = BRAND_A): Record<string, unknown> {
  return {
    schema_version: '1',
    event_id: randomUUID(),
    brand_id: brandId,
    correlation_id: 'test-corr',
    event_name: 'identity.linked',
    occurred_at: occurredAt(),
    payload: {
      brand_id: brandId,
      brain_id: BRAIN_1,
      identifier_type: 'email',
      tier: 'strong',
      identifier_hash: EMAIL_HASH,
      rule_version: 'v1-deterministic',
      verdict: verdict([
        { identifier_type: 'anon_id', identifier_hash: ANON_HASH },
        { identifier_type: 'email', identifier_hash: EMAIL_HASH },
      ]),
    },
  };
}

function mergedEnvelope(brandId = BRAND_A): Record<string, unknown> {
  return {
    schema_version: '1',
    event_id: randomUUID(),
    brand_id: brandId,
    correlation_id: 'test-corr',
    event_name: 'identity.merged',
    occurred_at: occurredAt(),
    payload: {
      brand_id: brandId,
      merge_id: randomUUID(),
      canonical_brain_id: BRAIN_CANON,
      merged_brain_id: BRAIN_MERGED,
      identifier_combo: ['email'], // wire field is types-only; hashes ride the verdict
      rule_version: 'v1-deterministic',
      verdict: verdict([{ identifier_type: 'email', identifier_hash: EMAIL_HASH }]),
    },
  };
}

function unmergedEnvelope(brandId = BRAND_A): Record<string, unknown> {
  return {
    schema_version: '1',
    event_id: randomUUID(),
    brand_id: brandId,
    correlation_id: 'test-corr',
    event_name: 'identity.unmerged',
    occurred_at: occurredAt(),
    payload: {
      brand_id: brandId,
      merge_id: randomUUID(),
      canonical_brain_id: BRAIN_CANON,
      restored_brain_id: BRAIN_RESTORED,
      rule_version: 'v1-admin-unmerge',
      actor: 'user-123',
    },
  };
}

// ── Pure mapper tests ─────────────────────────────────────────────────────────

describe('A2.3.5 RestitchDirty mapper — affected-key extraction', () => {
  it('linked: emits identifier_hash keys for the WHOLE affected set (anchor + verdict combo incl. anon)', () => {
    const parsed = linkedEnvelope() as unknown as IdentityLinkedEvent;
    const entries = linkedToDirty(parsed);
    const keys = new Set(entries.map((e) => e.dirty_key));
    expect(keys).toEqual(new Set([EMAIL_HASH, ANON_HASH]));
    expect(entries.every((e) => e.dirty_kind === 'identifier_hash')).toBe(true);
    expect(entries.every((e) => e.brand_id === BRAND_A)).toBe(true); // tenant-first
    expect(entries.every((e) => e.trigger_event === 'identity.linked')).toBe(true);
  });

  it('minted: emits the full identifier_hash set (anon lift key present)', () => {
    const entries = mintedToDirty(mintedEnvelope() as unknown as IdentityMintedEvent);
    expect(new Set(entries.map((e) => e.dirty_key))).toEqual(new Set([EMAIL_HASH, ANON_HASH]));
    expect(entries.every((e) => e.dirty_kind === 'identifier_hash')).toBe(true);
  });

  it('merged: verdict identifier_hash keys + brain_id keys for BOTH merged brains', () => {
    const entries = mergedToDirty(mergedEnvelope() as unknown as IdentityMergedEvent);
    const idHashes = entries.filter((e) => e.dirty_kind === 'identifier_hash').map((e) => e.dirty_key);
    const brainIds = entries.filter((e) => e.dirty_kind === 'brain_id').map((e) => e.dirty_key);
    expect(new Set(idHashes)).toEqual(new Set([EMAIL_HASH]));
    expect(new Set(brainIds)).toEqual(new Set([BRAIN_CANON, BRAIN_MERGED]));
  });

  it('unmerged: brain_id keys for survivor + restored (no identifier hashes exist on the wire)', () => {
    const entries = unmergedToDirty(unmergedEnvelope() as unknown as IdentityUnmergedEvent);
    expect(entries.every((e) => e.dirty_kind === 'brain_id')).toBe(true);
    expect(new Set(entries.map((e) => e.dirty_key))).toEqual(new Set([BRAIN_CANON, BRAIN_RESTORED]));
  });

  it('IDEMPOTENCY: duplicate identifiers within one event collapse to ONE entry; replay is byte-identical', () => {
    const env = linkedEnvelope() as unknown as IdentityLinkedEvent;
    // Duplicate the email in the combo — the mapper must dedupe on (kind,key).
    env.payload.verdict.identifier_combo.push({ identifier_type: 'email', identifier_hash: EMAIL_HASH });
    const a = linkedToDirty(env);
    const b = linkedToDirty(env);
    expect(a).toEqual(b); // deterministic → replay-stable
    expect(a.filter((e) => e.dirty_key === EMAIL_HASH)).toHaveLength(1); // collapsed
  });

  it('LOOKBACK WINDOWING is drain-side: entries carry NO time/window field (timeless dirty keys)', () => {
    const entries = linkedToDirty(linkedEnvelope() as unknown as IdentityLinkedEvent);
    for (const e of entries) {
      expect(Object.keys(e).sort()).toEqual(
        ['brand_id', 'dirty_kind', 'dirty_key', 'source_event_id', 'trigger_event'].sort(),
      );
    }
  });
});
