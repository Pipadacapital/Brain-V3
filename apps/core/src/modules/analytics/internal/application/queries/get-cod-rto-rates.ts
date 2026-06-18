/**
 * getCodRtoRates — analytics use-case (ADR-002 sole-read-path, GoKwik Track C).
 *
 * @effort deterministic
 *
 * Thin query wrapper around computeCodRtoRates (metric engine). It does NO ad-hoc
 * COUNT — the named seam owns the aggregation (D-3). This module only serializes
 * bigint → string for JSON safety (D-1) and shapes the honest no_data discriminant.
 *
 * Honest-empty (D-2): state='no_data' when the brand has NO terminal AWB Bronze row.
 * Driven by the engine's hasData flag, NOT a zero value.
 *
 * DEV-HONESTY: data_source is passed through ('synthetic' in dev — real shape, synthetic
 * source until partner sandbox) so the BFF/UI can render the Synthetic (dev) badge.
 * pincode_pending is passed through so the UI can show an honest "pincode pending partner
 * data" note instead of fabricating a cohort split.
 *
 * RLS / F-SEC-02: the engine reads inside withBrandTxn. Brand from session (D-1).
 *
 * @see packages/metric-engine/src/cod-rto-rates.ts
 */

import type { EngineDeps } from '@brain/metric-engine';
import { computeCodRtoRates } from '@brain/metric-engine';

export interface CodRtoCohortDto {
  pincode: string;
  terminal_count: string; // bigint → string
  rto_count: string;      // bigint → string
  rto_rate_pct: string | null;
}

export type CodRtoRatesResult =
  | { state: 'no_data' }
  | {
      state: 'has_data';
      overall_rto_rate_pct: string | null;
      total_terminal: string; // bigint → string
      total_rto: string;      // bigint → string
      cohorts: CodRtoCohortDto[];
      data_source: 'synthetic' | 'live';
      pincode_pending: boolean;
    };

/**
 * getCodRtoRates — returns a brand's RTO-rate cohort breakdown.
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param deps    - EngineDeps with raw pg.Pool.
 */
export async function getCodRtoRates(
  brandId: string,
  deps: EngineDeps,
): Promise<CodRtoRatesResult> {
  const result = await computeCodRtoRates(brandId, deps);

  if (!result.hasData) {
    return { state: 'no_data' };
  }

  return {
    state: 'has_data',
    overall_rto_rate_pct: result.overallRtoRatePct,
    total_terminal: String(result.totalTerminal),
    total_rto: String(result.totalRto),
    cohorts: result.cohorts.map((c) => ({
      pincode: c.pincode,
      terminal_count: String(c.terminalCount),
      rto_count: String(c.rtoCount),
      rto_rate_pct: c.rtoRatePct,
    })),
    data_source: result.dataSource,
    pincode_pending: result.pincodePending,
  };
}
