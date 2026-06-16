/**
 * Health endpoints:
 *   GET /healthz — liveness probe (server is up, always 200 if reachable)
 *   GET /readyz  — readiness probe (spool DB reachable)
 *   GET /health  — compatibility alias for /readyz
 */
import type { FastifyInstance } from 'fastify';
import type { SpoolRepository } from '../../domain/ingest/repositories/spool.repository.js';

const VERSION = process.env['npm_package_version'] ?? '0.0.0';

export function registerHealthRoutes(app: FastifyInstance, spool: SpoolRepository): void {
  // Liveness — always 200 if the server is running.
  app.get('/healthz', async (_req, reply) => {
    reply.status(200).send({ status: 'alive', service: 'collector', version: VERSION });
  });

  // Readiness — depends on spool DB connectivity.
  app.get('/readyz', async (_req, reply) => {
    const dbOk = await spool.ping();
    const status = dbOk ? 200 : 503;
    reply.status(status).send({
      status: dbOk ? 'ready' : 'not_ready',
      service: 'collector',
      version: VERSION,
      deps: { spool_db: dbOk ? 'ok' : 'unreachable' },
    });
  });

  // Compat alias
  app.get('/health', async (_req, reply) => {
    const dbOk = await spool.ping();
    const status = dbOk ? 200 : 503;
    reply.status(status).send({
      status: dbOk ? 'ok' : 'degraded',
      service: 'collector',
      version: VERSION,
      deps: { spool_db: dbOk ? 'ok' : 'unreachable' },
    });
  });
}
