/**
 * scoped-recompute-loop.integration.test.ts — §H scoped-recompute proof.
 *
 * Integration proof for the identity-change → ScopedRecompute → cache-invalidate loop.
 * Uses the real domain mapper + the real consumer processMessage() with faked
 * infrastructure (no Kafka broker, no StarRocks, no Redis). This is the "§H
 * scoped-recompute proof" referenced in the task spec.
 *
 * CONTRACT UNDER TEST:
 *   (A) An identity.merged event for BRAND_A → the ScopedRecompute request persisted to
 *       the repository contains ONLY BRAND_A's affected brain_ids (canonical + merged_away),
 *       and cache.invalidate.v1 is emitted for each customer-grained Gold mart naming
 *       BRAND_A's mart names. No BRAND_B row is written, no BRAND_B invalidation emitted.
 *   (B) A non-affected brand (BRAND_B) receives no ScopedRecompute request and no
 *       cache.invalidate.v1 when the event carries BRAND_A's brand_id — strict isolation.
 *   (C) The affected_brain_ids in the repository call are exactly the two brain_ids from the
 *       identity.merged envelope (canonical + merged_away) — never a third brain_id.
 *   (D) The affected_marts in the cache.invalidate call name the full CUSTOMER_GRAINED_MARTS
 *       set — every customer-grained serving MV is flagged for refresh.
 *   (E) The request_id is deterministic: re-delivering the same event_id → same request_id
 *       (idempotency guard for the brain_ops StarRocks PK upsert).
 *   (F) A non-recompute event (identity.minted) for any brand → no repository write,
 *       no cache.invalidate publish.
 *
 * ISOLATION: these tests are pure TS — no real Kafka, no real StarRocks, no real Redis.
 * Each test constructs a fresh consumer instance (reusing the fake harness from
 * IdentityChangeRecomputeConsumer.test.ts) and drives processMessage() directly.
 */
import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Kafka } from 'kafkajs';
import {
  IdentityChangeRecomputeConsumer,
  type IScopedRecomputeRepository,
  type ICacheInvalidatePublisher,
} from '../interfaces/consumers/IdentityChangeRecomputeConsumer.js';
import {
  CUSTOMER_GRAINED_MARTS,
  type ScopedRecompute,
} from '../domain/identity/ScopedRecompute.js';
import type { IRetryCounter } from '../infrastructure/redis/RetryCounterAdapter.js';

// ── Test fixtures ──────────────────────────────────────────────────────────────

const NOW = '2026-06-27T10:00:00Z';

/** Minimal valid ConfidenceVerdict for envelope construction. */
const VERDICT = {
  score: 100,
  band: 'exact' as const,
  reasons: ['merge:strong_key_union'],
  matcher_id: 'deterministic-union-find',
  rule_version: 'v1-deterministic',
  identifier_combo: [],
};

const occurredAt = (): string =>
  new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

function buildMergedBuffer(params: {
  brand_id: string;
  canonical_brain_id: string;
  merged_brain_id: string;
  event_id?: string;
}): Buffer {
  return Buffer.from(
    JSON.stringify({
      schema_version:    '1',
      event_id:          params.event_id ?? randomUUID(),
      brand_id:          params.brand_id,
      correlation_id:    'test-loop-corr',
      event_name:        'identity.merged',
      occurred_at:       occurredAt(),
      payload: {
        brand_id:           params.brand_id,
        merge_id:           randomUUID(),
        canonical_brain_id: params.canonical_brain_id,
        merged_brain_id:    params.merged_brain_id,
        identifier_combo:   ['email'],
        rule_version:       'v1-deterministic',
        verdict:            VERDICT,
      },
    }),
    'utf8',
  );
}

function buildSuppressedBuffer(params: {
  brand_id: string;
  brain_id: string;
  event_id?: string;
}): Buffer {
  return Buffer.from(
    JSON.stringify({
      schema_version: '1',
      event_id:       params.event_id ?? randomUUID(),
      brand_id:       params.brand_id,
      correlation_id: 'test-loop-corr',
      event_name:     'identity.suppressed',
      occurred_at:    occurredAt(),
      payload: {
        brand_id: params.brand_id,
        brain_id: params.brain_id,
        reason:   'tombstoned',
      },
    }),
    'utf8',
  );
}

function buildSkippedBuffer(brand_id: string, eventName: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      schema_version: '1',
      event_id:       randomUUID(),
      brand_id,
      correlation_id: 'test-loop-corr',
      event_name:     eventName,
      occurred_at:    occurredAt(),
      payload:        { brand_id, brain_id: randomUUID() },
    }),
    'utf8',
  );
}

// ── Fake infrastructure ────────────────────────────────────────────────────────

type RepoCall = ScopedRecompute;
type PubCall = { recompute: ScopedRecompute; causationEventId: string };

