/**
 * @brain/observability — OTel SDK wrapper.
 *
 * Provides:
 *  - Trace/metrics/logs instrumentation with brand_id + correlation_id on every signal.
 *  - NN-6 PII-safe span attribute setter (refuses to set PII-keyed attributes).
 *  - gen_ai.* span convention helpers (used by the AI tier; OTel semantic conventions).
 *  - Correlation ID propagation helpers.
 *
 * Stack: OpenTelemetry SDK (ADR-009) — Grafana Cloud via OTLP exporter.
 *
 * REAL implementation (C1): spans wrap @opentelemetry/api Spans and counters route to the
 * @opentelemetry/sdk-node MeterProvider once initObservability runs. Export is gated on an
 * OTLP endpoint — absent (dev/test) it stays on the API's no-op providers / a console sink, so
 * nothing loads and nothing breaks. The redact.ts PII guard fires before any attribute reaches
 * the SDK, so redaction holds regardless of exporter wiring.
 */

export { isPiiKey, redactAttributes, redactLogRecord } from './redact.js';
export type { Attributes, AttributeValue } from './redact.js';
export { createLogger } from './logger.js';
export type { BrainLogger, LogFields, LogLevel, LoggerOptions } from './logger.js';
export { initSentry, captureError } from './sentry.js';
export type { SentryOptions } from './sentry.js';
export { registerProcessFailureHandlers } from './process-handlers.js';
export type { ProcessFailureHandlerOptions } from './process-handlers.js';
export { CircuitBreaker, CircuitOpenError } from './circuit-breaker.js';
export type { BreakerState, CircuitBreakerOptions } from './circuit-breaker.js';
export { extractKafkaTraceContext, injectKafkaTraceContext } from './kafka-trace.js';
export {
  renderPrometheusText,
  resetMetricsRegistry,
  PROMETHEUS_CONTENT_TYPE,
} from './prometheus.js';

// ── Span interface (a PII-guarded facade over the real @opentelemetry/api Span) ──

export interface BrainSpan {
  /** Set a span attribute. PII-keyed values are silently dropped (NN-6). */
  setAttribute(key: string, value: string | number | boolean): this;
  /** Set multiple attributes at once. PII-keyed values are dropped. */
  setAttributes(attrs: Record<string, string | number | boolean | undefined>): this;
  /** Record an error on the span. */
  recordException(error: Error): void;
  /** End the span. */
  end(): void;
}

// ── Required span fields ──────────────────────────────────────────────────────

export interface SpanContext {
  /** UUID of the brand — REQUIRED on every span (ADR-009, I-S01). */
  brandId: string;
  /** Distributed trace correlation identifier — REQUIRED (ADR-009). */
  correlationId: string;
  /** Service name (e.g. 'collector', 'stream-worker', 'core'). */
  serviceName: string;
}

// ── Tracer (real @opentelemetry/api; no-op providers in dev until initObservability) ──

import { trace, metrics, SpanStatusCode, type Span as OtelSpan } from '@opentelemetry/api';
import { redactAttributes, isPiiKey } from './redact.js';
import type { Attributes } from './redact.js';
import { recordCounter } from './prometheus.js';

const TRACER_NAME = '@brain/observability';

/**
 * BrainSpan over a REAL @opentelemetry/api Span. The PII guard (NN-6) fires HERE, before any
 * attribute reaches the OTel span, so redaction holds regardless of SDK/exporter wiring. When
 * no tracer provider is registered (dev/test without initObservability), trace.getTracer returns
 * the API's no-op tracer — spans cost nothing; once initObservability registers the OTLP SDK,
 * the same calls produce real exported spans. `_attrs` mirrors the redacted attributes for tests.
 */
class BrainSpanImpl implements BrainSpan {
  private readonly _attrs: Attributes = {};
  private readonly otel: OtelSpan;

