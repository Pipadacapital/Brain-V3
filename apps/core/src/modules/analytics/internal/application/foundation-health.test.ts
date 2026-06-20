/**
 * foundation-health.test.ts — the Data Foundation Health readiness verdict (P1).
 *
 * Pins the deterministic, fail-closed tiering and the guided next step. The foundation gates the
 * whole product ("never reach empty/misleading experiences"), so readiness must never be overstated.
 */
import { describe, it, expect } from 'vitest';
import {
  computeFoundationHealth,
  freshnessFromIngest,
  type FoundationSignals,
} from './foundation-health.js';

const NOW = Date.parse('2026-06-20T12:00:00.000Z');

const full: FoundationSignals = {
  pixelInstalled: true,
  commerceConnected: true,
  commerceHealthy: true,
  initialSyncStarted: true,
  firstEventReceived: true,
  freshness: 'live',
  dqTier: 'trusted',
};

describe('freshnessFromIngest', () => {
  it('live < 6h, lagging 6–24h, stale > 24h, unknown when null/invalid', () => {
    expect(freshnessFromIngest('2026-06-20T11:00:00.000Z', NOW)).toBe('live'); // 1h
    expect(freshnessFromIngest('2026-06-20T03:00:00.000Z', NOW)).toBe('lagging'); // 9h
    expect(freshnessFromIngest('2026-06-18T12:00:00.000Z', NOW)).toBe('stale'); // 48h
    expect(freshnessFromIngest(null, NOW)).toBe('unknown');
    expect(freshnessFromIngest('not-a-date', NOW)).toBe('unknown');
  });
  it('treats clock skew (future ingest) as live, never stale', () => {
    expect(freshnessFromIngest('2026-06-20T13:00:00.000Z', NOW)).toBe('live');
  });
});

describe('computeFoundationHealth — tiers (fail-closed)', () => {
  it('blocked when no commerce connection', () => {
    expect(computeFoundationHealth({ ...full, commerceConnected: false }).tier).toBe('blocked');
  });
  it('blocked when no pixel', () => {
    expect(computeFoundationHealth({ ...full, pixelInstalled: false }).tier).toBe('blocked');
  });
  it('building when connected+pixel but no first event', () => {
    expect(computeFoundationHealth({ ...full, firstEventReceived: false }).tier).toBe('building');
  });
  it('building when data is stale', () => {
    expect(computeFoundationHealth({ ...full, freshness: 'stale' }).tier).toBe('building');
  });
  it('ready when fresh + established but DQ only estimated', () => {
    const h = computeFoundationHealth({ ...full, dqTier: 'estimated' });
    expect(h.tier).toBe('ready');
    expect(h.ready).toBe(true);
  });
  it('ready (not healthy) when fresh+trusted but only lagging', () => {
    expect(computeFoundationHealth({ ...full, freshness: 'lagging' }).tier).toBe('ready');
  });
  it('healthy only when trusted + live + commerce healthy', () => {
    const h = computeFoundationHealth(full);
    expect(h.tier).toBe('healthy');
    expect(h.ready).toBe(true);
    expect(h.gaps).toEqual([]);
    expect(h.nextAction).toBeNull();
  });
});

describe('computeFoundationHealth — guidance', () => {
  it('points the next action at the FIRST unmet step', () => {
    const h = computeFoundationHealth({ ...full, pixelInstalled: false });
    expect(h.nextAction?.href).toBe('/settings/pixel');
  });
  it('surfaces an unhealthy commerce link as a distinct gap', () => {
    const h = computeFoundationHealth({ ...full, commerceHealthy: false });
    expect(h.tier).toBe('ready'); // capped below healthy
    expect(h.gaps[0]).toMatch(/Reconnect your store/);
  });
  it('lists every unmet step in the gaps', () => {
    const h = computeFoundationHealth({
      pixelInstalled: true,
      commerceConnected: true,
      commerceHealthy: true,
      initialSyncStarted: false,
      firstEventReceived: false,
      freshness: 'unknown',
      dqTier: 'untrusted',
    });
    expect(h.tier).toBe('building');
    expect(h.gaps).toContain('First data received');
    expect(h.gaps).toContain('Data quality trusted');
  });
});
