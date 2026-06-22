/**
 * kafka-trace.ts — OTel W3C trace-context propagation across Kafka message boundaries.
 *
 * The OTel spec (and the observability skill) are explicit: WITHOUT this, every Kafka consumer
 * creates an orphaned root span — the trace breaks at the topic boundary and distributed
 * tracing is useless for debugging ingest pipeline latency or errors.
 *
 * Pattern (per OTel Kafka instrumentation spec):
 *   Producer side (collector / repull jobs):
 *     propagation.inject(context.active(), headers, textMapSetter)
 *     → writes 'traceparent' + 'tracestate' into the Kafka message headers.
 *
 *   Consumer side (each stream-worker *Consumer class eachMessage handler):
 *     const ctx = extractKafkaTraceContext(message.headers)
 *     context.with(ctx, async () => { /* eachMessage body *\/ })
 *     → resumes the parent trace instead of starting a new root span.
 *
 * The helpers here are pure utility shims over @opentelemetry/api so they work whether or
 * not initObservability has been called (the API is always present; when the SDK is not
 * initialised, the propagator is a no-op and the context is the root context).
 *
 * KafkaJS headers are Record<string, Buffer | string | (Buffer | string)[] | undefined>.
 * The TextMapGetter/Setter adapts to that.
 */

import { propagation, context, Context, ROOT_CONTEXT } from '@opentelemetry/api';

// ── TextMapGetter for KafkaJS message headers ────────────────────────────────

type KafkaHeaders = Record<string, Buffer | string | (Buffer | string)[] | undefined>;

const kafkaGetter = {
  get(carrier: KafkaHeaders, key: string): string | undefined {
    const val = carrier[key];
    if (val === undefined || val === null) return undefined;
    if (Buffer.isBuffer(val)) return val.toString('utf8');
    if (typeof val === 'string') return val;
    if (Array.isArray(val)) {
      const first = val[0];
      if (!first) return undefined;
      return Buffer.isBuffer(first) ? first.toString('utf8') : String(first);
    }
    return undefined;
  },
  keys(carrier: KafkaHeaders): string[] {
    return Object.keys(carrier);
  },
};

const kafkaSetter = {
  set(carrier: KafkaHeaders, key: string, value: string): void {
    carrier[key] = value;
  },
};

/**
 * Extract W3C trace context from Kafka message headers.
 *
 * Returns a Context with the parent span context populated (or ROOT_CONTEXT when the
 * headers carry no traceparent — e.g. legacy producers, tests).
 *
 * Usage in eachMessage:
 *   const ctx = extractKafkaTraceContext(message.headers ?? {});
 *   await context.with(ctx, async () => {
 *     // span started here is a child of the producer's span
 *   });
 */
export function extractKafkaTraceContext(headers: KafkaHeaders | null | undefined): Context {
  if (!headers || Object.keys(headers).length === 0) return ROOT_CONTEXT;
  return propagation.extract(ROOT_CONTEXT, headers, kafkaGetter);
}

/**
 * Inject the current W3C trace context into a Kafka header map so the consumer can
 * resume the trace (call from producer side — collector, repull jobs).
 *
 * Usage (producer):
 *   const headers: KafkaHeaders = {};
 *   injectKafkaTraceContext(headers);
 *   await producer.send({ topic, messages: [{ headers, value }] });
 */
export function injectKafkaTraceContext(headers: KafkaHeaders): void {
  propagation.inject(context.active(), headers, kafkaSetter);
}
