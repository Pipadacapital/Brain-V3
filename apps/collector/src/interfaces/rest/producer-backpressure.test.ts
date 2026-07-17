/**
 * producer-backpressure.test.ts — bounded admission gate over the ingest routes (ADR-0015):
 *   • admit whenever a durable anchor exists (producer connected OR WAL headroom)
 *   • shed 503 INGEST_BACKPRESSURE + Retry-After only when log down AND WAL saturated
 *   • FallbackSaturatedError thrown mid-request maps to the same 503
 */
import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';

process.env['DATABASE_URL'] ??= 'postgres://unit:unit@localhost:5432/unit_test_never_connected';
process.env['KAFKA_BROKERS'] ??= 'localhost:9092';

vi.mock('@brain/observability', () => ({
  extractCorrelationId: () => 'test-corr',
  incrementCounter: () => undefined,
  createLogger: () => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: function () { return this; },
  }),
}));

import { ProducerBackpressure, registerProducerBackpressure } from './producer-backpressure.js';
import { registerHealthRoutes } from './health.route.js';
import { FallbackSaturatedError } from '../../infrastructure/local-disk-fallback.js';

function gate(
  producerHealthy: boolean,
  saturated: boolean,
  /** Post-boot outage shape (H3): connected can stay true while healthy is false. */
  producerConnected: boolean = producerHealthy,
): ProducerBackpressure {
  return new ProducerBackpressure(
    { isConnected: () => producerConnected, isHealthy: () => producerHealthy },
    { isSaturated: () => saturated, pendingBytes: () => (saturated ? 100 : 0) },
    { retryAfterSeconds: 7 },
  );
}

describe('ProducerBackpressure.admit', () => {
  it('admits when the producer is healthy (WAL state irrelevant)', () => {
    expect(gate(true, false).admit()).toBe(true);
    expect(gate(true, true).admit()).toBe(true);
  });

  it('admits when the producer is unhealthy but the WAL has headroom (the point of the fallback)', () => {
    expect(gate(false, false).admit()).toBe(true);
  });

  it('sheds ONLY when the producer is unhealthy AND the WAL is saturated (no anchor left)', () => {
    expect(gate(false, true).admit()).toBe(false);
  });

  it('trips on the POST-BOOT outage shape: still connected, no longer healthy, WAL full (H3)', () => {
    // The pre-H3 gate read isConnected() — non-null producer through a broker outage — so this
    // exact state could NEVER shed. isHealthy() makes the trip reachable.
    const g = gate(false, true, true);
    expect(g.admit()).toBe(false);
    expect(g.snapshot()).toEqual({
      producerConnected: true,
      producerHealthy: false,
      fallbackSaturated: true,
      fallbackPendingBytes: 100,
      tripped: true,
    });
  });

  it('snapshot() surfaces both gauges + the tripped state', () => {
    expect(gate(false, true).snapshot()).toEqual({
      producerConnected: false,
      producerHealthy: false,
      fallbackSaturated: true,
      fallbackPendingBytes: 100,
      tripped: true,
    });
  });
});

describe('GET /readyz reflects producer HEALTH (H3), not mere connectedness', () => {
  function healthApp(g: ProducerBackpressure): ReturnType<typeof Fastify> {
    const app = Fastify();
    registerHealthRoutes(app, g);
    return app;
  }

  it('503 not_ready when connected-but-unhealthy AND saturated (post-boot outage, WAL full)', async () => {
    const res = await healthApp(gate(false, true, true)).inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    const body = res.json() as { status: string; deps: { log_producer: string } };
    expect(body.status).toBe('not_ready');
    expect(body.deps.log_producer).toBe('unhealthy'); // connected but failing — now visible
  });

  it('200 ready while unhealthy but the WAL still has headroom (collector stays READY, WAL absorbs)', async () => {
    const res = await healthApp(gate(false, false, true)).inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { status: string }).status).toBe('ready');
  });

  it('200 ready + log_producer=connected when healthy', async () => {
    const res = await healthApp(gate(true, false)).inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { deps: { log_producer: string } }).deps.log_producer).toBe('connected');
  });
});

describe('registerProducerBackpressure — 503 shed over the ingest routes', () => {
  function buildApp(g: ProducerBackpressure, handler?: () => Promise<unknown>): ReturnType<typeof Fastify> {
    const app = Fastify();
    registerProducerBackpressure(app, g);
    const h = handler ?? (async () => ({ accepted: true }));
    app.post('/collect', h);
    app.post('/batch', h);
    app.get('/healthz', async () => ({ status: 'alive' }));
    return app;
  }

  it('tripped gate sheds POST /collect with 503 + Retry-After before the handler', async () => {
    const handler = vi.fn(async () => ({ accepted: true }));
    const app = buildApp(gate(false, true), handler);
    const res = await app.inject({ method: 'POST', url: '/collect', payload: {} });
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('7');
    expect(res.json()).toEqual({ accepted: false, error: { code: 'INGEST_BACKPRESSURE' } });
    expect(handler).not.toHaveBeenCalled();
  });

  it('covers /batch and query-suffixed routes via the route pattern (AUD-PERF-001)', async () => {
    const app = buildApp(gate(false, true));
    expect((await app.inject({ method: 'POST', url: '/batch', payload: {} })).statusCode).toBe(503);
    expect((await app.inject({ method: 'POST', url: '/collect?x=1', payload: {} })).statusCode).toBe(503);
  });

  it('does NOT gate non-ingest routes', async () => {
    const app = buildApp(gate(false, true));
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
  });

  it('open gate admits normally', async () => {
    const app = buildApp(gate(false, false));
    const res = await app.inject({ method: 'POST', url: '/collect', payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accepted: true });
  });

  it('maps a mid-request FallbackSaturatedError (produce failed at cap) to the same 503', async () => {
    const app = buildApp(gate(true, true), async () => {
      throw new FallbackSaturatedError(100, 100);
    });
    const res = await app.inject({ method: 'POST', url: '/collect', payload: {} });
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('7');
    expect(res.json()).toEqual({ accepted: false, error: { code: 'INGEST_BACKPRESSURE' } });
  });

  it('leaves other errors to the default handler (500, not a masked 503)', async () => {
    const app = buildApp(gate(true, false), async () => {
      throw new Error('boom');
    });
    const res = await app.inject({ method: 'POST', url: '/collect', payload: {} });
    expect(res.statusCode).toBe(500);
  });
});
