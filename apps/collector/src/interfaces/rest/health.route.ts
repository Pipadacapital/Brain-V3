/**
 * Health endpoints:
 *   GET /healthz — liveness probe (server is up, always 200 if reachable)
 *   GET /readyz  — readiness probe: the collector can ACCEPT (ADR-0015 — log producer
 *                  connected OR disk-fallback headroom; Kafka down alone is NOT unready,
 *                  that is the whole point of the fallback). Also 503 `draining` during
 *                  SIGTERM shutdown (WAL durability posture: fail readiness FIRST so the
 *                  endpoints drop the pod before the final WAL drain).
 *   GET /health  — compatibility alias for /readyz
 */
import type { FastifyInstance } from 'fastify';
import type { ProducerBackpressure, ProducerBackpressureSnapshot } from './producer-backpressure.js';

// intentional: npm_package_version is an npm-injected runtime var (not app config) — leave raw.
const VERSION = process.env['npm_package_version'] ?? '0.0.0';

/**
 * Producer dep label (H3): 'unhealthy' = connected-but-failing (post-boot outage — the state
 * the old isConnected()-only snapshot could never surface); 'disconnected' = never/explicitly
 * disconnected; 'connected' = healthy.
 */
function logProducerState(snap: ProducerBackpressureSnapshot): 'connected' | 'unhealthy' | 'disconnected' {
  if (snap.producerHealthy) return 'connected';
  return snap.producerConnected ? 'unhealthy' : 'disconnected';
}

export function registerHealthRoutes(
  app: FastifyInstance,
  backpressure: ProducerBackpressure,
  /** True once a shutdown signal was received — readiness fails, liveness stays 200. */
  isShuttingDown: () => boolean = () => false,
): void {
  // Liveness — always 200 if the server is running.
  app.get('/healthz', async (_req, reply) => {
    reply.status(200).send({ status: 'alive', service: 'collector', version: VERSION });
  });

  // Readiness — ready iff a durable anchor is available for new events: the log (producer
  // HEALTHY — H3: isConnected() lies through a post-boot broker outage) OR headroom in the
  // bounded disk WAL. Only "log unhealthy AND WAL saturated" is not_ready (the same condition
  // the admission gate sheds 503 on) — the collector deliberately stays READY while the WAL
  // absorbs an outage. Surfaces the gauges so ops see producer/fallback state without a
  // separate metrics scrape.
  app.get('/readyz', async (_req, reply) => {
    // Shutdown drain (ADR-0015 WAL durability posture): SIGTERM flips this BEFORE the final
    // WAL flush so the k8s endpoints stop routing new accepts to a pod about to exit.
    if (isShuttingDown()) {
      reply.status(503).send({ status: 'draining', service: 'collector', version: VERSION });
      return;
    }
    const snap = backpressure.snapshot();
    const ready = !snap.tripped;
    reply.status(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'not_ready',
      service: 'collector',
      version: VERSION,
      deps: {
        log_producer: logProducerState(snap),
        disk_fallback: snap.fallbackSaturated ? 'saturated' : 'ok',
      },
      backpressure: snap,
    });
  });

  // Compat alias
  app.get('/health', async (_req, reply) => {
    if (isShuttingDown()) {
      reply.status(503).send({ status: 'draining', service: 'collector', version: VERSION });
      return;
    }
    const snap = backpressure.snapshot();
    const ready = !snap.tripped;
    reply.status(ready ? 200 : 503).send({
      status: ready ? 'ok' : 'degraded',
      service: 'collector',
      version: VERSION,
      deps: {
        log_producer: logProducerState(snap),
        disk_fallback: snap.fallbackSaturated ? 'saturated' : 'ok',
      },
    });
  });
}
