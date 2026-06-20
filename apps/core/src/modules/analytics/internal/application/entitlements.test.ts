/**
 * entitlements.test.ts — readiness-driven progressive unlock (P2).
 *
 * Pins the connector-general unlock matrix: centers + connector categories unlock only when the data
 * foundation can support them (fail-closed). This is the server source of truth the nav + marketplace
 * consume — gating is never hardcoded in the client.
 */
import { describe, it, expect } from 'vitest';
import { computeEntitlements, type EntitlementInput } from './entitlements.js';
import type { FoundationSignals } from './foundation-health.js';

const fullSignals: FoundationSignals = {
  pixelInstalled: true,
  commerceConnected: true,
  commerceHealthy: true,
  initialSyncStarted: true,
  firstEventReceived: true,
  freshness: 'live',
  dqTier: 'trusted',
};

const blankSignals: FoundationSignals = {
  pixelInstalled: false,
  commerceConnected: false,
  commerceHealthy: false,
  initialSyncStarted: false,
  firstEventReceived: false,
  freshness: 'unknown',
  dqTier: 'untrusted',
};

const center = (e: ReturnType<typeof computeEntitlements>, key: string) =>
  e.centers.find((c) => c.key === key)!;
const cat = (e: ReturnType<typeof computeEntitlements>, key: string) =>
  e.connectorCategories.find((c) => c.key === key)!;

describe('computeEntitlements — centers', () => {
  it('locks every gated center on a blank foundation, with reason + unlock hint', () => {
    const e = computeEntitlements({ tier: 'blocked', signals: blankSignals });
    for (const key of ['identity', 'journey', 'attribution', 'decision']) {
      const c = center(e, key);
      expect(c.eligible).toBe(false);
      expect(c.reason).toBeTruthy();
      expect(c.unlockHint).toBeTruthy();
    }
  });

  it('unlocks identity + journey once events flow, but holds attribution/decision until ready', () => {
    const e = computeEntitlements({
      tier: 'building',
      signals: { ...blankSignals, commerceConnected: true, pixelInstalled: true, firstEventReceived: true },
    });
    expect(center(e, 'identity').eligible).toBe(true);
    expect(center(e, 'journey').eligible).toBe(true);
    expect(center(e, 'attribution').eligible).toBe(false); // needs ready
    expect(center(e, 'decision').eligible).toBe(false);
  });

  it('unlocks all centers on a ready foundation', () => {
    const e = computeEntitlements({ tier: 'ready', signals: fullSignals });
    for (const key of ['identity', 'journey', 'attribution', 'decision']) {
      expect(center(e, key).eligible).toBe(true);
      expect(center(e, key).reason).toBeNull();
    }
  });
});

describe('computeEntitlements — connector categories (general, not per-app)', () => {
  it('storefront is always eligible (the foundation root)', () => {
    expect(cat(computeEntitlements({ tier: 'blocked', signals: blankSignals }), 'storefront').eligible).toBe(true);
  });

  it('payments + logistics need a storefront connected', () => {
    const before = computeEntitlements({ tier: 'blocked', signals: blankSignals });
    expect(cat(before, 'payments').eligible).toBe(false);
    expect(cat(before, 'logistics').eligible).toBe(false);
    expect(cat(before, 'payments').unlockHint).toMatch(/storefront/i);

    const after = computeEntitlements({ tier: 'building', signals: { ...blankSignals, commerceConnected: true } });
    expect(cat(after, 'payments').eligible).toBe(true);
    expect(cat(after, 'logistics').eligible).toBe(true);
  });

  it('ads need an established foundation (store + pixel + first event)', () => {
    const storeOnly = computeEntitlements({ tier: 'building', signals: { ...blankSignals, commerceConnected: true } });
    expect(cat(storeOnly, 'ads').eligible).toBe(false);

    const established = computeEntitlements({
      tier: 'building',
      signals: { ...blankSignals, commerceConnected: true, pixelInstalled: true, firstEventReceived: true },
    });
    expect(cat(established, 'ads').eligible).toBe(true);
  });

  it('crm + analytics carry no readiness gate (always eligible — availability handles them)', () => {
    const e = computeEntitlements({ tier: 'blocked', signals: blankSignals });
    expect(cat(e, 'crm').eligible).toBe(true);
    expect(cat(e, 'analytics').eligible).toBe(true);
  });

  it('returns an entry for every category', () => {
    const e = computeEntitlements({ tier: 'healthy', signals: fullSignals });
    expect(e.connectorCategories.map((c) => c.key).sort()).toEqual(
      ['ads', 'analytics', 'crm', 'logistics', 'messaging', 'payments', 'storefront'],
    );
  });
});
