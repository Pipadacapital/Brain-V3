/**
 * fx-rate-service tests — conversion math + fail-soft posture. fetch is mocked (no network).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFxRateService, __resetFxRateCacheForTests } from './fx-rate-service.js';

function mockFetchRates(ratesByBase: Record<string, Record<string, number> | 'fail'>) {
  return vi.fn(async (url: string) => {
    const base = decodeURIComponent(String(url).split('/').pop() ?? '');
    const r = ratesByBase[base];
    if (!r || r === 'fail') return { ok: false, json: async () => ({}) } as unknown as Response;
    return { ok: true, json: async () => ({ result: 'success', rates: r }) } as unknown as Response;
  });
}

describe('fxRateService.convertMinorToPrimary', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    __resetFxRateCacheForTests(); // the rate cache is module-global (prod-correct); clear per test
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('returns null for the same currency (no conversion needed)', async () => {
    const fx = createFxRateService();
    expect(await fx.convertMinorToPrimary('99900', 'INR', 'INR')).toBeNull();
  });

  it('converts USD → INR at the latest rate (2-decimal target)', async () => {
    // base=INR, rates[USD] = USD per 1 INR = 0.0125  → 1 USD = 80 INR
    globalThis.fetch = mockFetchRates({ INR: { USD: 0.0125 } }) as typeof fetch;
    const fx = createFxRateService();
    // 8900 USD minor = $89.00 → /0.0125 = 7120.00 INR → 712000 paise
    expect(await fx.convertMinorToPrimary('8900', 'USD', 'INR')).toBe('712000');
  });

  it('converts into a 3-decimal target currency (KWD)', async () => {
    // base=KWD, rates[INR] = INR per 1 KWD = 250  → 1 INR = 0.004 KWD
    globalThis.fetch = mockFetchRates({ KWD: { INR: 250 } }) as typeof fetch;
    const fx = createFxRateService();
    // 80000 INR minor = 800.00 INR → /250 = 3.2 KWD → 3200 fils (3 decimals)
    expect(await fx.convertMinorToPrimary('80000', 'INR', 'KWD')).toBe('3200');
  });

  it('is fail-soft: provider error → null (caller shows native only)', async () => {
    globalThis.fetch = mockFetchRates({ INR: 'fail' }) as typeof fetch;
    const fx = createFxRateService();
    expect(await fx.convertMinorToPrimary('8900', 'USD', 'INR')).toBeNull();
  });

  it('returns null when the rate for the source currency is absent', async () => {
    globalThis.fetch = mockFetchRates({ INR: { AED: 0.044 } }) as typeof fetch; // no USD
    const fx = createFxRateService();
    expect(await fx.convertMinorToPrimary('8900', 'USD', 'INR')).toBeNull();
  });

  it('returns null for a malformed minor amount', async () => {
    const fx = createFxRateService();
    expect(await fx.convertMinorToPrimary('12.5', 'USD', 'INR')).toBeNull();
  });
});
