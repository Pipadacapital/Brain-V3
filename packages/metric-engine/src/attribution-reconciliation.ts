/**
 * @brain/metric-engine — attribution_reconciliation_rate + channel-contribution (Tier-0).
 *
 * Reads via the NAMED ledger seams only (no ad-hoc SUM — ADR-002 / D-3):
 *   • attributed_gmv_as_of(brand, model, as_of)        — Σ credited_revenue_minor (net of clawback)
 *   • realized_gmv_as_of(brand, as_of)                 — the existing realized-revenue seam (0018)
 *   • channel_contribution_as_of(brand, model, from, to) — (channel, currency, contribution_minor)
 *
 * ── attribution_reconciliation_rate (METRICS.md) ──────────────────────────────
 *   rate = (attributed_gmv_minor / realized_gmv_minor) × 100, NUMERIC(5,2),
 *   integer-basis-point math (the ratePct pattern; NEVER float). The UNATTRIBUTED
 *   residual = realized − attributed is ALWAYS returned alongside and rendered.
 *
 * ── THE CLOSED-SUM ORACLE (the acceptance gate) ───────────────────────────────
 *   Σ channel_contribution_minor + unattributed_minor = realized_gmv_minor.
 *   This module exposes the per-channel contributions + the residual so the parity
 *   oracle (and the UI) can assert/render it. SAME-CURRENCY ONLY (the brand currency).
 *
 * F-SEC-02: all reads inside withBrandTxn (GUC transaction-scoped). The seams are
 * SECURITY INVOKER → RLS scopes them to the active brand.
 *
 * @see 05-architecture.md §5
 * @see METRICS.md row `attribution_reconciliation_rate`
 */

import type { EngineDeps } from './deps.js';
import { withBrandTxn } from './deps.js';
import type { AttributionModelId } from './attribution-models.js';

/** Exact 2-decimal percentage from two bigint magnitudes (integer math; null on ≤0 denom). */
function ratePct(numerator: bigint, denominator: bigint): string | null {
  if (denominator <= 0n) return null;
  const bps = (numerator * 10000n) / denominator;
  const whole = bps / 100n;
  const frac = bps % 100n;
  const absFrac = frac < 0n ? -frac : frac;
  return `${whole}.${String(absFrac).padStart(2, '0')}`;
}

export interface ChannelContribution {
  channel: string;
  currencyCode: string;
  /** Σ credited_revenue_minor for the channel (net of clawback), signed BIGINT. */
  contributionMinor: bigint;
}

export interface AttributionReconciliationResult {
  /** True iff the brand has realized revenue in the window. */
  hasData: boolean;
  currencyCode: string | null;
  /** Σ credited_revenue_minor (net of clawback) for the model, as-of `to`, windowed. */
  attributedGmvMinor: bigint;
  /** Realized GMV in the window (the parity-oracle RHS). */
  realizedGmvMinor: bigint;
  /** ALWAYS rendered: realized − attributed (the unattributed residual). */
  unattributedMinor: bigint;
  /** attributed ÷ realized × 100, 2dp string; null when realized ≤ 0 (honest). */
  reconciliationRatePct: string | null;
  /** Per-channel contributions (for the UI + the closed-sum oracle). */
  byChannel: ChannelContribution[];
}

interface ScalarRow { v: string | null }
interface ChannelRow { channel: string; currency_code: string; contribution_minor: string }

/**
 * computeAttributionReconciliationRate — the reconciliation rate + residual + channels.
 *
 * Window-attributed = attributed_gmv_as_of(to) − attributed_gmv_as_of(from−1) (both exact
 * BIGINT, so the difference is exact); window-realized = realized_gmv_as_of(to) −
 * realized_gmv_as_of(from−1) (the same windowing as blended_roas). The residual is
 * realized − attributed (always rendered, never hidden — METRICS.md §Rules).
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER body).
 * @param params  - { model, fromDate, toDate } inclusive window.
 * @param deps    - EngineDeps with the pg.Pool.
 */
export async function computeAttributionReconciliationRate(
  brandId: string,
  params: { model: AttributionModelId; fromDate: Date; toDate: Date },
  deps: EngineDeps,
): Promise<AttributionReconciliationResult> {
  const toStr = params.toDate.toISOString().split('T')[0] as string;
  const fromStr = params.fromDate.toISOString().split('T')[0] as string;
  const fromMinus1 = new Date(params.fromDate.getTime() - 24 * 60 * 60 * 1000);
  const fromMinus1Str = fromMinus1.toISOString().split('T')[0] as string;

  return withBrandTxn(deps.pool, brandId, async (client) => {
    const brandRow = await client.query<{ currency_code: string }>(
      `SELECT currency_code FROM brand WHERE id = $1`,
      [brandId],
    );
    const currencyCode = brandRow.rows[0]?.currency_code ?? null;

    // Realized (window) via the existing realized_gmv_as_of seam.
    const realizedTo = await client.query<ScalarRow>(
      `SELECT realized_gmv_as_of($1::uuid, $2::date) AS v`,
      [brandId, toStr],
    );
    const realizedBefore = await client.query<ScalarRow>(
      `SELECT realized_gmv_as_of($1::uuid, $2::date) AS v`,
      [brandId, fromMinus1Str],
    );
    const realizedGmvMinor =
      BigInt(realizedTo.rows[0]?.v ?? '0') - BigInt(realizedBefore.rows[0]?.v ?? '0');

    // Attributed (window) via the attributed_gmv_as_of seam (net of clawback).
    const attributedTo = await client.query<ScalarRow>(
      `SELECT attributed_gmv_as_of($1::uuid, $2::text, $3::date) AS v`,
      [brandId, params.model, toStr],
    );
    const attributedBefore = await client.query<ScalarRow>(
      `SELECT attributed_gmv_as_of($1::uuid, $2::text, $3::date) AS v`,
      [brandId, params.model, fromMinus1Str],
    );
    const attributedGmvMinor =
      BigInt(attributedTo.rows[0]?.v ?? '0') - BigInt(attributedBefore.rows[0]?.v ?? '0');

    // Per-channel contributions via the channel_contribution_as_of seam.
    const channelRows = await client.query<ChannelRow>(
      `SELECT channel, currency_code, contribution_minor
         FROM channel_contribution_as_of($1::uuid, $2::text, $3::date, $4::date)`,
      [brandId, params.model, fromStr, toStr],
    );
    const byChannel: ChannelContribution[] = channelRows.rows
      .map((r) => ({
        channel: r.channel,
        currencyCode: r.currency_code,
        contributionMinor: BigInt(r.contribution_minor),
      }))
      .sort((a, b) => (a.channel < b.channel ? -1 : a.channel > b.channel ? 1 : 0));

    const unattributedMinor = realizedGmvMinor - attributedGmvMinor;

    return {
      hasData: realizedGmvMinor !== 0n || attributedGmvMinor !== 0n,
      currencyCode,
      attributedGmvMinor,
      realizedGmvMinor,
      unattributedMinor,
      reconciliationRatePct: ratePct(attributedGmvMinor, realizedGmvMinor),
      byChannel,
    };
  });
}
