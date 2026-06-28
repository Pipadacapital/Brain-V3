/**
 * Unit tests for the tracking-status derivation — the load-bearing HONESTY logic
 * behind the Live Verification flip + the Tracking Health status badge.
 *
 * The single rule under test: "received"/"healthy" is shown ONLY when a real Bronze
 * event has landed; nothing is ever faked.
 */

import { describe, it, expect } from 'vitest';
import {
  deriveTrackingStatus,
  hasFirstEvent,
  STALE_THRESHOLD_MS,
} from './tracking-status';
import type { AnalyticsTrackingHealthResponse } from '@/lib/api/types';

const NOW = Date.parse('2026-06-18T12:00:00Z');

function hasData(
  overrides: Partial<Extract<AnalyticsTrackingHealthResponse, { state: 'has_data' }>> = {},
): AnalyticsTrackingHealthResponse {
  return {
    state: 'has_data',
    firstEventReceived: true,
    eventVolume: [],
    lastEventAt: new Date(NOW - 60_000).toISOString(), // 1 min ago by default
    totalEvents: '5',
    consentGrantedCount: '3',
    consentTotalCount: '4',
    clientDroppedCount: '0',
    ...overrides,
  };
}

describe('hasFirstEvent', () => {
  it('is false while loading (undefined)', () => {
    expect(hasFirstEvent(undefined)).toBe(false);
  });

  it('is false for no_data — never faked', () => {
    expect(hasFirstEvent({ state: 'no_data' })).toBe(false);
  });

  it('is true only when a real Bronze event exists (has_data)', () => {
    expect(hasFirstEvent(hasData())).toBe(true);
  });
});

describe('deriveTrackingStatus', () => {
  it('waiting while loading', () => {
    expect(deriveTrackingStatus(undefined, NOW)).toBe('waiting');
  });

  it('waiting for no_data (honest — no green without an event)', () => {
    expect(deriveTrackingStatus({ state: 'no_data' }, NOW)).toBe('waiting');
  });

  it('healthy for a recent event', () => {
    expect(deriveTrackingStatus(hasData({ lastEventAt: new Date(NOW - 1000).toISOString() }), NOW)).toBe(
      'healthy',
    );
  });

  it('stale when the last event is older than the threshold', () => {
    const old = new Date(NOW - STALE_THRESHOLD_MS - 60_000).toISOString();
    expect(deriveTrackingStatus(hasData({ lastEventAt: old }), NOW)).toBe('stale');
  });

  it('healthy (not faked-stale) when has_data but lastEventAt is null', () => {
    expect(deriveTrackingStatus(hasData({ lastEventAt: null }), NOW)).toBe('healthy');
  });

  it('healthy when has_data but lastEventAt is unparseable (does not crash)', () => {
    expect(deriveTrackingStatus(hasData({ lastEventAt: 'not-a-date' }), NOW)).toBe('healthy');
  });
});
