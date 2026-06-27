/**
 * IdentityChangeRecomputeConsumer — unit tests.
 *
 * These tests exercise processMessage() with fake infrastructure (no Kafka broker,
 * no StarRocks, no Redis). They verify:
 *   1. Merged event → recomputed outcome + repository.upsert called + publisher called per mart.
 *   2. Suppressed event → recomputed outcome + single brain_id in recompute.
 *   3. Non-recompute events (minted, linked, review_queued) → skipped + no write + no publish.
 *   4. Invalid JSON → invalid outcome.
 *   5. Idempotency: same merged event re-delivered → same request_id (deterministic).
 *   6. Brand isolation: a merge for brand_A does not call publisher for brand_B.
 *   7. brain_ops write error → processMessage throws (consumer retry path).
 */
import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Kafka } from 'kafkajs';
import {
  IdentityChangeRecomputeConsumer,
  type IScopedRecomputeRepository,
  type ICacheInvalidatePublisher,
  type ProcessOutcome,
} from './IdentityChangeRecomputeConsumer.js';
import { CUSTOMER_GRAINED_MARTS } from '../../domain/identity/ScopedRecompute.js';
import type { IRetryCounter } from '../../infrastructure/redis/RetryCounterAdapter.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

const BRAND_A = randomUUID();
const BRAIN_CANONICAL = randomUUID();
const BRAIN_MERGED_AWAY = randomUUID();
const BRAIN_SUPPRESSED = randomUUID();
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

/** ISO datetime without millis (matches EventEnvelopeBaseSchema.occurred_at). */
const occurredAt = (): string =>
  new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

function buildMergedBuffer(overrides?: {
  event_id?: string;
  brand_id?: string;
  canonical_brain_id?: string;
  merged_brain_id?: string;
}): Buffer {
  return Buffer.from(
    JSON.stringify({
      schema_version: '1',
      event_id:        overrides?.event_id    ?? randomUUID(),
      brand_id:        overrides?.brand_id    ?? BRAND_A,
      correlation_id:  'test-corr',
      event_name:      'identity.merged',
      occurred_at:     occurredAt(),
      payload: {
        brand_id:          overrides?.brand_id    ?? BRAND_A,
        merge_id:          randomUUID(),
        canonical_brain_id: overrides?.canonical_brain_id ?? BRAIN_CANONICAL,
        merged_brain_id:    overrides?.merged_brain_id    ?? BRAIN_MERGED_AWAY,
        identifier_combo:  ['email'],
        rule_version:      'v1-deterministic',
        verdict:           VERDICT,
      },
    }),
    'utf8',
  );
}

function buildSuppressedBuffer(overrides?: {
  event_id?: string;
  brand_id?: string;
  brain_id?: string;
}): Buffer {
  return Buffer.from(
    JSON.stringify({
      schema_version: '1',
      event_id:        overrides?.event_id ?? randomUUID(),
      brand_id:        overrides?.brand_id ?? BRAND_A,
      correlation_id:  'test-corr',
      event_name:      'identity.suppressed',
      occurred_at:     occurredAt(),
      payload: {
        brand_id: overrides?.brand_id ?? BRAND_A,
        brain_id: overrides?.brain_id ?? BRAIN_SUPPRESSED,
        reason:   'tombstoned',
      },
    }),
    'utf8',
  );
}

function buildSkippedBuffer(eventName: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      schema_version: '1',
      event_id:       randomUUID(),
      brand_id:       BRAND_A,
      correlation_id: 'test-corr',
      event_name:     eventName,
      occurred_at:    occurredAt(),
      payload:        { brand_id: BRAND_A, brain_id: randomUUID() },
    }),
    'utf8',
  );
}

// ── Fake infrastructure doubles ───────────────────────────────────────────────

function fakeRepository(): IScopedRecomputeRepository & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    async upsert(recompute) { calls.push(recompute); },
  };
}

function failingRepository(): IScopedRecomputeRepository {
  return {
    async upsert() { throw new Error('StarRocks unavailable'); },
  };
}

