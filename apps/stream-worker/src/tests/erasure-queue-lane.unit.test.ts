/**
 * erasure-queue-lane.unit.test.ts — the PG request-driven erasure lane
 * (jobs/erasure-orchestrator/run.ts over ops.erasure_request_queue, ADR-0015 WS4).
 *
 * NO live infrastructure required — the queue repo, use case, and consent projection are
 * in-memory doubles. The DOMAIN sequence itself (crypto-shred ordering, Argo fail-safe,
 * CAPI reuse, tenant isolation) is exhaustively covered by erasure-orchestrator.unit.test.ts
 * over the UNCHANGED EraseSubjectUseCase; this suite proves the lane discipline that
 * REPLACED the Kafka consumer's offset/DLQ contract:
 *
 *   1. done-after-confirmed-write: a row is marked done ONLY after execute() returns
 *      (erased or a sanctioned skip) — the old commit-after-write.
 *   2. invalid → dead IMMEDIATELY (the old DLQ-immediate for unparseable envelopes).
 *   3. write error → retry with attempts+1 and exponential backoff (old no-commit → retry).
 *   4. attempts >= ERASURE_MAX_ATTEMPTS(5) → dead (the old DLQ@MAX_RETRY poison routing).
 *   5. Sequential oldest-first processing within a tick (per-brand total order; the
 *      per-brand head claim is enforced SQL-side in ErasureRequestQueueRepository).
 *   6. Stale 'processing' rows are requeued each tick (crash redelivery).
 *   7. Consent-withdrawal fold: ProjectConsentUseCase runs for every valid envelope
 *      (an erasure IS a full withdrawal); its failure retries the row (consent-loss risk
 *      is never silent).
 *   8. no_brain_id remains a completed skip (not a retry) — parity with the old
 *      commit-with-WARN outcome.
 */
import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  processErasureQueueTick,
  retryBackoffMs,
  ERASURE_MAX_ATTEMPTS,
  type ErasureQueueDeps,
} from '../jobs/erasure-orchestrator/run.js';
import type {
  ClaimedErasureRequest,
  IErasureRequestQueueRepository,
} from '../infrastructure/pg/ErasureRequestQueueRepository.js';
import type { EraseSubjectUseCase, EraseSubjectResult } from '../application/EraseSubjectUseCase.js';

const BRAND = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BRAIN_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function makeRow(overrides?: Partial<ClaimedErasureRequest>): ClaimedErasureRequest {
  const id = overrides?.id ?? randomUUID();
  return {
    id,
    brandId: BRAND,
    subjectKind: 'email',
    subjectRef: 'f'.repeat(64),
    source: 'consent.withdraw',
    payload: {
      schema_version: '1',
      event_id: id,
      brand_id: BRAND,
      event_name: 'privacy.erasure.requested',
      consent_flags: { analytics: false, marketing: false, personalization: false, ai_processing: false },
      properties: { source: 'consent.withdraw', reason: 'erasure', email: 'alice@example.com' },
    },
    attempts: 0,
    requestedAt: new Date('2026-07-18T00:00:00Z'),
    ...overrides,
  };
}

/** In-memory queue repo double recording every state transition. */
class FakeQueueRepo implements IErasureRequestQueueRepository {
  rows: ClaimedErasureRequest[] = [];
  staleRequeued = 0;
  readonly done: Array<{ id: string; outcome: string }> = [];
  readonly retried: Array<{ id: string; attempts: number; lastError: string; backoffMs: number }> = [];
  readonly dead: Array<{ id: string; attempts: number; lastError: string; outcome: string }> = [];
  readonly requeueCalls: number[] = [];

  async requeueStaleProcessing(staleMs: number): Promise<number> {
    this.requeueCalls.push(staleMs);
    return this.staleRequeued;
  }
  async claimBatch(limit: number): Promise<ClaimedErasureRequest[]> {
    return this.rows.slice(0, limit);
  }
  async markDone(id: string, outcome: string): Promise<void> {
    this.done.push({ id, outcome });
  }
  async markRetry(id: string, attempts: number, lastError: string, backoffMs: number): Promise<void> {
    this.retried.push({ id, attempts, lastError, backoffMs });
  }
  async markDead(id: string, attempts: number, lastError: string, outcome: string): Promise<void> {
    this.dead.push({ id, attempts, lastError, outcome });
  }
  async end(): Promise<void> { /* no-op */ }
}

type ExecuteImpl = (value: Buffer | null, now: string) => Promise<EraseSubjectResult>;