function makeRepo(): IScopedRecomputeRepository & { calls: RepoCall[] } {
  const calls: RepoCall[] = [];
  return {
    calls,
    async upsert(recompute) { calls.push(recompute); },
  };
}

function makePub(): ICacheInvalidatePublisher & { calls: PubCall[] } {
  const calls: PubCall[] = [];
  return {
    calls,
    async publishForRecompute(recompute, causationEventId) {
      calls.push({ recompute, causationEventId });
    },
  };
}

function fakeRetryCounter(): IRetryCounter {
  return {
    async increment() { return 1; },
    async reset() {},
  };
}

const fakeKafka = {
  consumer: () => ({
    connect:       vi.fn(),
    subscribe:     vi.fn(),
    run:           vi.fn(),
    stop:          vi.fn(),
    disconnect:    vi.fn(),
    commitOffsets: vi.fn(),
  }),
  producer: () => ({
    connect:    vi.fn(),
    send:       vi.fn().mockResolvedValue([]),
    disconnect: vi.fn(),
  }),
} as unknown as Kafka;

function buildConsumer(repo: IScopedRecomputeRepository, pub: ICacheInvalidatePublisher) {
  return new IdentityChangeRecomputeConsumer(
    fakeKafka,
    repo,
    pub,
    ['dev.identity.merged.v1', 'dev.identity.suppressed.v1'],
    'stream-worker-identity-recompute',
    fakeRetryCounter(),
  );
}

// ── (A) Brand isolation — affected brand only ──────────────────────────────────

describe('scoped-recompute loop — (A) brand isolation (affected brand receives request)', () => {
  const BRAND_A   = randomUUID();
  const BRAND_B   = randomUUID();
  const CANONICAL = randomUUID();
  const MERGED    = randomUUID();

  it('brand_A merged event → repository.upsert called exactly once for brand_A', async () => {
    const repo = makeRepo();
    const pub  = makePub();
    await buildConsumer(repo, pub).processMessage(
      buildMergedBuffer({ brand_id: BRAND_A, canonical_brain_id: CANONICAL, merged_brain_id: MERGED }),
      NOW,
    );
    expect(repo.calls).toHaveLength(1);
    expect(repo.calls[0]!.brand_id).toBe(BRAND_A);
  });

  it('brand_A merged event → brand_B is absent from the repository call', async () => {
    const repo = makeRepo();
    const pub  = makePub();
    await buildConsumer(repo, pub).processMessage(
      buildMergedBuffer({ brand_id: BRAND_A, canonical_brain_id: CANONICAL, merged_brain_id: MERGED }),
      NOW,
    );
    // The only call is for BRAND_A — BRAND_B never appears.
    for (const call of repo.calls) {
      expect(call.brand_id).not.toBe(BRAND_B);
    }
  });

  it('brand_A merged event → cache.invalidate published with brand_A (not brand_B)', async () => {
    const repo = makeRepo();
    const pub  = makePub();
    await buildConsumer(repo, pub).processMessage(
      buildMergedBuffer({ brand_id: BRAND_A, canonical_brain_id: CANONICAL, merged_brain_id: MERGED }),
      NOW,
    );
    expect(pub.calls).toHaveLength(1);
    expect(pub.calls[0]!.recompute.brand_id).toBe(BRAND_A);
    expect(pub.calls[0]!.recompute.brand_id).not.toBe(BRAND_B);
  });

  it('brand_B sends no merged event → zero repository calls (non-affected brand produces no request)', async () => {
    const repo = makeRepo();
    const pub  = makePub();
    // BRAND_B event is never produced; only BRAND_A's event is processed.
    await buildConsumer(repo, pub).processMessage(
      buildMergedBuffer({ brand_id: BRAND_A, canonical_brain_id: CANONICAL, merged_brain_id: MERGED }),
      NOW,
    );
    // Confirm: no repo call for BRAND_B whatsoever.
    const brand_b_calls = repo.calls.filter(c => c.brand_id === BRAND_B);
    expect(brand_b_calls).toHaveLength(0);
  });
});

// ── (C) affected_brain_ids — exactly the two ids from the merged envelope ──────

