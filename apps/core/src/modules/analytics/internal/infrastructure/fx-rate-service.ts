/**
 * fx-rate-service — latest FX rates for the dashboard "convert to primary currency" view.
 *
 * DISPLAY-ONLY (revenue truth): this NEVER mutates a stored amount. Bronze/Silver/ledgers keep each
 * record's ORIGINAL currency + minor units; this produces an APPROXIMATE convenience value in the
 * brand's primary currency, computed at the LATEST rate and clearly labelled "≈ approx" in the UI.
 *
 * Posture:
 *   - Free, no-key provider: open.er-api.com (broad coverage incl INR + all GCC: AED/SAR/QAR/KWD/
 *     BHD/OMR). Fetched server-side, never per-row from the browser.
 *   - Cached per base currency for CACHE_TTL_MS (default 12h) — steady-state requests touch no
 *     network. A single in-flight fetch per base is de-duped (no thundering herd).
 *   - FAIL-SOFT: any fetch/parse error or a missing rate → null. The caller then shows the native
 *     amount only (never a crash, never a wrong number).
 *   - Money math: integer minor units in/out via the per-currency exponent (@brain/money). The
 *     intermediate ratio is a float (display value), rounded to whole target minor units.
 */
import { minorUnitsDivisor } from '@brain/money';

const PROVIDER_URL = (base: string): string => `https://open.er-api.com/v6/latest/${encodeURIComponent(base)}`;
// intentional: module-load constants. Fields exist in @brain/config (FX_CACHE_TTL_MS/FX_FETCH_TIMEOUT_MS)
// but loadCoreConfig() at module-load validates the full schema + process.exit(1)s on missing env,
// which would crash standalone unit imports. Left raw to preserve zero import-time behaviour change.
const CACHE_TTL_MS = Number(process.env['FX_CACHE_TTL_MS'] ?? 12 * 60 * 60 * 1000);
const FETCH_TIMEOUT_MS = Number(process.env['FX_FETCH_TIMEOUT_MS'] ?? 8000);

interface RateEntry {
  rates: Record<string, number>; // units of <code> per 1 <base>
  fetchedAt: number;
}

const cache = new Map<string, RateEntry>();
const inFlight = new Map<string, Promise<RateEntry | null>>();

/** Fetch + cache the rate table for `base`. Fail-soft → null. De-dupes concurrent fetches. */
async function getRatesFor(base: string): Promise<RateEntry | null> {
  const key = base.toUpperCase();
  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached;

  const existing = inFlight.get(key);
  if (existing) return existing;

  const p = (async (): Promise<RateEntry | null> => {
    try {
      const res = await fetch(PROVIDER_URL(key), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) return cached ?? null; // serve stale on a transient provider error
      const body = (await res.json()) as { result?: string; rates?: Record<string, number> };
      if (body.result !== 'success' || !body.rates) return cached ?? null;
      const entry: RateEntry = { rates: body.rates, fetchedAt: Date.now() };
      cache.set(key, entry);
      return entry;
    } catch {
      return cached ?? null; // network/timeout → stale if we have it, else no conversion
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, p);
  return p;
}

export interface FxRateService {
  /**
   * Convert `amountMinor` (integer minor-unit string) from `from` → `primary`, returning the
   * approximate target amount as an integer minor-unit string, or null if no conversion is possible
   * (same currency handled by the caller; unknown rate; provider down). Latest rate; display-only.
   */
  convertMinorToPrimary(amountMinor: string, from: string, primary: string): Promise<string | null>;
}

export function createFxRateService(): FxRateService {
  return {
    async convertMinorToPrimary(amountMinor, from, primary): Promise<string | null> {
      const fromCode = (from ?? '').toUpperCase();
      const primaryCode = (primary ?? '').toUpperCase();
      if (!fromCode || !primaryCode || fromCode === primaryCode) return null;
      if (!/^-?\d+$/.test(amountMinor)) return null;

      const entry = await getRatesFor(primaryCode);
      const rate = entry?.rates[fromCode]; // units of `from` per 1 `primary`
      if (!rate || rate <= 0) return null;

      // from minor → from major → primary major (÷ rate) → primary minor (round to whole minor unit)
      const fromMajor = Number(BigInt(amountMinor)) / minorUnitsDivisor(fromCode);
      const primaryMajor = fromMajor / rate;
      const primaryMinor = Math.round(primaryMajor * minorUnitsDivisor(primaryCode));
      if (!Number.isFinite(primaryMinor)) return null;
      return String(primaryMinor);
    },
  };
}

/** Process-wide singleton (the cache is shared across requests). */
export const fxRateService: FxRateService = createFxRateService();

/** TEST-ONLY: clear the shared rate cache so unit tests don't leak state across cases. */
export function __resetFxRateCacheForTests(): void {
  cache.clear();
  inFlight.clear();
}
