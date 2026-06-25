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

import type { SilverPool } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';
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

interface ChannelRow { channel: string; currency_code: string; contribution_minor: string | number }

/**
 * computeAttributionReconciliationRate — the reconciliation rate + residual + channels.
 *
 * Window-attributed = attributed_gmv_as_of(to) − attributed_gmv_as_of(from−1) (both exact
 * BIGINT, so the difference is exact); window-realized = realized_gmv_as_of(to) −
 * realized_gmv_as_of(from−1) (the same windowing as blended_roas). The residual is
 * realized − attributed (always rendered, never hidden — METRICS.md §Rules).
 *
 * ── PHASE G re-point: reads the lakehouse via withSilverBrand (I-ST01) — realized from
 *    brain_gold.gold_revenue_ledger (realized_gmv_as_of math), attributed + per-channel from
 *    brain_gold.gold_marketing_attribution (attributed_gmv_as_of / channel_contribution_as_of math).
 *    Window-attributed = Σ of the per-channel contributions (one query). PG is no longer a read source.
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER body).
 * @param params  - { model, fromDate, toDate } inclusive window.
 * @param deps    - The StarRocks Silver/Gold pool — gold_revenue_ledger + gold_marketing_attribution.
 */
export async function computeAttributionReconciliationRate(
  brandId: string,
  params: { model: AttributionModelId; fromDate: Date; toDate: Date },
  deps: { srPool: SilverPool },
): Promise<AttributionReconciliationResult> {
  const toStr = isoDate(params.toDate);
  const fromStr = isoDate(params.fromDate);
  // model is a typed AttributionModelId; guard to a safe identifier before interpolation.
  const model = /^[a-z0-9_]+$/i.test(params.model) ? params.model : '__invalid__';

  return withSilverBrand(deps.srPool, brandId, async (scope) => {
    // Realized (window) — the realized_gmv_as_of math: SUM(amount_minor) over economic_effective_at
    // ∈ [from,to], excluding provisional. currency_code is single-per-brand (0018) — carried on rows.
    const realizedRows = await scope.runScoped<{ v: string | number; currency_code: string | null }>(
      `SELECT COALESCE(SUM(amount_minor), 0) AS v, MAX(currency_code) AS currency_code
         FROM brain_serving.mv_gold_revenue_ledger
        WHERE CAST(economic_effective_at AS DATE) BETWEEN '${fromStr}' AND '${toStr}'
          AND event_type <> 'provisional_recognition'
          AND ${BRAND_PREDICATE}`,
      [],
    );
    const realizedGmvMinor = BigInt(String(realizedRows[0]?.v ?? '0').split('.')[0] ?? '0');

    // Per-channel contributions (the channel_contribution_as_of math). Window-attributed = Σ of these.
    const channelRows = await scope.runScoped<ChannelRow>(
      `SELECT channel, currency_code, COALESCE(SUM(credited_revenue_minor), 0) AS contribution_minor
         FROM brain_serving.mv_gold_marketing_attribution
        WHERE model_id = '${model}'
          AND CAST(economic_effective_at AS DATE) BETWEEN '${fromStr}' AND '${toStr}'
          AND ${BRAND_PREDICATE}
        GROUP BY channel, currency_code`,
      [],
    );
    const byChannel: ChannelContribution[] = channelRows.map((r) => ({
      channel: r.channel,
      currencyCode: r.currency_code,
      contributionMinor: BigInt(String(r.contribution_minor).split('.')[0] ?? '0'),
    }));
    const attributedGmvMinor = byChannel.reduce((acc, c) => acc + c.contributionMinor, 0n);

    // Display currency: realized side (brand currency) first, else the attributed side.
    const currencyCode = realizedRows[0]?.currency_code ?? byChannel[0]?.currencyCode ?? null;

    // Pure core does the rate/residual/closed-sum math (sort included) — unit-tested in isolation.
    return reconcileAttributionWindow({
      currencyCode,
      realizedGmvMinor,
      attributedGmvMinor,
      byChannel,
    });
  });
}
