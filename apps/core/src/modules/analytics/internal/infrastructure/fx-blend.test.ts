/**
 * fx-blend tests — roasFromMinor (pure) + blendToPrimary (same-currency passthrough + fail-soft).
 * Cross-currency conversion is covered by fx-rate-service.test.ts; here we mock fetch for one case.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { blendToPrimary, roasFromMinor } from './fx-blend.js';
import { __resetFxRateCacheForTests } from './fx-rate-service.js';

describe('roasFromMinor', () => {
  it('computes a 2-dp ROAS (same currency → minor cancels)', () => {
    expect(roasFromMinor('317245514', '704611077')).toBe('0.45'); // the live blended_roas case
    expect(roasFromMinor('200000', '100000')).toBe('2.00');
  });
  it('is null on zero spend (not a ROAS) or missing input', () => {
    expect(roasFromMinor('100', '0')).toBeNull();
    expect(roasFromMinor(null, '100')).toBeNull();
    expect(roasFromMinor('100', null)).toBeNull();
  });
});

describe('blendToPrimary', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => __resetFxRateCacheForTests());
  afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });

  it('passes same-currency entries through with no network call', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('should not fetch'); }) as typeof fetch;
    expect(await blendToPrimary([{ currency: 'INR', minor: '500' }, { currency: 'INR', minor: '250' }], 'INR')).toBe('750');
  });

  it('returns null when primary is unknown or no entries', async () => {
    expect(await blendToPrimary([{ currency: 'INR', minor: '1' }], null)).toBeNull();
    expect(await blendToPrimary([], 'INR')).toBeNull();
  });

  it('blends a foreign currency at the latest rate', async () => {
    // base=INR, rates[AED]=0.044 (AED per 1 INR). 4400 AED minor = 44.00 AED → /0.044 = 1000 INR → 100000 paise.
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ result: 'success', rates: { AED: 0.044 } }) }) as unknown as Response) as typeof fetch;
    // 200000 INR paise (passthrough) + 4400 AED minor → +100000 paise = 300000.
    expect(await blendToPrimary([{ currency: 'INR', minor: '200000' }, { currency: 'AED', minor: '4400' }], 'INR')).toBe('300000');
  });

  it('returns null (no partial blend) when a currency cannot be converted', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ result: 'success', rates: { /* no USD */ } }) }) as unknown as Response) as typeof fetch;
    expect(await blendToPrimary([{ currency: 'INR', minor: '100' }, { currency: 'USD', minor: '50' }], 'INR')).toBeNull();
  });
});