function makeDeps(execute: ExecuteImpl, opts?: {
  repo?: FakeQueueRepo;
  consentFail?: boolean;
  noConsent?: boolean;
}): { deps: ErasureQueueDeps; repo: FakeQueueRepo; executeSpy: ReturnType<typeof vi.fn>; consentSpy: ReturnType<typeof vi.fn> } {
  const repo = opts?.repo ?? new FakeQueueRepo();
  const executeSpy = vi.fn(execute);
  const consentSpy = vi.fn(async () => {
    if (opts?.consentFail) throw new Error('[consent] projection failed (test)');
    return { outcome: 'projected' as const };
  });
  const deps: ErasureQueueDeps = {
    repo,
    eraseSubject: { execute: executeSpy } as unknown as EraseSubjectUseCase,
    ...(opts?.noConsent ? {} : { projectConsent: { execute: consentSpy } as never }),
  };
  return { deps, repo, executeSpy, consentSpy };
}

const erasedResult = (): EraseSubjectResult => ({
  outcome: 'erased', brandId: BRAND, eventId: randomUUID(), brainId: BRAIN_ID, surrogateId: randomUUID(),
});

describe('erasure queue lane — done-after-confirmed-write (old commit-after-write)', () => {
  it('marks the row done with outcome=erased only after execute() returns', async () => {
    const { deps, repo } = makeDeps(async () => erasedResult());
    repo.rows = [makeRow({ id: '00000000-0000-4000-8000-000000000001' })];

    const result = await processErasureQueueTick(deps, 10);

    expect(result.erased).toBe(1);
    expect(repo.done).toEqual([{ id: '00000000-0000-4000-8000-000000000001', outcome: 'erased' }]);
    expect(repo.retried).toHaveLength(0);
    expect(repo.dead).toHaveLength(0);
  });

  it('sanctioned skip outcomes (not_an_erasure / no_consent_flags / no_subject / no_brain_id) complete as done', async () => {
    const outcomes = ['not_an_erasure', 'no_consent_flags', 'no_subject', 'no_brain_id'] as const;
    for (const outcome of outcomes) {
      const { deps, repo } = makeDeps(async () => ({ outcome, brandId: BRAND, eventId: randomUUID() }));
      repo.rows = [makeRow()];
      const result = await processErasureQueueTick(deps, 10);
      expect(result.skipped).toBe(1);
      expect(repo.done).toHaveLength(1);
      expect(repo.done[0]!.outcome).toBe(outcome);
      expect(repo.retried).toHaveLength(0);
      expect(repo.dead).toHaveLength(0);
    }
  });

  it('feeds the stored payload byte-identically (JSON round-trip) to EraseSubjectUseCase', async () => {
    const { deps, repo, executeSpy } = makeDeps(async () => erasedResult());
    const row = makeRow();
    repo.rows = [row];

    await processErasureQueueTick(deps, 10);

    const value = executeSpy.mock.calls[0]![0] as Buffer;
    expect(JSON.parse(value.toString('utf8'))).toEqual(row.payload);
  });
});

describe('erasure queue lane — invalid → dead immediately (old DLQ-immediate)', () => {
  it('an invalid envelope goes dead with outcome=invalid and NO retry', async () => {
    const { deps, repo } = makeDeps(async () => ({ outcome: 'invalid', reason: 'missing brand_id or event_id' }));
    repo.rows = [makeRow({ payload: { garbage: true } })];

    const result = await processErasureQueueTick(deps, 10);

    expect(result.dead).toBe(1);
    expect(repo.dead).toHaveLength(1);
    expect(repo.dead[0]!.outcome).toBe('invalid');
    expect(repo.dead[0]!.lastError).toContain('missing brand_id');
    expect(repo.retried).toHaveLength(0);
    expect(repo.done).toHaveLength(0);
  });

  it('a null payload row rides the invalid path (execute receives null, like a null Kafka value)', async () => {
    const { deps, repo, executeSpy } = makeDeps(async (value) => {
      expect(value).toBeNull();
      return { outcome: 'invalid', reason: 'null message value' };
    });
    repo.rows = [makeRow({ payload: null })];
    await processErasureQueueTick(deps, 10);
    expect(executeSpy).toHaveBeenCalledWith(null, expect.any(String));
    expect(repo.dead).toHaveLength(1);
  });
});

