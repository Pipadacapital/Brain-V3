/**
 * collect.route.test.ts — in-process tests for the collector ingest routes (Phase H /batch focus).
 *
 * Uses fastify.inject with a stub AcceptEventUseCase (no DB) to lock the accept-before-validate
 * contract: /collect (200), /v1/events (202), and the new /batch (200 with per-event spool ids;
 * 400 on a non-array / empty / over-cap envelope). The stub proves each event is spooled exactly once.
 */
import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { registerCollectRoute } from './collect.route.js';
import type { AcceptEventUseCase } from '../../application/accept-event.usecase.js';

// Hermetic unit tier (AUD-IMPL-016): the edge-guard (AUD-INFRA-025) lazily calls
// loadCollectorConfig() inside the request path; its schema requires DATABASE_URL +
// KAFKA_BROKERS. Nothing in this suite connects — the token->brand binding oracle
// FAIL-OPENs on lookup failure — so dummies keep the suite runnable without a
// provisioned env (config parse otherwise turns every request into a 500).
process.env['DATABASE_URL'] ??= 'postgres://unit:unit@localhost:5432/unit_test_never_connected';
process.env['KAFKA_BROKERS'] ??= 'localhost:9092';


vi.mock('@brain/observability', () => ({
  extractCorrelationId: () => 'test-corr',
  incrementCounter: () => undefined,
  // src/log.ts (imported by the route module) builds a logger at module scope.
  createLogger: () => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: function () { return this; },
  }),
}));

function buildApp(): {
  app: ReturnType<typeof Fastify>;
  execute: ReturnType<typeof vi.fn>;
  executeMany: ReturnType<typeof vi.fn>;
} {
  const app = Fastify();
  let n = 0;
  const execute = vi.fn(async () => ({ spoolId: BigInt(++n), receivedAt: '2026-06-22T00:00:00.000Z' }));
  // Batch accept (AUD-PERF-007): ONE call spools the whole batch — ids stay per-event.
  const executeMany = vi.fn(async (rawBodies: Record<string, unknown>[]) => ({
    spoolIds: rawBodies.map(() => BigInt(++n)),
    receivedAt: '2026-06-22T00:00:00.000Z',
  }));
  registerCollectRoute(app, { execute, executeMany } as unknown as AcceptEventUseCase);
  return { app, execute, executeMany };
}

describe('collector ingest routes', () => {
  it('POST /collect → 200 accepted (spool-first)', async () => {
    const { app } = buildApp();
    const res = await app.inject({ method: 'POST', url: '/collect', payload: { event: 'page.viewed' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accepted: true });
  });

  it('POST /batch → 200 with one spool id per event, spooled in ONE batch insert', async () => {
    const { app, execute, executeMany } = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/batch',
      payload: { events: [{ event: 'page.viewed' }, { event: 'product.viewed' }, { event: 'cart.item_added' }] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accepted).toBe(3);
    expect(body.spool_ids).toEqual(['1', '2', '3']);
    // AUD-PERF-007: one multi-row INSERT for the whole batch — never N per-event round-trips.
    expect(executeMany).toHaveBeenCalledTimes(1);
    expect(executeMany.mock.calls[0]![0]).toHaveLength(3);
    expect(execute).not.toHaveBeenCalled();
  });

  it('POST /batch with empty array → 400 (envelope guard, not event validation)', async () => {
    const { app, executeMany } = buildApp();
    const res = await app.inject({ method: 'POST', url: '/batch', payload: { events: [] } });
    expect(res.statusCode).toBe(400);
    expect(res.json().accepted).toBe(0);
    expect(executeMany).not.toHaveBeenCalled();
  });

  it('POST /batch with a non-array events → 400', async () => {
    const { app } = buildApp();
    const res = await app.inject({ method: 'POST', url: '/batch', payload: { events: 'nope' } });
    expect(res.statusCode).toBe(400);
  });

  it('POST /batch over the 50-event cap → 400', async () => {
    const { app, executeMany } = buildApp();
    const events = Array.from({ length: 51 }, () => ({ event: 'page.viewed' }));
    const res = await app.inject({ method: 'POST', url: '/batch', payload: { events } });
    expect(res.statusCode).toBe(400);
    expect(executeMany).not.toHaveBeenCalled();
  });
});
