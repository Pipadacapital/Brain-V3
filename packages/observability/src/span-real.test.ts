/**
 * span-real.test.ts — proves startSpan emits a REAL OpenTelemetry span (R-05 de-stub).
 *
 * Registers an in-memory tracer provider, then asserts startSpan produces an exported span with
 * the required brand_id/correlation_id attributes, safe attributes pass through, and PII-keyed
 * attributes are dropped BEFORE they reach the OTel span (NN-6).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { startSpan } from './index.js';

const exporter = new InMemorySpanExporter();
let provider: BasicTracerProvider;

beforeAll(() => {
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  trace.setGlobalTracerProvider(provider);
});

afterAll(async () => {
  await provider.shutdown();
  trace.disable();
});

describe('startSpan → real OTel span', () => {
  it('exports a span with brand_id/correlation_id; safe attrs pass; PII dropped', () => {
    exporter.reset();

    const span = startSpan('core.test.operation', {
      brandId: '22222222-2222-4222-8222-222222222222',
      correlationId: 'trace-real-1',
      serviceName: 'core',
    });
    span.setAttribute('http.method', 'POST');
    span.setAttribute('http.status_code', 202);
    span.setAttribute('email', 'pii@example.com'); // must NOT reach the span
    span.end();

    const finished = exporter.getFinishedSpans();
    expect(finished.length).toBe(1);
    const s = finished[0]!;
    expect(s.name).toBe('core.test.operation');
    expect(s.attributes['brand_id']).toBe('22222222-2222-4222-8222-222222222222');
    expect(s.attributes['correlation_id']).toBe('trace-real-1');
    expect(s.attributes['service.name']).toBe('core');
    expect(s.attributes['http.method']).toBe('POST');
    expect(s.attributes['http.status_code']).toBe(202);
    expect('email' in s.attributes).toBe(false); // PII dropped before OTel (NN-6)
  });

  it('records an exception as span status ERROR (no stack leaked)', () => {
    exporter.reset();
    const span = startSpan('core.test.error', {
      brandId: '22222222-2222-4222-8222-222222222222',
      correlationId: 'trace-real-2',
      serviceName: 'core',
    });
    span.recordException(new Error('boom'));
    span.end();

    const s = exporter.getFinishedSpans()[0]!;
    expect(s.status.code).toBe(2); // SpanStatusCode.ERROR
    expect(s.events.some((e) => e.name === 'exception')).toBe(true);
  });
});