describe('erasure queue lane — retry-with-poison (old no-commit → retry → DLQ@MAX_RETRY)', () => {
  it('a write error retries with attempts+1 and exponential backoff; the row is NOT done', async () => {
    const { deps, repo } = makeDeps(async () => { throw new Error('[neo4j] connection refused'); });
    repo.rows = [makeRow({ attempts: 0 })];

    const result = await processErasureQueueTick(deps, 10);

    expect(result.retried).toBe(1);
    expect(repo.retried).toHaveLength(1);
    expect(repo.retried[0]!.attempts).toBe(1);
    expect(repo.retried[0]!.lastError).toContain('connection refused');
    expect(repo.retried[0]!.backoffMs).toBe(retryBackoffMs(1));
    expect(repo.done).toHaveLength(0);
    expect(repo.dead).toHaveLength(0);
  });

  it('salt failure (D-2) rides the retry path — an erasure is never silently lost', async () => {
    const { deps, repo } = makeDeps(async () => { throw new Error('[salt] provider unavailable'); });
    repo.rows = [makeRow()];
    await processErasureQueueTick(deps, 10);
    expect(repo.retried).toHaveLength(1);
    expect(repo.done).toHaveLength(0);
  });

  it(`goes dead at attempts >= ${ERASURE_MAX_ATTEMPTS} (poison parity with MAX_RETRY=5)`, async () => {
    const { deps, repo } = makeDeps(async () => { throw new Error('still failing'); });
    repo.rows = [makeRow({ attempts: ERASURE_MAX_ATTEMPTS - 1 })];

    const result = await processErasureQueueTick(deps, 10);

    expect(result.dead).toBe(1);
    expect(repo.dead).toHaveLength(1);
    expect(repo.dead[0]!.attempts).toBe(ERASURE_MAX_ATTEMPTS);
    expect(repo.dead[0]!.lastError).toContain('max_retry_exceeded');
    expect(repo.retried).toHaveLength(0);
  });

  it('backoff is exponential and capped (30s, 60s, 120s, … ≤ 15m)', () => {
    expect(retryBackoffMs(1)).toBe(30_000);
    expect(retryBackoffMs(2)).toBe(60_000);
    expect(retryBackoffMs(3)).toBe(120_000);
    expect(retryBackoffMs(100)).toBe(15 * 60 * 1000);
  });
});

describe('erasure queue lane — ordering + crash redelivery', () => {
  it('processes claimed rows SEQUENTIALLY, oldest first (per-brand total order)', async () => {
    const processed: string[] = [];
    let inFlight = 0;
    const { deps, repo } = makeDeps(async (value) => {
      inFlight += 1;
      expect(inFlight).toBe(1); // never two rows concurrently
      const parsed = JSON.parse((value as Buffer).toString('utf8')) as { event_id: string };
      processed.push(parsed.event_id);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return erasedResult();
    });
    const r1 = makeRow({ id: '00000000-0000-4000-8000-00000000000a', requestedAt: new Date('2026-07-18T00:00:00Z') });
    const r2 = makeRow({ id: '00000000-0000-4000-8000-00000000000b', requestedAt: new Date('2026-07-18T00:00:01Z') });
    repo.rows = [r1, r2];

    await processErasureQueueTick(deps, 10);

    expect(processed).toEqual([r1.id, r2.id]);
  });

  it('requeues stale processing rows at the start of every tick (crash redelivery)', async () => {
    const { deps, repo } = makeDeps(async () => erasedResult());
    repo.staleRequeued = 2;
    const result = await processErasureQueueTick(deps, 10);
    expect(repo.requeueCalls).toHaveLength(1);
    expect(result.requeuedStale).toBe(2);
  });
});

describe('erasure queue lane — consent-withdrawal fold (an erasure IS a full withdrawal)', () => {
  it('projects consent for a valid envelope (erased outcome) before completing', async () => {
    const { deps, repo, consentSpy } = makeDeps(async () => erasedResult());
    repo.rows = [makeRow()];
    await processErasureQueueTick(deps, 10);
    expect(consentSpy).toHaveBeenCalledTimes(1);
    expect(repo.done).toHaveLength(1);
  });

  it('projects consent even for a no_brain_id skip (the retired suppressor lane projected regardless)', async () => {
    const { deps, repo, consentSpy } = makeDeps(async () => ({ outcome: 'no_brain_id', brandId: BRAND, eventId: randomUUID() }));
    repo.rows = [makeRow()];
    await processErasureQueueTick(deps, 10);
    expect(consentSpy).toHaveBeenCalledTimes(1);
    expect(repo.done).toHaveLength(1);
  });

  it('does NOT project consent for an invalid envelope (dead path)', async () => {
    const { deps, repo, consentSpy } = makeDeps(async () => ({ outcome: 'invalid', reason: 'JSON parse error' }));
    repo.rows = [makeRow()];
    await processErasureQueueTick(deps, 10);
    expect(consentSpy).not.toHaveBeenCalled();
    expect(repo.dead).toHaveLength(1);
  });

  it('FAIL-CLOSED: a consent-projection failure retries the row (consent loss is never silent)', async () => {
    const { deps, repo } = makeDeps(async () => erasedResult(), { consentFail: true });
    repo.rows = [makeRow()];
    const result = await processErasureQueueTick(deps, 10);
    expect(result.retried).toBe(1);
    expect(repo.done).toHaveLength(0);
    expect(repo.retried[0]!.lastError).toContain('projection failed');
  });

  it('lane still completes without a wired consent projection (unit harness compatibility)', async () => {
    const { deps, repo } = makeDeps(async () => erasedResult(), { noConsent: true });
    repo.rows = [makeRow()];
    await processErasureQueueTick(deps, 10);
    expect(repo.done).toHaveLength(1);
  });
});