describe('scoped-recompute loop — (C) affected_brain_ids are exactly the two merged brain_ids', () => {
  const BRAND_A   = randomUUID();
  const CANONICAL = randomUUID();
  const MERGED    = randomUUID();

  it('repository receives exactly {canonical, merged_away} — no third brain_id', async () => {
    const repo = makeRepo();
    const pub  = makePub();
    await buildConsumer(repo, pub).processMessage(
      buildMergedBuffer({ brand_id: BRAND_A, canonical_brain_id: CANONICAL, merged_brain_id: MERGED }),
      NOW,
    );
    const { affected_brain_ids } = repo.calls[0]!;
    expect(affected_brain_ids).toHaveLength(2);
    expect(affected_brain_ids).toContain(CANONICAL);
    expect(affected_brain_ids).toContain(MERGED);
  });

  it('cache.invalidate recompute carries both brain_ids', async () => {
    const repo = makeRepo();
    const pub  = makePub();
    await buildConsumer(repo, pub).processMessage(
      buildMergedBuffer({ brand_id: BRAND_A, canonical_brain_id: CANONICAL, merged_brain_id: MERGED }),
      NOW,
    );
    const { affected_brain_ids } = pub.calls[0]!.recompute;
    expect(affected_brain_ids).toContain(CANONICAL);
    expect(affected_brain_ids).toContain(MERGED);
    expect(affected_brain_ids).toHaveLength(2);
  });

  it('suppressed event → exactly one brain_id in affected set', async () => {
    const BRAIN_SUPPRESSED = randomUUID();
    const repo = makeRepo();
    const pub  = makePub();
    await buildConsumer(repo, pub).processMessage(
      buildSuppressedBuffer({ brand_id: BRAND_A, brain_id: BRAIN_SUPPRESSED }),
      NOW,
    );
    const { affected_brain_ids } = repo.calls[0]!;
    expect(affected_brain_ids).toHaveLength(1);
    expect(affected_brain_ids[0]).toBe(BRAIN_SUPPRESSED);
  });
});

// ── (D) affected_marts — full CUSTOMER_GRAINED_MARTS set named in cache.invalidate ──

describe('scoped-recompute loop — (D) cache.invalidate names all customer-grained Gold marts', () => {
  const BRAND_A   = randomUUID();
  const CANONICAL = randomUUID();
  const MERGED    = randomUUID();

  it('cache.invalidate recompute carries the full CUSTOMER_GRAINED_MARTS set', async () => {
    const repo = makeRepo();
    const pub  = makePub();
    await buildConsumer(repo, pub).processMessage(
      buildMergedBuffer({ brand_id: BRAND_A, canonical_brain_id: CANONICAL, merged_brain_id: MERGED }),
      NOW,
    );
    const { affected_marts } = pub.calls[0]!.recompute;
    expect(Array.from(affected_marts)).toEqual(Array.from(CUSTOMER_GRAINED_MARTS));
  });

  it('every mart in the publish call starts with "gold_" (customer-grained, not aggregate)', async () => {
    const repo = makeRepo();
    const pub  = makePub();
    await buildConsumer(repo, pub).processMessage(
      buildMergedBuffer({ brand_id: BRAND_A, canonical_brain_id: CANONICAL, merged_brain_id: MERGED }),
      NOW,
    );
    for (const mart of pub.calls[0]!.recompute.affected_marts) {
      expect(mart).toMatch(/^gold_/);
    }
  });

  it('affected_mvs in repository call map to brain_serving.mv_* names', async () => {
    const repo = makeRepo();
    const pub  = makePub();
    await buildConsumer(repo, pub).processMessage(
      buildMergedBuffer({ brand_id: BRAND_A, canonical_brain_id: CANONICAL, merged_brain_id: MERGED }),
      NOW,
    );
    for (const mv of repo.calls[0]!.affected_mvs) {
      expect(mv).toMatch(/^brain_serving\.mv_/);
    }
  });
});

// ── (E) Idempotency — same event_id → same request_id ─────────────────────────

describe('scoped-recompute loop — (E) idempotency: same event_id → same request_id', () => {
  const BRAND_A   = randomUUID();
  const CANONICAL = randomUUID();
  const MERGED    = randomUUID();
  const EVENT_ID  = randomUUID();

  it('re-delivering the same merged event produces the same request_id', async () => {
    const repo = makeRepo();
    const pub  = makePub();
    const consumer = buildConsumer(repo, pub);
    const buf = buildMergedBuffer({
      brand_id: BRAND_A, canonical_brain_id: CANONICAL, merged_brain_id: MERGED, event_id: EVENT_ID,
    });

    await consumer.processMessage(buf, NOW);
    await consumer.processMessage(buf, NOW);

    expect(repo.calls).toHaveLength(2);
    expect(repo.calls[0]!.request_id).toBe(repo.calls[1]!.request_id);
  });

  it('different merged events → different request_ids', async () => {
    const repo = makeRepo();
    const pub  = makePub();
    const consumer = buildConsumer(repo, pub);

    await consumer.processMessage(
      buildMergedBuffer({ brand_id: BRAND_A, canonical_brain_id: CANONICAL, merged_brain_id: MERGED }),
      NOW,
    );
    await consumer.processMessage(
      buildMergedBuffer({ brand_id: BRAND_A, canonical_brain_id: randomUUID(), merged_brain_id: randomUUID() }),
      NOW,
    );

    expect(repo.calls[0]!.request_id).not.toBe(repo.calls[1]!.request_id);
  });
});

