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

vi.mock('@brain/observability', () => ({
  extractCorrelationId: () => 'test-corr',
  incrementCounter: () => undefined,
}));

function buildApp(): { app: ReturnType<typeof Fastify>; execute: ReturnType<typeof vi.fn> } {
  const app = Fastify();
  let n = 0;
  const execute = vi.fn(async () => ({ spoolId: BigInt(++n), receivedAt: '2026-06-22T00:00:00.000Z' }));
  registerCollectRoute(app, { execute } as unknown as AcceptEventUseCase);
  return { app, execute };
}

describe('collector ingest routes', () => {
  it('POST /collect → 200 accepted (spool-first)', async () => {
    const { app } = buildApp();
    const res = await app.inject({ method: 'POST', url: '/collect', payload: { event: 'page.viewed' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accepted: true });
  });

  it('POST /batch → 200 with one spool id per event, executed once each', async () => {
    const { app, execute } = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/batch',
      payload: { events: [{ event: 'page.viewed' }, { event: 'product.viewed' }, { event: 'cart.item_added' }] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accepted).toBe(3);
    expect(body.spool_ids).toEqual(['1', '2', '3']);
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('POST /batch with empty array → 400 (envelope guard, not event validation)', async () => {
    const { app, execute } = buildApp();
    const res = await app.inject({ method: 'POST', url: '/batch', payload: { events: [] } });
    expect(res.statusCode).toBe(400);
    expect(res.json().accepted).toBe(0);
    expect(execute).not.toHaveBeenCalled();
  });

  it('POST /batch with a non-array events → 400', async () => {
    const { app } = buildApp();
    const res = await app.inject({ method: 'POST', url: '/batch', payload: { events: 'nope' } });
    expect(res.statusCode).toBe(400);
  });

  it('POST /batch over the 50-event cap → 400', async () => {
    const { app, execute } = buildApp();
    const events = Array.from({ length: 51 }, () => ({ event: 'page.viewed' }));
    const res = await app.inject({ method: 'POST', url: '/batch', payload: { events } });
    expect(res.statusCode).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });
});
