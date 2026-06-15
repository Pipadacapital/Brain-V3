/**
 * NN-6 redaction unit tests (negative-control DoD).
 *
 * Every test here must FAIL if the redaction logic is removed.
 * These tests are the acceptance gate for NN-6 at the SDK layer.
 */
import { describe, it, expect } from 'vitest';
import { isPiiKey, redactAttributes, redactLogRecord } from './redact.js';

// ── isPiiKey ──────────────────────────────────────────────────────────────────

describe('isPiiKey', () => {
  it('flags exact PII keys (case-insensitive)', () => {
    expect(isPiiKey('email')).toBe(true);
    expect(isPiiKey('Email')).toBe(true);
    expect(isPiiKey('EMAIL')).toBe(true);
    expect(isPiiKey('phone')).toBe(true);
    expect(isPiiKey('name')).toBe(true);
    expect(isPiiKey('address')).toBe(true);
    expect(isPiiKey('ip')).toBe(true);
    expect(isPiiKey('ip_address')).toBe(true);
    expect(isPiiKey('dob')).toBe(true);
    expect(isPiiKey('pan')).toBe(true);
    expect(isPiiKey('card_number')).toBe(true);
    expect(isPiiKey('cvv')).toBe(true);
  });

  it('flags PII prefix patterns', () => {
    expect(isPiiKey('email_hash')).toBe(true);
    expect(isPiiKey('pan_number')).toBe(true);
    expect(isPiiKey('card_last4')).toBe(true);
    expect(isPiiKey('pii_value')).toBe(true);
    expect(isPiiKey('contact_email')).toBe(true);
  });

  it('flags PII suffix patterns', () => {
    expect(isPiiKey('user_email')).toBe(true);
    expect(isPiiKey('billing_address')).toBe(true);
    expect(isPiiKey('primary_phone')).toBe(true);
    expect(isPiiKey('contact_mobile')).toBe(true);
    expect(isPiiKey('shipping_address')).toBe(true);
  });

  it('does NOT flag safe keys', () => {
    expect(isPiiKey('brand_id')).toBe(false);
    expect(isPiiKey('correlation_id')).toBe(false);
    expect(isPiiKey('event_id')).toBe(false);
    expect(isPiiKey('metric_id')).toBe(false);
    expect(isPiiKey('hashed_user_id')).toBe(false);
    // service.name and event_name are OTel semantic convention keys — NOT PII
    expect(isPiiKey('service.name')).toBe(false);
    expect(isPiiKey('service_name')).toBe(false);
    expect(isPiiKey('event_name')).toBe(false);
    expect(isPiiKey('http.method')).toBe(false);
    expect(isPiiKey('request_id')).toBe(false);
    expect(isPiiKey('duration_ms')).toBe(false);
    expect(isPiiKey('span.name')).toBe(false);
  });
});

// ── redactAttributes ──────────────────────────────────────────────────────────

describe('redactAttributes — NN-6 span attribute PII wrapper', () => {
  it('drops PII-keyed attributes from a span attributes dict', () => {
    const input = {
      brand_id: '22222222-2222-4222-8222-222222222222',
      correlation_id: 'trace-abc-123',
      email: 'user@example.com',           // PII — MUST be dropped
      'http.method': 'POST',
      user_email: 'other@example.com',     // PII — MUST be dropped
    };

    const result = redactAttributes(input);

    // Safe keys pass through
    expect(result['brand_id']).toBe(input.brand_id);
    expect(result['correlation_id']).toBe(input.correlation_id);
    expect(result['http.method']).toBe('POST');

    // PII keys are dropped (not present, not '[REDACTED]' — dropped entirely)
    expect('email' in result).toBe(false);
    expect('user_email' in result).toBe(false);
  });

  it('passes through a clean attributes dict unchanged', () => {
    const input = {
      brand_id: 'uuid-1',
      service_name: 'collector',
      duration_ms: 42,
      success: true,
    };
    const result = redactAttributes(input);
    expect(result).toEqual(input);
  });

  it('NEGATIVE CONTROL: if redactAttributes is a passthrough, PII keys would be present — proving the guard fires', () => {
    // This test structurally validates that the attributes object with PII keys
    // becomes SMALLER after redaction. If the function is disabled/bypassed,
    // the lengths would be equal and the test fails.
    const withPii = {
      email: 'test@example.com',
      brand_id: 'uuid-1',
      phone: '9999999999',
    };
    const result = redactAttributes(withPii);
    expect(Object.keys(result).length).toBeLessThan(Object.keys(withPii).length);
    expect('email' in result).toBe(false);
    expect('phone' in result).toBe(false);
  });
});

// ── redactLogRecord ───────────────────────────────────────────────────────────

describe('redactLogRecord — logger PII redaction', () => {
  it('replaces PII values with [REDACTED]', () => {
    const record = {
      level: 'info',
      msg: 'User registered',
      brand_id: 'uuid-1',
      email: 'test@example.com',
      request_id: 'req-123',
    };

    const result = redactLogRecord(record);

    expect(result['email']).toBe('[REDACTED]');
    expect(result['brand_id']).toBe('uuid-1');
    expect(result['level']).toBe('info');
    expect(result['request_id']).toBe('req-123');
  });

  it('recursively redacts nested PII', () => {
    const record = {
      brand_id: 'uuid-1',
      user: {
        email: 'test@example.com',
        hashed_user_id: 'abc123',
      },
    };

    const result = redactLogRecord(record);
    const user = result['user'] as Record<string, unknown>;

    expect(user['email']).toBe('[REDACTED]');
    expect(user['hashed_user_id']).toBe('abc123');
  });
});
