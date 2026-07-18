/**
 * collect.route.test.ts — in-process tests for the collector ingest routes (ADR-0015).
 *
 * Uses fastify.inject with a stub AcceptEventUseCase (no broker, no disk) to lock the
 * accept-before-validate contract: /collect (200), /v1/events (202), and /batch (200;
 * 400 on a non-array / empty / over-cap envelope). The stub proves each request anchors
 * (produce or fallback) exactly once BEFORE the ACK.
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
  const execute = vi.fn(async () => ({
    receivedAt: '2026-06-22T00:00:00.000Z',
    durability: 'produced' as const,
  }));
  // Batch accept: ONE anchor call (produceBatch or WAL append) for the whole batch.
  const executeMany = vi.fn(async (rawBodies: Record<string, unknown>[]) => ({
    accepted: rawBodies.length,
    receivedAt: '2026-06-22T00:00:00.000Z',
    durability: 'produced' as const,
  }));
  registerCollectRoute(app, { execute, executeMany } as unknown as AcceptEventUseCase);
  return { app, execute, executeMany };
}

describe('collector ingest routes', () => {
  it('POST /collect → 200 accepted (produce-ack before ACK)', async () => {
    const { app, execute } = buildApp();
    const res = await app.inject({ method: 'POST', url: '/collect', payload: { event: 'page.viewed' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accepted: true });
    expect(res.headers['x-received-at']).toBe('2026-06-22T00:00:00.000Z');
    // The accept path anchored exactly once, with the request-scoped correlation id.
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![1]).toBe('test-corr');
  });

  it('POST /v1/events → 202 accepted (contract alias)', async () => {
    const { app, execute } = buildApp();
    const res = await app.inject({ method: 'POST', url: '/v1/events', payload: { event: 'page.viewed' } });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ accepted: true });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('POST /batch → 200 with the accepted count, anchored in ONE batch produce', async () => {
    const { app, execute, executeMany } = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/batch',
      payload: { events: [{ event: 'page.viewed' }, { event: 'product.viewed' }, { event: 'cart.item_added' }] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accepted).toBe(3);
    // ONE anchor for the whole batch — never N per-event produces.
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
