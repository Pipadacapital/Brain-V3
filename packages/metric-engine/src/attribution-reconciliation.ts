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

/**
 * Exact 2-decimal percentage from two bigint magnitudes (integer math; null on ≤0 denom).
 * Truncates toward zero (NOT rounds) — the basis-point pattern; never float. Exported so the
 * rate is unit-testable in isolation (D3 / R-46).
 */
export function attributionRatePct(numerator: bigint, denominator: bigint): string | null {
  if (denominator <= 0n) return null;
  const bps = (numerator * 10000n) / denominator;
  const whole = bps / 100n;
  const frac = bps % 100n;
  const absFrac = frac < 0n ? -frac : frac;
  return `${whole}.${String(absFrac).padStart(2, '0')}`;
}

/** UTC ISO date (YYYY-MM-DD) — the seam's `as_of`/window date form. */
export function isoDate(d: Date): string {
  return d.toISOString().split('T')[0] as string;
}

/**
 * The EXCLUSIVE lower-boundary date: one UTC day before `from`. The window is computed as
 * `as_of(to) − as_of(from−1)`, so an event posted ON `from` is counted and one on `from−1`
 * is not. UTC-millisecond subtraction → correct across month/year rollovers and DST (D3 / R-47).
 */
export function previousDayIso(from: Date): string {
  return isoDate(new Date(from.getTime() - 24 * 60 * 60 * 1000));
}

/** The already-windowed inputs fed to the pure reconciliation core (no I/O). */
export interface ReconciliationWindowInputs {
  currencyCode: string | null;
  /** realized_gmv_as_of(to) − realized_gmv_as_of(from−1) — exact BIGINT window. */
  realizedGmvMinor: bigint;
  /** attributed_gmv_as_of(to) − attributed_gmv_as_of(from−1) — net of clawback, exact. */
  attributedGmvMinor: bigint;
  /** Per-channel contributions for the window (from the channel_contribution_as_of seam). */
  byChannel: ChannelContribution[];
}

/**
 * reconcileAttributionWindow — the PURE reconciliation core (D3 / R-46): rate + residual +
 * sorted channels + hasData, from already-windowed magnitudes. No DB, no clock — so the
 * closed-sum oracle (Σ channel + unattributed = realized) and the rate math are unit-testable
 * without a live ledger. computeAttributionReconciliationRate is the thin I/O adapter over this.
 */
export function reconcileAttributionWindow(
  inputs: ReconciliationWindowInputs,
): AttributionReconciliationResult {
  const { currencyCode, realizedGmvMinor, attributedGmvMinor } = inputs;
  const byChannel = [...inputs.byChannel].sort((a, b) =>
    a.channel < b.channel ? -1 : a.channel > b.channel ? 1 : 0,
  );
  const unattributedMinor = realizedGmvMinor - attributedGmvMinor;
  return {
    hasData: realizedGmvMinor !== 0n || attributedGmvMinor !== 0n,
    currencyCode,
    attributedGmvMinor,
    realizedGmvMinor,
    unattributedMinor,
    reconciliationRatePct: attributionRatePct(attributedGmvMinor, realizedGmvMinor),
    byChannel,
  };
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
  const toStr = isoDate(params.toDate);
  const fromStr = isoDate(params.fromDate);
  const fromMinus1Str = previousDayIso(params.fromDate);

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
    const byChannel: ChannelContribution[] = channelRows.rows.map((r) => ({
      channel: r.channel,
      currencyCode: r.currency_code,
      contributionMinor: BigInt(r.contribution_minor),
    }));

    // Pure core does the rate/residual/closed-sum math (sort included) — unit-tested in isolation.
    return reconcileAttributionWindow({
      currencyCode,
      realizedGmvMinor,
      attributedGmvMinor,
      byChannel,
    });
  });
}
