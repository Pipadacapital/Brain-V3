/**
 * prometheus.ts — in-process metric registry + Prometheus text exposition (AUD-LOCAL-016).
 *
 * Before this, incrementCounter() only wrote a "[metric] name +1 {labels}" stdout line, so every
 * brain_* series the Grafana dashboards and brain-slo.rules.yml query was permanently absent.
 * This registry accumulates every counter increment in-process; apps expose it via a GET /metrics
 * route that returns renderPrometheusText() (text/plain exposition format, version 0.0.4).
 *
 * Naming: call sites use bare names (e.g. `collector_accept_total`); the dashboards query the
 * `brain_` prefix (`brain_collector_accept_total`) — the prefix is applied HERE, at exposition
 * time, exactly once. Hand-rolled on purpose: no new dependency.
 *
 * Gauges (added for the data-flow SLO alerts, Wave 0): a small set-not-add surface for point-in-time
 * values (e.g. `silver_identity_watermark_age_seconds`). setGauge OVERWRITES the series value (unlike
 * recordCounter, which accumulates); counters and gauges share the same `brain_` prefixing + label
 * rendering but live in independent name→series maps.
 */

/** Content-Type for the /metrics response (Prometheus text exposition format). */
export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

const METRIC_PREFIX = 'brain_';

interface CounterSeries {
  labels: Record<string, string>;
  value: number;
}

/** name → (serialized-label-key → series). Insertion order preserved; render sorts names. */
const counters = new Map<string, Map<string, CounterSeries>>();

/** Gauge series share CounterSeries's shape (labels + value); setGauge OVERWRITES the value. */
const gauges = new Map<string, Map<string, CounterSeries>>();

/** Escape a label value per the exposition format: backslash, double-quote, newline. */
function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** Sanitize a metric/label name to the Prometheus charset [a-zA-Z_][a-zA-Z0-9_]*. */
function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^([0-9])/, '_$1');
}

/** Deterministic key for a label set (sorted), so {a,b} and {b,a} hit the same series. */
function labelKey(labels: Record<string, string>): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(',');
}

/**
 * Record a counter increment into the registry. Called by incrementCounter() for EVERY
 * increment, regardless of which CounterSink is active — the /metrics surface works in dev
 * (stdout sink), test (recording sink), and prod (OTel meter sink) alike.
 */
export function recordCounter(name: string, labels: Record<string, string>, value: number): void {
  if (!Number.isFinite(value)) return;
  let series = counters.get(name);
  if (!series) {
    series = new Map();
    counters.set(name, series);
  }
  const key = labelKey(labels);
  const existing = series.get(key);
  if (existing) {
    existing.value += value;
  } else {
    series.set(key, { labels: { ...labels }, value });
  }
}

/**
 * Set a gauge series to `value` (OVERWRITE — the last write wins, not accumulate). Used for
 * point-in-time signals the SLO rules alert on, e.g. silver_identity_watermark_age_seconds.
 * PII-safe by the same contract as recordCounter: labels are a bounded low-cardinality set.
 */
export function setGauge(name: string, labels: Record<string, string>, value: number): void {
  if (!Number.isFinite(value)) return;
  let series = gauges.get(name);
  if (!series) {
    series = new Map();
    gauges.set(name, series);
  }
  series.set(labelKey(labels), { labels: { ...labels }, value });
}

/** Render one name→series map with the given metric TYPE, applying the `brain_` prefix once. */
function renderSeriesMap(map: Map<string, Map<string, CounterSeries>>, type: string): string[] {
  const lines: string[] = [];
  for (const name of [...map.keys()].sort()) {
    const exposed = sanitizeName(name.startsWith(METRIC_PREFIX) ? name : METRIC_PREFIX + name);
    lines.push(`# TYPE ${exposed} ${type}`);
    for (const s of map.get(name)!.values()) {
      const entries = Object.entries(s.labels);
      const labelStr =
        entries.length === 0
          ? ''
          : `{${entries
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, v]) => `${sanitizeName(k)}="${escapeLabelValue(v)}"`)
              .join(',')}}`;
      lines.push(`${exposed}${labelStr} ${s.value}`);
    }
  }
  return lines;
}

/**
 * Render the registry in Prometheus text exposition format. Counter/gauge names get the `brain_`
 * prefix (unless the call site already used it), matching the Grafana/SLO-rule expr names.
 */
export function renderPrometheusText(): string {
  const lines = [
    ...renderSeriesMap(counters, 'counter'),
    ...renderSeriesMap(gauges, 'gauge'),
  ];
  return lines.join('\n') + (lines.length > 0 ? '\n' : '');
}

/** Test seam — wipe all series (afterEach). */
export function resetMetricsRegistry(): void {
  counters.clear();
  gauges.clear();
}
