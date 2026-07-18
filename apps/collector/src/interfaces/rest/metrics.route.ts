/**
 * GET /metrics — Prometheus text exposition of the in-process @brain/observability counter
 * registry (AUD-LOCAL-016). Scraped by infra/observe/prometheus.yml (job: brain-collector);
 * feeds the brain_collector_* exprs in the Grafana dashboards + brain-slo.rules.yml.
 *
 * GAUGES (ADR-0015 WAL durability posture): the @brain/observability registry is counters-only
 * by design, so scrape-time gauges (WAL pending bytes/events/oldest-entry age) are appended
 * HERE from a caller-supplied sampler — evaluated per scrape, so they are always current with
 * the WAL's append/flush accounting (no staleness window). Same `brain_` exposition prefix as
 * the counter registry (the dashboards/SLO rules query brain_collector_wal_*).
 *
 * Deliberately NOT behind the ingest admission gates: edge-guard + producer-backpressure only
 * match POST on GUARDED_INGEST_ROUTES (/collect, /v1/events, /batch) — a shedding collector
 * must still be scrapable (that is exactly when brain_collector_backpressure_shed_total matters).
 * No auth: the port is not internet-exposed; metrics carry only bounded low-cardinality labels.
 */
import type { FastifyInstance } from 'fastify';
import { renderPrometheusText, PROMETHEUS_CONTENT_TYPE } from '@brain/observability';

/** One scrape-time gauge sample. `name` is bare (collector_wal_*); brain_ prefix applied here. */
export interface GaugeSample {
  name: string;
  value: number;
}

const METRIC_PREFIX = 'brain_';

/** Render gauge samples in Prometheus text exposition format (brain_ prefix, TYPE gauge). */
export function renderGaugeText(samples: GaugeSample[]): string {
  const lines: string[] = [];
  for (const { name, value } of samples) {
    if (!Number.isFinite(value)) continue;
    const exposed = name.startsWith(METRIC_PREFIX) ? name : METRIC_PREFIX + name;
    lines.push(`# TYPE ${exposed} gauge`);
    lines.push(`${exposed} ${value}`);
  }
  return lines.length > 0 ? lines.join('\n') + '\n' : '';
}

export function registerMetricsRoute(app: FastifyInstance, gauges?: () => GaugeSample[]): void {
  app.get('/metrics', async (_req, reply) => {
    const body = renderPrometheusText() + (gauges ? renderGaugeText(gauges()) : '');
    reply.status(200).header('content-type', PROMETHEUS_CONTENT_TYPE).send(body);
  });
}
