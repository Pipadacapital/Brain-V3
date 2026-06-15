/**
 * OTel span wrapper unit tests (NN-6 integration).
 * Verifies that the startSpan wrapper enforces PII redaction.
 */
import { describe, it, expect } from 'vitest';
import { startSpan } from './index.js';

const CTX = {
  brandId: '22222222-2222-4222-8222-222222222222',
  correlationId: 'trace-abc-123',
  serviceName: 'collector',
};

describe('startSpan — NN-6 PII attribute redaction', () => {
  it('always sets brand_id and correlation_id on every span', () => {
    const span = startSpan('test.operation', CTX) as unknown as {
      _getAttributes(): Record<string, unknown>;
    };
    const attrs = span._getAttributes();
    expect(attrs['brand_id']).toBe(CTX.brandId);
    expect(attrs['correlation_id']).toBe(CTX.correlationId);
    expect(attrs['service.name']).toBe(CTX.serviceName);
  });

  it('drops PII-keyed attributes (NN-6 NEGATIVE CONTROL)', () => {
    const span = startSpan('test.operation', CTX) as unknown as {
      setAttribute(k: string, v: string): unknown;
      _getAttributes(): Record<string, unknown>;
    };

    // Attempt to set PII attributes — these MUST be dropped
    span.setAttribute('email', 'user@example.com');
    span.setAttribute('phone', '9999999999');
    span.setAttribute('name', 'Test User');

    const attrs = span._getAttributes();
    expect('email' in attrs).toBe(false);
    expect('phone' in attrs).toBe(false);
    expect('name' in attrs).toBe(false);
  });

  it('allows safe attributes to pass through', () => {
    const span = startSpan('collector.event.ingest', CTX) as unknown as {
      setAttribute(k: string, v: string | number | boolean): unknown;
      _getAttributes(): Record<string, unknown>;
    };

    span.setAttribute('http.method', 'POST');
    span.setAttribute('http.status_code', 202);
    span.setAttribute('event_name', 'page.viewed');

    const attrs = span._getAttributes();
    expect(attrs['http.method']).toBe('POST');
    expect(attrs['http.status_code']).toBe(202);
    expect(attrs['event_name']).toBe('page.viewed');
  });

  it('NEGATIVE CONTROL: if PII guard is removed, setAttr(email) would appear in attrs', () => {
    // This test verifies the structural guarantee.
    // If the guard is removed: attrs.email = 'user@example.com' (non-empty object entry).
    // With the guard: the email key must be absent.
    const span = startSpan('guard.test', CTX) as unknown as {
      setAttribute(k: string, v: string): unknown;
      _getAttributes(): Record<string, unknown>;
    };
    span.setAttribute('email', 'shouldbedropped@example.com');
    const attrs = span._getAttributes();
    // This assertion FAILS if the PII guard is removed from setAttribute.
    expect(Object.keys(attrs).filter((k) => k === 'email').length).toBe(0);
  });
});
