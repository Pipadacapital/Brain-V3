/**
 * SPEC: B.2 (WB-B2, AMD-08, AMD-11) — cross-device journey re-version dirty-set — unit tests.
 *
 * ADR-0015 WS3: the JourneyReversionDirtyConsumer is REMOVED — the Silver identity stage
 * (jobs/silver-identity/side-effects.ts) invokes the SAME pure mapper directly after each resolve
 * outcome (flag-gated `journey.engine`, covered by silver-identity-side-effects.unit.test.ts).
 * These tests keep exercising the PRESERVED pure mapper (JourneyReversionDirty). Verifies:
 *   1. identity.merged   → brain_id dirty keys for BOTH merged brains, cause='merge'.
 *   2. identity.unmerged → brain_id dirty keys for survivor + restored, cause='unmerge'.
 *   3. identity.linked   → brain_id dirty key for the linked brain, cause='restitch' (the A.5.5 late-lift).
 *   4. DIRTY-SET IDEMPOTENCY: same mutation re-delivered → byte-identical entry set (within-event dedupe on
 *      brain_id); a degenerate self-merge collapses to one entry (the PG PK makes the upsert a no-op).
 *   5. VERSION BUMP: nextJourneyVersion / buildJourneyVersionLogEntry bump N → N+1 for a merge (AMD-11 R1).
 *   6. Tenant isolation: every entry carries the event's brand_id FIRST.
 * (The `journey.engine` flag gate + non-trigger skips are covered by the silver-identity
 *  side-effects unit test, where the gating now lives.)
 */
import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  mergedToJourneyDirty,
  unmergedToJourneyDirty,
  linkedToJourneyDirty,
  nextJourneyVersion,
  buildJourneyVersionLogEntry,
} from '../domain/journey/JourneyReversionDirty.js';
import type {
  IdentityMergedEvent,
  IdentityUnmergedEvent,
  IdentityLinkedEvent,
} from '@brain/contracts';

// ── Fixtures ────────────────────────────────────────────────────────────────────

const BRAND_A = randomUUID();
const BRAIN_1 = randomUUID();
const BRAIN_CANON = randomUUID();
const BRAIN_MERGED = randomUUID();
const BRAIN_RESTORED = randomUUID();

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

function linkedEnvelope(brandId = BRAND_A, brainId = BRAIN_1): Record<string, unknown> {
  return {
    schema_version: '1',
    event_id: randomUUID(),
    brand_id: brandId,
    correlation_id: 'test-corr',
    event_name: 'identity.linked',
    occurred_at: occurredAt(),
    payload: {
      brand_id: brandId,
      brain_id: brainId,
      identifier_type: 'email',
      tier: 'strong',
      identifier_hash: 'a'.repeat(64),
      rule_version: 'v1-deterministic',
      verdict: verdict([{ identifier_type: 'email', identifier_hash: 'a'.repeat(64) }]),
    },
  };
}

function mergedEnvelope(
  brandId = BRAND_A,
  canonical = BRAIN_CANON,
  merged = BRAIN_MERGED,
): Record<string, unknown> {
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
      canonical_brain_id: canonical,
      merged_brain_id: merged,
      identifier_combo: ['email'],
      rule_version: 'v1-deterministic',
      verdict: verdict([{ identifier_type: 'email', identifier_hash: 'a'.repeat(64) }]),
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

describe('B2 JourneyReversionDirty mapper — affected-brain extraction + cause', () => {
  it('merged: emits brain_id keys for BOTH merged brains, cause=merge, tenant-first', () => {
    const entries = mergedToJourneyDirty(mergedEnvelope() as unknown as IdentityMergedEvent);
    expect(new Set(entries.map((e) => e.brain_id))).toEqual(new Set([BRAIN_CANON, BRAIN_MERGED]));
    expect(entries.every((e) => e.cause === 'merge')).toBe(true);
    expect(entries.every((e) => e.brand_id === BRAND_A)).toBe(true);
    expect(entries.every((e) => e.trigger_event === 'identity.merged')).toBe(true);
  });

  it('unmerged: brain_id keys for survivor + restored, cause=unmerge', () => {
    const entries = unmergedToJourneyDirty(unmergedEnvelope() as unknown as IdentityUnmergedEvent);
    expect(new Set(entries.map((e) => e.brain_id))).toEqual(new Set([BRAIN_CANON, BRAIN_RESTORED]));
    expect(entries.every((e) => e.cause === 'unmerge')).toBe(true);
  });

  it('linked: single brain_id key, cause=restitch (the A.5.5 late-identify journey lift)', () => {
    const entries = linkedToJourneyDirty(linkedEnvelope() as unknown as IdentityLinkedEvent);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.brain_id).toBe(BRAIN_1);
    expect(entries[0]!.cause).toBe('restitch');
  });

  it('IDEMPOTENCY: a degenerate self-merge (canonical==merged) collapses to ONE entry; replay is byte-identical', () => {
    const env = mergedEnvelope(BRAND_A, BRAIN_CANON, BRAIN_CANON) as unknown as IdentityMergedEvent;
    const a = mergedToJourneyDirty(env);
    const b = mergedToJourneyDirty(env);
    expect(a).toEqual(b);                 // deterministic → replay-stable
    expect(a).toHaveLength(1);            // collapsed on brain_id
  });

  it('entries carry only the brain-grain audit shape (no PII, no money)', () => {
    const entries = mergedToJourneyDirty(mergedEnvelope() as unknown as IdentityMergedEvent);
    for (const e of entries) {
      expect(Object.keys(e).sort()).toEqual(
        ['brain_id', 'brand_id', 'cause', 'source_event_id', 'trigger_event'].sort(),
      );
    }
  });
});

// ── Version-bump tests (AMD-11 R1) ────────────────────────────────────────────

describe('B2 journey version bump — N -> N+1 (AMD-11)', () => {
  it('nextJourneyVersion bumps by exactly one', () => {
    expect(nextJourneyVersion(0)).toBe(1);
    expect(nextJourneyVersion(6)).toBe(7);
  });

  it('buildJourneyVersionLogEntry on a MERGE records from_version N and to_version N+1', () => {
    const at = occurredAt();
    const entry = buildJourneyVersionLogEntry(BRAND_A, BRAIN_CANON, 6, 'merge', at);
    expect(entry).toEqual({
      brand_id: BRAND_A,
      brain_id: BRAIN_CANON,
      from_version: 6,
      to_version: 7,
      cause: 'merge',
      at,
    });
  });

  it('rejects a negative / non-integer version (a version is a monotone counter)', () => {
    expect(() => nextJourneyVersion(-1)).toThrow(RangeError);
    expect(() => nextJourneyVersion(1.5)).toThrow(RangeError);
  });
});
