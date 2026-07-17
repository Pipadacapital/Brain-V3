/**
 * Health endpoints:
 *   GET /healthz — liveness probe (server is up, always 200 if reachable)
 *   GET /readyz  — readiness probe: the collector can ACCEPT (ADR-0015 — log producer
 *                  connected OR disk-fallback headroom; Kafka down alone is NOT unready,
 *                  that is the whole point of the fallback)
 *   GET /health  — compatibility alias for /readyz
 */
import type { FastifyInstance } from 'fastify';
import type { ProducerBackpressure } from './producer-backpressure.js';

// intentional: npm_package_version is an npm-injected runtime var (not app config) — leave raw.
const VERSION = process.env['npm_package_version'] ?? '0.0.0';

export function registerHealthRoutes(app: FastifyInstance, backpressure: ProducerBackpressure): void {
  // Liveness — always 200 if the server is running.
  app.get('/healthz', async (_req, reply) => {
    reply.status(200).send({ status: 'alive', service: 'collector', version: VERSION });
  });

  // Readiness — ready iff a durable anchor is available for new events: the log (producer
  // connected) OR headroom in the bounded disk WAL. Only "log down AND WAL saturated" is
  // not_ready (the same condition the admission gate sheds 503 on). Surfaces the gauge so
  // ops see producer/fallback state without a separate metrics scrape.
  app.get('/readyz', async (_req, reply) => {
    const snap = backpressure.snapshot();
    const ready = !snap.tripped;
    reply.status(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'not_ready',
      service: 'collector',
      version: VERSION,
      deps: {
        log_producer: snap.producerConnected ? 'connected' : 'disconnected',
        disk_fallback: snap.fallbackSaturated ? 'saturated' : 'ok',
      },
      backpressure: snap,
    });
  });

  // Compat alias
  app.get('/health', async (_req, reply) => {
    const snap = backpressure.snapshot();
    const ready = !snap.tripped;
    reply.status(ready ? 200 : 503).send({
      status: ready ? 'ok' : 'degraded',
      service: 'collector',
      version: VERSION,
      deps: {
        log_producer: snap.producerConnected ? 'connected' : 'disconnected',
        disk_fallback: snap.fallbackSaturated ? 'saturated' : 'ok',
      },
    });
  });
}
