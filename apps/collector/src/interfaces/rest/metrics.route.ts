/**
 * GET /metrics — Prometheus text exposition of the in-process @brain/observability counter
 * registry (AUD-LOCAL-016). Scraped by infra/observe/prometheus.yml (job: brain-collector);
 * feeds the brain_collector_* exprs in the Grafana dashboards + brain-slo.rules.yml.
 *
 * Deliberately NOT behind the ingest admission gates: edge-guard + spool-backpressure only
 * match POST on GUARDED_INGEST_ROUTES (/collect, /v1/events, /batch) — a shedding collector
 * must still be scrapable (that is exactly when brain_collector_spool_full_total matters).
 * No auth: the port is not internet-exposed; metrics carry only bounded low-cardinality labels.
 */
import type { FastifyInstance } from 'fastify';
import { renderPrometheusText, PROMETHEUS_CONTENT_TYPE } from '@brain/observability';

export function registerMetricsRoute(app: FastifyInstance): void {
  app.get('/metrics', async (_req, reply) => {
    reply.status(200).header('content-type', PROMETHEUS_CONTENT_TYPE).send(renderPrometheusText());
  });
}
