/**
 * connector-auth-health.unit.test.ts — P2.6: the connector auth-rejection signal.
 *
 * Proves recordConnectorAuthRejected emits connector_auth_rejected_total labelled by provider, via
 * the observability counter sink seam (no broker / no real meter). This is the signal that turns a
 * silent token-expiry death (sync_status='error' + return, scheduler sees success) into a loud,
 * per-connector, alertable metric.
 */
import { describe, it, expect } from 'vitest';
import { setCounterSink, type CounterLabels } from '@brain/observability';
import { recordConnectorAuthRejected } from '../infrastructure/observability/connector-auth-health.js';

describe('recordConnectorAuthRejected (P2.6)', () => {
  it('emits connector_auth_rejected_total with the provider label', () => {
    const recorded: Array<{ name: string; value: number; labels: CounterLabels }> = [];
    const restore = setCounterSink({ add: (name, value, labels) => recorded.push({ name, value, labels }) });
    try {
      recordConnectorAuthRejected('meta');
      recordConnectorAuthRejected('google_ads');
      recordConnectorAuthRejected('meta');
    } finally {
      restore();
    }
    expect(recorded.map((r) => r.name)).toEqual([
      'connector_auth_rejected_total',
      'connector_auth_rejected_total',
      'connector_auth_rejected_total',
    ]);
    expect(recorded.map((r) => r.labels['provider'])).toEqual(['meta', 'google_ads', 'meta']);
    // each rejection counts once
    expect(recorded.every((r) => r.value === 1)).toBe(true);
  });
});
