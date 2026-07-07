/**
 * SPEC: B.2 (WB-B2, AMD-08, AMD-11) — event-driven cross-device journey re-version dirty-set — unit tests.
 *
 * Exercises the PURE mapper (JourneyReversionDirty) + the JourneyReversionDirtyConsumer.processMessage()
 * with fake infrastructure (no Kafka broker, no PG, no Redis). Verifies:
 *   1. identity.merged   → brain_id dirty keys for BOTH merged brains, cause='merge'.
 *   2. identity.unmerged → brain_id dirty keys for survivor + restored, cause='unmerge'.
 *   3. identity.linked   → brain_id dirty key for the linked brain, cause='restitch' (the A.5.5 late-lift).
 *   4. DIRTY-SET IDEMPOTENCY: same mutation re-delivered → byte-identical entry set (within-event dedupe on
 *      brain_id); a degenerate self-merge collapses to one entry (the PG PK makes the upsert a no-op).
 *   5. VERSION BUMP: nextJourneyVersion / buildJourneyVersionLogEntry bump N → N+1 for a merge (AMD-11 R1).
 *   6. FLAG GATE (default-OFF): journey.engine OFF → skipped, repository NEVER written (byte-identical).
 *   7. Non-trigger events (minted / suppressed / review_queued) → skipped. Invalid JSON → invalid (→ DLQ).
 *   8. Tenant isolation: every entry carries the event's brand_id FIRST.
 */
import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import type { Kafka } from 'kafkajs';
import {
  JourneyReversionDirtyConsumer,
  type IJourneyReversionDirtyRepository,
  type IJourneyFlagGate,
} from '../interfaces/consumers/JourneyReversionDirtyConsumer.js';
import {
  mergedToJourneyDirty,
  unmergedToJourneyDirty,
  linkedToJourneyDirty,
  nextJourneyVersion,
  buildJourneyVersionLogEntry,
  type JourneyDirtyEntry,
} from '../domain/journey/JourneyReversionDirty.js';
import type {
  IdentityMergedEvent,
  IdentityUnmergedEvent,
  IdentityLinkedEvent,
} from '@brain/contracts';

// ── Fixtures ────────────────────────────────────────────────────────────────────

const BRAND_A = randomUUID();
const BRAND_B = randomUUID();
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

const buf = (o: unknown): Buffer => Buffer.from(JSON.stringify(o), 'utf8');

// ── Fake infrastructure ───────────────────────────────────────────────────────

function fakeRepo(): IJourneyReversionDirtyRepository & { batches: JourneyDirtyEntry[][] } {
  const batches: JourneyDirtyEntry[][] = [];
  return { batches, async markDirty(entries) { batches.push(entries); } };
}

function fakeFlags(on: boolean): IJourneyFlagGate {
  return { async isFlagEnabled() { return on; } };
}

const fakeKafka = {
  consumer: () => ({
    connect: async () => {}, subscribe: async () => {}, run: async () => {},
    stop: async () => {}, disconnect: async () => {}, commitOffsets: async () => {},
  }),
  producer: () => ({ connect: async () => {}, send: async () => [], disconnect: async () => {} }),
} as unknown as Kafka;

const fakeRetryCounter = { async increment() { return 1; }, async reset() {} };