  constructor(name: string, ctx: SpanContext) {
    this.otel = trace.getTracer(TRACER_NAME).startSpan(name);
    // brand_id + correlation_id are ALWAYS set (ADR-009). NOT PII (UUID tenant key + trace id).
    this.put('brand_id', ctx.brandId);
    this.put('correlation_id', ctx.correlationId);
    this.put('service.name', ctx.serviceName);
    this.put('span.name', name);
  }

  private put(key: string, value: string | number | boolean): void {
    this._attrs[key] = value;
    this.otel.setAttribute(key, value);
  }

  setAttribute(key: string, value: string | number | boolean): this {
    if (isPiiKey(key)) {
      return this; // silently drop — never the key or value (NN-6)
    }
    this.put(key, value);
    return this;
  }

  setAttributes(attrs: Record<string, string | number | boolean | undefined>): this {
    const safe = redactAttributes(attrs as Attributes);
    for (const [k, v] of Object.entries(safe)) {
      this.put(k, v as string | number | boolean);
    }
    return this;
  }

  recordException(error: Error): void {
    this._attrs['error'] = true;
    this._attrs['error.message'] = error.message;
    // Record name+message only — NEVER error.stack (stack frames may carry PII).
    this.otel.recordException({ name: error.name, message: error.message });
    this.otel.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
  }

  end(): void {
    this.otel.end();
  }

  /** For testing — expose collected (redacted) attributes. */
  _getAttributes(): Attributes {
    return { ...this._attrs };
  }
}

/**
 * Start a new span with the required Brain context, over the real OTel tracer.
 *
 * Every span MUST carry brand_id + correlation_id (ADR-009).
 * PII-keyed attributes set via setAttribute/setAttributes are silently dropped (NN-6).
 */
export function startSpan(name: string, ctx: SpanContext): BrainSpan {
  return new BrainSpanImpl(name, ctx);
}

// ── gen_ai.* span helpers (OTel GenAI semantic conventions) ──────────────────

export interface GenAiSpanContext extends SpanContext {
  /** LLM model name (e.g. 'claude-3-5-sonnet', 'gpt-4o'). */
  model: string;
  /** Effort tier (deterministic | statistical | small_model | frontier). */
  effortTier: 'deterministic' | 'statistical' | 'small_model' | 'frontier';
}

/**
 * Start a gen_ai.* span following OTel semantic conventions. Real span (exported when an
 * OTLP endpoint is configured; otherwise a no-op-provider span like any other startSpan).
 */
export function startGenAiSpan(name: string, ctx: GenAiSpanContext): BrainSpan {
  const span = startSpan(`gen_ai.${name}`, ctx);
  span.setAttribute('gen_ai.system', 'brain');
  span.setAttribute('gen_ai.request.model', ctx.model);
  span.setAttribute('gen_ai.effort_tier', ctx.effortTier);
  return span;
}

// ── Counter metrics (real OTel meter once initObservability runs) ────────────
//
// Before initObservability (dev/test, no OTLP endpoint) the default sink is a structured-log
// emission; after it, the sink swaps to the real @opentelemetry/api Meter with an identical
// surface. The emission is PII-safe by construction — labels are a bounded, low-cardinality
// set (brand_id is a UUID tenant key, never PII; event_name is a bounded dot.lowercase enum;
// layer ∈ {pg,redis}). NO raw value is ever a label.
//
// Used by the stream-worker to make dedup suppression OBSERVABLE (R4):
//   collector_dedup_conflict_total{brand_id,layer,event_name} on pk_conflict / dedup_hit.
// A forged/colliding event_id is now a counter increment, not a silent console.info.

export interface CounterLabels {
  [label: string]: string;
}

/**
 * Test/integration seam: a sink that receives every counter increment.
 * initObservability swaps the default sink to the OTel meter; tests inject a recording sink to
 * assert a metric was emitted (NON-INERT — the R4 dedup-observability test spies here).
 */
export interface CounterSink {
  add(name: string, value: number, labels: CounterLabels): void;
}

/** Default sink — structured-log line (replaced by the OTel meter once initObservability runs). */
const defaultCounterSink: CounterSink = {
  add(name: string, value: number, labels: CounterLabels): void {
    // Structured single-line emission; a log-based metric pipeline scrapes this in M1-.
    console.info(
      `[metric] ${name} +${value} ${JSON.stringify(labels)}`,
    );
  },
};

