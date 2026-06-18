/**
 * getCodMix — analytics use-case (ADR-002 sole-read-path, GoKwik Track C).
 *
 * @effort deterministic
 *
 * Thin query wrapper around computeCodMix (metric engine). NO ad-hoc SUM (D-3) —
 * the named seam owns the ledger aggregation. Serializes bigint → string (D-1) and
 * shapes the honest no_data discriminant.
 *
 * Money: every amount is a bigint-serialized minor-unit string. cod_rto_clawback_minor
 * is a POSITIVE magnitude (UI renders "− ₹X"); cod_net_minor may be negative (when RTO
 * clawback exceeds delivered — a genuine loss, rendered honestly, never clamped to 0).
 *
 * DEV-HONESTY: the synthetic flag is supplied by the caller (BFF) based on the AWB
 * connector data source — the ledger does not carry a per-row data_source. We do not
 * invent a flag here; we surface the engine's hasData honestly.
 *
 * RLS / F-SEC-02: engine reads inside withBrandTxn. Brand from session (D-1).
 *
 * @see packages/metric-engine/src/cod-mix.ts
 */

import type { EngineDeps } from '@brain/metric-engine';
import { computeCodMix } from '@brain/metric-engine';

export type CodMixResult =
  | { state: 'no_data' }
  | {
      state: 'has_data';
      currency_code: string;
      cod_delivered_minor: string;     // bigint → string (gross delivered credit)
      cod_rto_clawback_minor: string;  // bigint → string (POSITIVE magnitude)
      cod_net_minor: string;           // bigint → string (may be negative — honest)
      prepaid_minor: string;           // bigint → string
      cod_share_pct: string | null;
    };

/**
 * getCodMix — returns a brand's CoD CM2 + CoD-vs-prepaid mix.
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param deps    - EngineDeps with raw pg.Pool.
 */
export async function getCodMix(
  brandId: string,
  deps: EngineDeps,
): Promise<CodMixResult> {
  const result = await computeCodMix(brandId, deps);

  if (!result.hasData || result.currencyCode === null) {
    return { state: 'no_data' };
  }

  return {
    state: 'has_data',
    currency_code: result.currencyCode,
    cod_delivered_minor: String(result.codDeliveredMinor),
    cod_rto_clawback_minor: String(result.codRtoClawbackMinor),
    cod_net_minor: String(result.codNetMinor),
    prepaid_minor: String(result.prepaidMinor),
    cod_share_pct: result.codSharePct,
  };
}
