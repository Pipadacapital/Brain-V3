/**
 * @brain/observability — OTel SDK wrapper.
 *
 * Provides:
 *  - Trace/metrics/logs instrumentation with brand_id + correlation_id on every signal.
 *  - NN-6 PII-safe span attribute setter (refuses to set PII-keyed attributes).
 *  - gen_ai.* span convention helpers (reserved for Phase 3+; no-op in Sprint 0).
 *  - Correlation ID propagation helpers.
 *
 * Stack: OpenTelemetry SDK (ADR-009) — Grafana Cloud via OTLP exporter.
 *
 * IMPORTANT: This package avoids importing @opentelemetry/* directly in Sprint 0
 * to keep zero external deps. It exports the interface types and a stub implementation
 * that will be wired to the real OTel SDK in M1 when the EKS+collector stack is live.
 * The redact.ts PII guard and its tests ARE production code and ship now.
 */

export { isPiiKey, redactAttributes, redactLogRecord } from './redact.js';
export type { Attributes, AttributeValue } from './redact.js';

// ── Span interface (minimal — avoids OTel dep; real impl wires to @opentelemetry/api) ──

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

// ── Stub tracer (Sprint 0 — real OTel wired in M1) ───────────────────────────

import { redactAttributes, isPiiKey } from './redact.js';
import type { Attributes } from './redact.js';

/**
 * Stub span implementation.
 * In M1 this wraps @opentelemetry/api Span; the interface is identical.
 * The PII guard (redactAttributes) fires here regardless of SDK wiring.
 */
class StubSpan implements BrainSpan {
  private readonly _attrs: Attributes = {};

  constructor(
    private readonly name: string,
    private readonly ctx: SpanContext,
  ) {
    // Brand ID and correlation ID are always set on span creation (ADR-009).
    // They are NOT PII (brand_id is a UUID tenant key; correlation_id is a trace identifier).
    this._attrs['brand_id'] = ctx.brandId;
    this._attrs['correlation_id'] = ctx.correlationId;
    this._attrs['service.name'] = ctx.serviceName;
    this._attrs['span.name'] = name;
  }

  setAttribute(key: string, value: string | number | boolean): this {
    if (isPiiKey(key)) {
      // Silently drop — do not log the key or value.
      return this;
    }
    this._attrs[key] = value;
    return this;
  }

  setAttributes(attrs: Record<string, string | number | boolean | undefined>): this {
    const safe = redactAttributes(attrs as Attributes);
    Object.assign(this._attrs, safe);
    return this;
  }

  recordException(error: Error): void {
    this._attrs['error'] = true;
    this._attrs['error.message'] = error.message;
    // Do NOT log error.stack as it may contain PII in stack frames.
  }

  end(): void {
    // No-op in stub; real OTel SDK will flush to the OTLP exporter.
  }

  /** For testing — expose collected (redacted) attributes. */
  _getAttributes(): Attributes {
    return { ...this._attrs };
  }
}

/**
 * Start a new span with the required Brain context.
 *
 * Every span MUST carry brand_id + correlation_id (ADR-009).
 * PII-keyed attributes set via setAttribute/setAttributes are silently dropped (NN-6).
 *
 * @param name - Span name (dot-separated, lowercase: 'collector.event.ingest').
 * @param ctx - Required span context (brandId, correlationId, serviceName).
 * @returns A BrainSpan wrapping the OTel span.
 */
export function startSpan(name: string, ctx: SpanContext): BrainSpan {
  return new StubSpan(name, ctx);
}

// ── gen_ai.* span helpers (Phase 3+ reserved; no-op in Sprint 0) ─────────────

export interface GenAiSpanContext extends SpanContext {
  /** LLM model name (e.g. 'claude-3-5-sonnet', 'gpt-4o'). */
  model: string;
  /** Effort tier (deterministic | statistical | small_model | frontier). */
  effortTier: 'deterministic' | 'statistical' | 'small_model' | 'frontier';
}

/**
 * Start a gen_ai.* span following OTel semantic conventions.
 * Reserved for Phase 3+; returns a no-op span in Sprint 0.
 */
export function startGenAiSpan(name: string, ctx: GenAiSpanContext): BrainSpan {
  const span = startSpan(`gen_ai.${name}`, ctx);
  span.setAttribute('gen_ai.system', 'brain');
  span.setAttribute('gen_ai.request.model', ctx.model);
  span.setAttribute('gen_ai.effort_tier', ctx.effortTier);
  return span;
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