let activeCounterSink: CounterSink = defaultCounterSink;

/**
 * Override the counter sink (tests inject a recording sink; initObservability injects the OTel meter).
 * Returns a restore fn so a test can reset the global sink in afterEach.
 */
export function setCounterSink(sink: CounterSink): () => void {
  const prev = activeCounterSink;
  activeCounterSink = sink;
  return () => {
    activeCounterSink = prev;
  };
}

/**
 * Increment a counter metric by `value` (default 1) with the given labels.
 * PII-safe: callers MUST pass only bounded low-cardinality labels (no raw values).
 */
export function incrementCounter(
  name: string,
  labels: CounterLabels = {},
  value = 1,
): void {
  // ALWAYS feed the in-process Prometheus registry (AUD-LOCAL-016) — the /metrics endpoint
  // must see every increment regardless of which sink (stdout / OTel meter / test spy) is active.
  recordCounter(name, labels, value);
  activeCounterSink.add(name, value, labels);
}

/** A CounterSink backed by the real OTel meter (installed by initObservability in prod). */
function otelMeterSink(): CounterSink {
  const meter = metrics.getMeter(TRACER_NAME);
  const counters = new Map<string, ReturnType<typeof meter.createCounter>>();
  return {
    add(name: string, value: number, labels: CounterLabels): void {
      let counter = counters.get(name);
      if (!counter) {
        counter = meter.createCounter(name);
        counters.set(name, counter);
      }
      counter.add(value, labels);
    },
  };
}

// ── SDK lifecycle ─────────────────────────────────────────────────────────────

let _sdkInitialized = false;

/**
 * Initialize real OpenTelemetry export (ADR-009) — call ONCE per process from main.ts.
 *
 * When `otlpEndpoint` is set, lazily loads @opentelemetry/sdk-node and starts the NodeSDK, which
 * auto-configures OTLP trace + metric exporters from OTEL_* env. startSpan() then produces real
 * exported spans and incrementCounter() emits real OTel metrics (the sink swaps to the meter).
 * When the endpoint is absent (dev/test), this is a no-op: spans/counters stay on the API's
 * no-op providers / the console sink, so nothing is loaded and nothing breaks.
 *
 * @returns an async shutdown fn (flushes + stops the SDK) for graceful termination.
 */
export async function initObservability(opts: {
  serviceName: string;
  otlpEndpoint?: string;
}): Promise<() => Promise<void>> {
  if (_sdkInitialized || !opts.otlpEndpoint) {
    return async () => {};
  }
  _sdkInitialized = true;
  process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ??= opts.otlpEndpoint;
  process.env['OTEL_SERVICE_NAME'] ??= opts.serviceName;

  const { NodeSDK } = await import('@opentelemetry/sdk-node');
  const sdk = new NodeSDK();
  sdk.start();

  // Route counters to the real meter now that a global MeterProvider is registered.
  activeCounterSink = otelMeterSink();

  return async () => {
    await sdk.shutdown();
  };
}

// ── Correlation ID propagation ────────────────────────────────────────────────

/**
 * Extract the correlation ID from an HTTP request headers map.
 * Checks W3C traceparent first, then X-Correlation-Id, then generates a fallback.
 */
export function extractCorrelationId(
  headers: Record<string, string | string[] | undefined>,
): string {
  const traceparent = headers['traceparent'] ?? headers['Traceparent'];
  if (traceparent) {
    const val = Array.isArray(traceparent) ? traceparent[0] : traceparent;
    if (val) return val;
  }
  const corrId = headers['x-correlation-id'] ?? headers['X-Correlation-Id'];
  if (corrId) {
    const val = Array.isArray(corrId) ? corrId[0] : corrId;
    if (val) return val;
  }
  // Generate a fallback correlation ID (UUID v4-style using Math.random — real impl uses crypto).
  return `gen-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