function buildConsumer(
  repo: IJourneyReversionDirtyRepository,
  flags: IJourneyFlagGate,
): JourneyReversionDirtyConsumer {
  return new JourneyReversionDirtyConsumer(
    fakeKafka, repo, flags, ['dev.identity.merged.v1'], 'test-journey-reversion-group', fakeRetryCounter,
  );
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

// ── Consumer tests ──────────────────────────────────────────────────────────────

describe('B2 JourneyReversionDirtyConsumer.processMessage — flag gate + dirty write', () => {
  it('flag ON + merged → marked; repository receives BOTH brain dirty keys', async () => {
    const repo = fakeRepo();
    const out = await buildConsumer(repo, fakeFlags(true)).processMessage(buf(mergedEnvelope()));
    expect(out.outcome).toBe('marked');
    expect(repo.batches).toHaveLength(1);
    expect(new Set(repo.batches[0]!.map((e) => e.brain_id))).toEqual(new Set([BRAIN_CANON, BRAIN_MERGED]));
    expect(repo.batches[0]!.every((e) => e.cause === 'merge')).toBe(true);
  });

  it('flag OFF → skipped, repository NEVER written (default-OFF, bounded, byte-identical golden)', async () => {
    const repo = fakeRepo();
    const out = await buildConsumer(repo, fakeFlags(false)).processMessage(buf(mergedEnvelope()));
    expect(out).toMatchObject({ outcome: 'skipped', reason: 'journey_engine_off' });
    expect(repo.batches).toHaveLength(0);
  });

  it('DIRTY-SET IDEMPOTENCY: same event re-delivered → identical dirty batch both times', async () => {
    const repo = fakeRepo();
    const consumer = buildConsumer(repo, fakeFlags(true));
    const env = mergedEnvelope();
    await consumer.processMessage(buf(env));
    await consumer.processMessage(buf(env));
    expect(repo.batches).toHaveLength(2);
    expect(repo.batches[0]).toEqual(repo.batches[1]); // same source_event_id + brains → PK no-op upsert
  });

  it('linked → marked with a single restitch-cause brain key', async () => {
    const repo = fakeRepo();
    const out = await buildConsumer(repo, fakeFlags(true)).processMessage(buf(linkedEnvelope()));
    expect(out.outcome).toBe('marked');
    expect(repo.batches[0]!).toHaveLength(1);
    expect(repo.batches[0]![0]!.cause).toBe('restitch');
  });

  it('unmerged → marked with brain keys, cause=unmerge', async () => {
    const repo = fakeRepo();
    const out = await buildConsumer(repo, fakeFlags(true)).processMessage(buf(unmergedEnvelope()));
    expect(out.outcome).toBe('marked');
    expect(repo.batches[0]!.every((e) => e.cause === 'unmerge')).toBe(true);
  });

  it('minted (brand-new brain — no journey to re-version) → skipped, no write', async () => {
    const repo = fakeRepo();
    const env = {
      schema_version: '1', event_id: randomUUID(), brand_id: BRAND_A, correlation_id: 'c',
      event_name: 'identity.minted', occurred_at: occurredAt(),
      payload: {
        brand_id: BRAND_A, brain_id: BRAIN_1, anonymous_id: 'x'.repeat(64),
        identifier_type: 'email', tier: 'strong', identifier_hash: 'a'.repeat(64),
        rule_version: 'v1-deterministic',
        verdict: verdict([{ identifier_type: 'email', identifier_hash: 'a'.repeat(64) }]),
      },
    };
    const out = await buildConsumer(repo, fakeFlags(true)).processMessage(buf(env));
    expect(out).toMatchObject({ outcome: 'skipped', reason: 'not_a_reversion_trigger' });
    expect(repo.batches).toHaveLength(0);
  });

  it('suppressed (not a re-version trigger) → skipped, no write', async () => {
    const repo = fakeRepo();
    const env = {
      schema_version: '1', event_id: randomUUID(), brand_id: BRAND_A, correlation_id: 'c',
      event_name: 'identity.suppressed', occurred_at: occurredAt(),
      payload: { brand_id: BRAND_A, brain_id: BRAIN_1, reason: 'consent_withdrawn' },
    };
    const out = await buildConsumer(repo, fakeFlags(true)).processMessage(buf(env));
    expect(out).toMatchObject({ outcome: 'skipped', reason: 'not_a_reversion_trigger' });
    expect(repo.batches).toHaveLength(0);
  });

  it('invalid JSON → invalid (→ DLQ path); null/empty → invalid', async () => {
    const c = buildConsumer(fakeRepo(), fakeFlags(true));
    expect((await c.processMessage(Buffer.from('{not json', 'utf8'))).outcome).toBe('invalid');
    expect((await c.processMessage(null)).outcome).toBe('invalid');
    expect((await c.processMessage(Buffer.alloc(0))).outcome).toBe('invalid');
  });

  it('tenant isolation: entries carry the EVENT brand_id (brand_B), never a mixed brand', async () => {
    const repo = fakeRepo();
    await buildConsumer(repo, fakeFlags(true)).processMessage(
      buf(mergedEnvelope(BRAND_B, BRAIN_CANON, BRAIN_MERGED)),
    );
    expect(repo.batches[0]!.every((e) => e.brand_id === BRAND_B)).toBe(true);
    expect(repo.batches[0]!.some((e) => e.brand_id === BRAND_A)).toBe(false);
  });
});
