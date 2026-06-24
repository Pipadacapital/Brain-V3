/**
 * fx-blend — shared helpers to roll per-currency money up to the brand's PRIMARY currency for the
 * dashboard's "≈ primary currency" convenience view (display only — revenue truth keeps the native
 * per-currency breakdown). Used by the money cards (revenue snapshot, blended ROAS, …) the same way
 * the orders list uses fxRateService. Conversion uses the latest rate, fail-soft.
 */
import type { Pool } from 'pg';
import { withBrandTxn } from '@brain/metric-engine';
import { fxRateService } from './fx-rate-service.js';

/** Read the brand's primary currency (brand.currency_code) under RLS. null on any error (fail-soft). */
export async function resolveBrandPrimaryCurrency(rawPool: Pool, brandId: string): Promise<string | null> {
  try {
    return await withBrandTxn(rawPool, brandId, async (client) => {
      const r = await client.query<{ currency_code: string | null }>(
        `SELECT currency_code FROM brand WHERE id = $1`,
        [brandId],
      );
      return r.rows[0]?.currency_code ?? null;
    });
  } catch {
    return null;
  }
}

/**
 * Sum per-currency minor amounts into the primary currency at the latest rate. Same-currency entries
 * pass through; others convert via fxRateService. Returns null if the primary is unknown OR ANY entry
 * can't be converted (so we never show a misleadingly-partial blend) — the UI then shows native only.
 */
export async function blendToPrimary(
  entries: Array<{ currency: string; minor: string }>,
  primary: string | null,
): Promise<string | null> {
  if (!primary || entries.length === 0) return null;
  let total = 0n;
  for (const e of entries) {
    if (!/^-?\d+$/.test(e.minor)) return null;
    if (e.currency === primary) {
      total += BigInt(e.minor);
      continue;
    }
    const converted = await fxRateService.convertMinorToPrimary(e.minor, e.currency, primary);
    if (converted === null) return null; // honest: don't show a partial blend
    total += BigInt(converted);
  }
  return total.toString();
}

/**
 * Blended ROAS in the primary currency = Σ(converted realized) ÷ Σ(converted spend), as a 2-dp
 * decimal string. null when spend rolls up to 0 (honest — not a ROAS) or a blend can't be computed.
 */
export function roasFromMinor(realizedPrimaryMinor: string | null, spendPrimaryMinor: string | null): string | null {
  if (realizedPrimaryMinor === null || spendPrimaryMinor === null) return null;
  const spend = BigInt(spendPrimaryMinor);
  if (spend === 0n) return null;
  const realized = BigInt(realizedPrimaryMinor);
  // hundredths of x, then format — both sides are in the SAME currency so the minor-unit cancels.
  const hundredths = (realized * 100n) / spend;
  const whole = hundredths / 100n;
  const frac = (hundredths % 100n).toString().padStart(2, '0');
  return `${whole}.${frac}`;
}