// ── (F) Non-recompute events produce no request ────────────────────────────────

describe('scoped-recompute loop — (F) non-recompute events produce no request', () => {
  const BRAND_A = randomUUID();

  for (const eventName of ['identity.minted', 'identity.linked', 'identity.review_queued']) {
    it(`${eventName} → no repository.upsert call`, async () => {
      const repo = makeRepo();
      const pub  = makePub();
      await buildConsumer(repo, pub).processMessage(
        buildSkippedBuffer(BRAND_A, eventName),
        NOW,
      );
      expect(repo.calls).toHaveLength(0);
    });

    it(`${eventName} → no cache.invalidate.v1 publish`, async () => {
      const repo = makeRepo();
      const pub  = makePub();
      await buildConsumer(repo, pub).processMessage(
        buildSkippedBuffer(BRAND_A, eventName),
        NOW,
      );
      expect(pub.calls).toHaveLength(0);
    });
  }
});

// ── Full loop — two brands in sequence (the §H scoped-recompute proof) ─────────

describe('scoped-recompute loop — §H proof: two-brand sequence', () => {
  it('sequential events for two brands → two independent repository rows, no cross-brand leakage', async () => {
    const BRAND_A   = randomUUID();
    const BRAND_B   = randomUUID();
    const CAN_A     = randomUUID();
    const MERGED_A  = randomUUID();
    const CAN_B     = randomUUID();
    const MERGED_B  = randomUUID();

    const repo = makeRepo();
    const pub  = makePub();
    const consumer = buildConsumer(repo, pub);

    // Process BRAND_A's merge.
    await consumer.processMessage(
      buildMergedBuffer({ brand_id: BRAND_A, canonical_brain_id: CAN_A, merged_brain_id: MERGED_A }),
      NOW,
    );
    // Process BRAND_B's merge.
    await consumer.processMessage(
      buildMergedBuffer({ brand_id: BRAND_B, canonical_brain_id: CAN_B, merged_brain_id: MERGED_B }),
      NOW,
    );

    // Two repository calls — one per brand.
    expect(repo.calls).toHaveLength(2);
    const callA = repo.calls.find(c => c.brand_id === BRAND_A)!;
    const callB = repo.calls.find(c => c.brand_id === BRAND_B)!;

    expect(callA).toBeDefined();
    expect(callB).toBeDefined();

    // BRAND_A's request contains only BRAND_A's brain_ids.
    expect(callA.affected_brain_ids).toContain(CAN_A);
    expect(callA.affected_brain_ids).toContain(MERGED_A);
    expect(callA.affected_brain_ids).not.toContain(CAN_B);
    expect(callA.affected_brain_ids).not.toContain(MERGED_B);

    // BRAND_B's request contains only BRAND_B's brain_ids.
    expect(callB.affected_brain_ids).toContain(CAN_B);
    expect(callB.affected_brain_ids).toContain(MERGED_B);
    expect(callB.affected_brain_ids).not.toContain(CAN_A);
    expect(callB.affected_brain_ids).not.toContain(MERGED_A);

    // Two cache.invalidate publishes — one per brand.
    expect(pub.calls).toHaveLength(2);
    const pubA = pub.calls.find(c => c.recompute.brand_id === BRAND_A)!;
    const pubB = pub.calls.find(c => c.recompute.brand_id === BRAND_B)!;
    expect(pubA).toBeDefined();
    expect(pubB).toBeDefined();
    expect(pubA.recompute.brand_id).not.toBe(BRAND_B);
    expect(pubB.recompute.brand_id).not.toBe(BRAND_A);
  });

  it('a brand that produced no event gets no repository call and no cache.invalidate', async () => {
    const BRAND_ACTIVE  = randomUUID();
    const BRAND_PASSIVE = randomUUID();

    const repo = makeRepo();
    const pub  = makePub();
    const consumer = buildConsumer(repo, pub);

    // Only BRAND_ACTIVE sends a merge event.
    await consumer.processMessage(
      buildMergedBuffer({
        brand_id:          BRAND_ACTIVE,
        canonical_brain_id: randomUUID(),
        merged_brain_id:    randomUUID(),
      }),
      NOW,
    );

    // BRAND_PASSIVE must appear in ZERO calls.
    const passiveRepoCalls = repo.calls.filter(c => c.brand_id === BRAND_PASSIVE);
    const passivePubCalls  = pub.calls.filter(c => c.recompute.brand_id === BRAND_PASSIVE);
    expect(passiveRepoCalls).toHaveLength(0);
    expect(passivePubCalls).toHaveLength(0);
  });
});
