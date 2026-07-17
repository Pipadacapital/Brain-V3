/**
 * ingest-40k — results reporter (doc-18 PR 0.1).
 *
 * Collects per-ACK latency samples + outcome counters during a run and renders
 * both a human summary and a machine-readable JSON artifact
 * (ingest-40k-summary.json). The summary records every input needed to
 * REGENERATE the deterministic sent-id set (seed / start_ts / events_sent), so
 * the P1 zero-loss assertion never depends on the manifest file surviving.
 */

/** Simple exact-percentile latency recorder (sort-at-end; fine for <10M samples). */
export class LatencyRecorder {
  constructor() {
    /** @type {number[]} */
    this.samples = [];
  }

  /** Record one ACK latency in milliseconds. */
  record(ms) {
    this.samples.push(ms);
  }

  percentile(sorted, p) {
    if (sorted.length === 0) return null;
    const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
    return sorted[Math.max(0, idx)];
  }

  summary() {
    const sorted = [...this.samples].sort((a, b) => a - b);
    const round = (v) => (v === null ? null : Math.round(v * 100) / 100);
    const sum = sorted.reduce((a, b) => a + b, 0);
    return {
      count: sorted.length,
      mean_ms: sorted.length ? round(sum / sorted.length) : null,
      p50_ms: round(this.percentile(sorted, 50)),
      p95_ms: round(this.percentile(sorted, 95)),
      p99_ms: round(this.percentile(sorted, 99)),
      max_ms: round(sorted.length ? sorted[sorted.length - 1] : null),
    };
  }
}

/**
 * Build the run summary object.
 * counters: { acked, errors, http503, throttledTicks }
 */
export function buildSummary({ opts, startTsMs, elapsedSeconds, uniqueSent, dupsSent, counters, latency }) {
  const totalSent = uniqueSent + dupsSent;
  return {
    harness: 'ingest-40k',
    mode: opts.mode,
    target: opts.mode === 'http' ? opts.url : `${opts.brokers} topic=${opts.topic}`,
    // Determinism inputs — regenerate the exact sent-id set from these three.
    seed: opts.seed,
    start_ts_ms: startTsMs,
    events_sent_unique: uniqueSent,
    duplicates_sent: dupsSent,
    dup_pct_configured: opts.dupPct,
    brands: opts.brandIds.length,
    brand_ids: opts.brandIds,
    // Rate
    target_rate_eps: opts.rate,
    duration_s: Math.round(elapsedSeconds * 100) / 100,
    achieved_rate_eps: elapsedSeconds > 0 ? Math.round((totalSent / elapsedSeconds) * 100) / 100 : 0,
    // Outcomes
    acked: counters.acked,
    errors: counters.errors,
    http_503: counters.http503,
    throttled_ticks: counters.throttledTicks,
    // ACK latency (produce-ack in kafka mode; HTTP round-trip in http mode)
    ack_latency: latency.summary(),
  };
}

/** Human-readable render of the summary (stderr-safe single block). */
export function renderSummary(s) {
  const l = s.ack_latency;
  return [
    '',
    '── ingest-40k run summary ─────────────────────────────────────────',
    `  mode=${s.mode}  target=${s.target}`,
    `  seed=${s.seed}  start_ts_ms=${s.start_ts_ms}  (regenerate ids from these)`,
    `  brands=${s.brands}  duration=${s.duration_s}s`,
    `  rate: target=${s.target_rate_eps}/s  achieved=${s.achieved_rate_eps}/s`,
    `  sent: unique=${s.events_sent_unique}  duplicates=${s.duplicates_sent} (dup-pct=${s.dup_pct_configured}%)`,
    `  acked=${s.acked}  errors=${s.errors}  503s=${s.http_503}  throttled_ticks=${s.throttled_ticks}`,
    `  ack latency ms: p50=${l.p50_ms}  p95=${l.p95_ms}  p99=${l.p99_ms}  max=${l.max_ms}  (n=${l.count})`,
    '───────────────────────────────────────────────────────────────────',
    '',
  ].join('\n');
}