function fakePublisher(): ICacheInvalidatePublisher & {
  calls: Array<{ recompute: unknown; causationEventId: string }>;
} {
  const calls: Array<{ recompute: unknown; causationEventId: string }> = [];
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

/** Minimal fake Kafka instance (consumer and publisher are not started in unit tests). */
const fakeKafka = {
  consumer: () => ({
    connect: vi.fn(),
    subscribe: vi.fn(),
    run: vi.fn(),
    stop: vi.fn(),
    disconnect: vi.fn(),
    commitOffsets: vi.fn(),
  }),
  producer: () => ({
    connect: vi.fn(),
    send: vi.fn().mockResolvedValue([]),
    disconnect: vi.fn(),
  }),
} as unknown as Kafka;

function buildConsumer(
  repo: IScopedRecomputeRepository = fakeRepository(),
  pub: ICacheInvalidatePublisher = fakePublisher(),
): IdentityChangeRecomputeConsumer {
  return new IdentityChangeRecomputeConsumer(
    fakeKafka,
    repo,
    pub,
    [`dev.identity.merged.v1`, `dev.identity.suppressed.v1`],
    'stream-worker-identity-recompute',
    fakeRetryCounter(),
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('IdentityChangeRecomputeConsumer.processMessage — identity.merged', () => {
  it('returns recomputed outcome', async () => {
    const result = await buildConsumer().processMessage(buildMergedBuffer(), NOW);
    expect(result.outcome).toBe('recomputed');
  });

  it('calls repository.upsert exactly once', async () => {
    const repo = fakeRepository();
    await buildConsumer(repo).processMessage(buildMergedBuffer(), NOW);
    expect(repo.calls).toHaveLength(1);
  });

  it('calls publisher.publishForRecompute exactly once (all marts in one call)', async () => {
    const pub = fakePublisher();
    await buildConsumer(undefined, pub).processMessage(buildMergedBuffer(), NOW);
    expect(pub.calls).toHaveLength(1);
  });

  it('recompute passed to publisher contains both canonical + merged brain_ids', async () => {
    const pub = fakePublisher();
    await buildConsumer(undefined, pub).processMessage(
      buildMergedBuffer({ canonical_brain_id: BRAIN_CANONICAL, merged_brain_id: BRAIN_MERGED_AWAY }),
      NOW,
    );
    const recompute = pub.calls[0]!.recompute as { affected_brain_ids: string[] };
    expect(recompute.affected_brain_ids).toContain(BRAIN_CANONICAL);
    expect(recompute.affected_brain_ids).toContain(BRAIN_MERGED_AWAY);
    expect(recompute.affected_brain_ids).toHaveLength(2);
  });

  it('recompute contains all CUSTOMER_GRAINED_MARTS', async () => {
    const pub = fakePublisher();
    await buildConsumer(undefined, pub).processMessage(buildMergedBuffer(), NOW);
    const recompute = pub.calls[0]!.recompute as { affected_marts: readonly string[] };
    expect(Array.from(recompute.affected_marts)).toEqual(Array.from(CUSTOMER_GRAINED_MARTS));
  });

  it('outcome.martCount equals CUSTOMER_GRAINED_MARTS.length', async () => {
    const result = await buildConsumer().processMessage(buildMergedBuffer(), NOW) as Extract<ProcessOutcome, { outcome: 'recomputed' }>;
    expect(result.martCount).toBe(CUSTOMER_GRAINED_MARTS.length);
  });

  it('outcome.brandId matches envelope brand_id', async () => {
    const result = await buildConsumer().processMessage(buildMergedBuffer({ brand_id: BRAND_A }), NOW) as Extract<ProcessOutcome, { outcome: 'recomputed' }>;
    expect(result.brandId).toBe(BRAND_A);
  });

  it('outcome.triggerEvent is identity.merged', async () => {
    const result = await buildConsumer().processMessage(buildMergedBuffer(), NOW) as Extract<ProcessOutcome, { outcome: 'recomputed' }>;
    expect(result.triggerEvent).toBe('identity.merged');
  });
});

describe('IdentityChangeRecomputeConsumer.processMessage — identity.suppressed', () => {
  it('returns recomputed outcome', async () => {
    const result = await buildConsumer().processMessage(buildSuppressedBuffer(), NOW);
    expect(result.outcome).toBe('recomputed');
  });

  it('calls repository.upsert exactly once', async () => {
    const repo = fakeRepository();
    await buildConsumer(repo).processMessage(buildSuppressedBuffer(), NOW);
    expect(repo.calls).toHaveLength(1);
  });

  it('recompute contains exactly one brain_id (the suppressed subject)', async () => {
    const pub = fakePublisher();
    await buildConsumer(undefined, pub).processMessage(
      buildSuppressedBuffer({ brain_id: BRAIN_SUPPRESSED }),
      NOW,
    );
    const recompute = pub.calls[0]!.recompute as { affected_brain_ids: string[] };
    expect(recompute.affected_brain_ids).toHaveLength(1);
    expect(recompute.affected_brain_ids[0]).toBe(BRAIN_SUPPRESSED);
  });

  it('outcome.triggerEvent is identity.suppressed', async () => {
    const result = await buildConsumer().processMessage(buildSuppressedBuffer(), NOW) as Extract<ProcessOutcome, { outcome: 'recomputed' }>;
    expect(result.triggerEvent).toBe('identity.suppressed');
  });
});

describe('IdentityChangeRecomputeConsumer.processMessage — non-recompute events (skipped)', () => {
  const nonRecomputeEvents = ['identity.minted', 'identity.linked', 'identity.review_queued'];

  for (const eventName of nonRecomputeEvents) {
    it(`${eventName}: returns skipped outcome`, async () => {
      const result = await buildConsumer().processMessage(buildSkippedBuffer(eventName), NOW);
      expect(result.outcome).toBe('skipped');
    });

    it(`${eventName}: does NOT call repository.upsert`, async () => {
      const repo = fakeRepository();
      await buildConsumer(repo).processMessage(buildSkippedBuffer(eventName), NOW);
      expect(repo.calls).toHaveLength(0);
    });

    it(`${eventName}: does NOT call publisher.publishForRecompute`, async () => {
      const pub = fakePublisher();
      await buildConsumer(undefined, pub).processMessage(buildSkippedBuffer(eventName), NOW);
      expect(pub.calls).toHaveLength(0);
    });
  }
});

describe('IdentityChangeRecomputeConsumer.processMessage — invalid inputs', () => {
  it('null message → invalid outcome', async () => {
    const result = await buildConsumer().processMessage(null, NOW);
    expect(result.outcome).toBe('invalid');
  });

  it('non-JSON Buffer → invalid outcome', async () => {
    const result = await buildConsumer().processMessage(Buffer.from('not json', 'utf8'), NOW);
    expect(result.outcome).toBe('invalid');
  });

  it('valid JSON but missing required merged fields → invalid outcome', async () => {
    const malformed = Buffer.from(
      JSON.stringify({ schema_version: '1', event_name: 'identity.merged', brand_id: BRAND_A }),
      'utf8',
    );
    const result = await buildConsumer().processMessage(malformed, NOW);
    expect(result.outcome).toBe('invalid');
  });
});

describe('IdentityChangeRecomputeConsumer.processMessage — idempotency', () => {
  it('same merged event redelivered twice → same request_id', async () => {
    const eventId = randomUUID();
    const buf = buildMergedBuffer({ event_id: eventId });
    const pub = fakePublisher();
    const consumer = buildConsumer(undefined, pub);

    await consumer.processMessage(buf, NOW);
    await consumer.processMessage(buf, NOW);

    const r1 = pub.calls[0]!.recompute as { request_id: string };
    const r2 = pub.calls[1]!.recompute as { request_id: string };
    expect(r1.request_id).toBe(r2.request_id);
  });

  it('same suppressed event redelivered twice → same request_id', async () => {
    const eventId = randomUUID();
    const buf = buildSuppressedBuffer({ event_id: eventId });
    const pub = fakePublisher();
    const consumer = buildConsumer(undefined, pub);

    await consumer.processMessage(buf, NOW);
    await consumer.processMessage(buf, NOW);

    const r1 = pub.calls[0]!.recompute as { request_id: string };
    const r2 = pub.calls[1]!.recompute as { request_id: string };
    expect(r1.request_id).toBe(r2.request_id);
  });

  it('different event_ids → different request_ids', async () => {
    const pub = fakePublisher();
    const consumer = buildConsumer(undefined, pub);

    await consumer.processMessage(buildMergedBuffer({ event_id: randomUUID() }), NOW);
    await consumer.processMessage(buildMergedBuffer({ event_id: randomUUID() }), NOW);

    const r1 = pub.calls[0]!.recompute as { request_id: string };
    const r2 = pub.calls[1]!.recompute as { request_id: string };
    expect(r1.request_id).not.toBe(r2.request_id);
  });
});

describe('IdentityChangeRecomputeConsumer.processMessage — brand isolation', () => {
  it('brand_A merge does not produce brand_B in the recompute', async () => {
    const BRAND_B = randomUUID();
    const pub = fakePublisher();
    await buildConsumer(undefined, pub).processMessage(
      buildMergedBuffer({ brand_id: BRAND_A }),
      NOW,
    );
    const recompute = pub.calls[0]!.recompute as { brand_id: string };
    expect(recompute.brand_id).toBe(BRAND_A);
    expect(recompute.brand_id).not.toBe(BRAND_B);
  });

  it('publisher receives the correct brand_id from the event envelope', async () => {
    const specificBrand = randomUUID();
    const pub = fakePublisher();
    await buildConsumer(undefined, pub).processMessage(
      buildMergedBuffer({ brand_id: specificBrand }),
      NOW,
    );
    const recompute = pub.calls[0]!.recompute as { brand_id: string };
    expect(recompute.brand_id).toBe(specificBrand);
  });
});

describe('IdentityChangeRecomputeConsumer.processMessage — brain_ops write error', () => {
  it('throws when repository.upsert throws (consumer retry path)', async () => {
    const consumer = buildConsumer(failingRepository());
    await expect(consumer.processMessage(buildMergedBuffer(), NOW)).rejects.toThrow(
      'StarRocks unavailable',
    );
  });

  it('does NOT call publisher when repository.upsert throws', async () => {
    const pub = fakePublisher();
    const consumer = buildConsumer(failingRepository(), pub);
    await expect(consumer.processMessage(buildMergedBuffer(), NOW)).rejects.toThrow();
    expect(pub.calls).toHaveLength(0);
  });
});

describe('IdentityChangeRecomputeConsumer.processMessage — publisher fail-open', () => {
  it('returns recomputed even when publisher throws (fail-open)', async () => {
    const failingPub: ICacheInvalidatePublisher = {
      async publishForRecompute() { throw new Error('Kafka unavailable'); },
    };
    const result = await buildConsumer(undefined, failingPub).processMessage(
      buildMergedBuffer(),
      NOW,
    );
    // Brain_ops write succeeded (repo is a fakeRepository that doesn't throw).
    // Publisher failed but that's fail-open → outcome is still recomputed.
    expect(result.outcome).toBe('recomputed');
  });
});
