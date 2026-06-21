/**
 * @brain/metric-engine — computeCodMix (CoD-vs-prepaid mix + CoD CM2, Track C)
 *
 * The SOLE emitter of the CoD payment-mix + CoD contribution-margin (CM2) signal.
 * Reads the `realized_revenue_ledger` CoD event_types added in migration 0030:
 *   cod_delivery_confirmed  (+)  CoD revenue recognized on terminal Delivered
 *   cod_rto_clawback        (−)  CoD revenue reversed on terminal RTO (signed negative)
 * plus the prepaid recognition spine (finalization) for the mix denominator.
 *
 * CoD CM2 (the honest unit-economics signal India-D2C cares about): net CoD revenue =
 * SUM of the signed cod_* rows = delivered credit − RTO clawback. RTO clawback is the
 * realized cost of a return-to-origin (the reverse-logistics + lost-COGS hit), so net
 * CoD is the contribution AFTER RTO leakage — the number a flattering "placed CoD GMV"
 * hides. We surface BOTH (gross delivered, RTO clawback, net) so the realized truth leads.
 *
 * Mix = CoD recognized ÷ (CoD recognized + prepaid recognized), per currency. M1 is
 * single-currency per brand (0018), so one row; multi-currency is additive.
 *
 * Money: BIGINT minor units everywhere (I-S07). The ledger amount_minor is SIGNED; the
 * engine never re-derives a sign. NO ad-hoc SUM in the analytics module (ADR-002).
 *
 * DEV-HONESTY: the CoD ledger rows derive from the GoKwik AWB terminal-state consumer,
 * whose source is SYNTHETIC in dev (real shape, synthetic source). Labelled synthetic at the BFF/UI.
 *
 * ── PHASE G re-point: reads the lakehouse ledger brain_gold.gold_revenue_ledger via the withSilverBrand
 *    seam (I-ST01), NOT PG realized_revenue_ledger — PostgreSQL is no longer a revenue READ source.
 *    PG remains the write SoR during transition; gold_revenue_ledger is the derived lakehouse copy.
 *
 * @see db/dbt/models/marts/gold_revenue_ledger.sql (the lakehouse ledger)
 * @see settlement-summary.ts — the sibling compute fn this mirrors
 */

import type { CurrencyCode } from '@brain/money';
import type { SilverPool } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';

/** Ledger event_types this read consumes (0030 CoD + the prepaid spine). */
const COD_DELIVERED = 'cod_delivery_confirmed';
const COD_CLAWBACK = 'cod_rto_clawback';
const PREPAID_FINALIZATION = 'finalization';

export interface CodMixResult {
  /** True iff the brand has ANY cod_* ledger row (honest no_data discriminant). */
  hasData: boolean;
  currencyCode: CurrencyCode | null;
  /** Gross CoD revenue recognized on delivery (cod_delivery_confirmed credit), minor units. */
  codDeliveredMinor: bigint;
  /** RTO clawback magnitude (POSITIVE; the signed ledger value negated), minor units. */
  codRtoClawbackMinor: bigint;
  /** Net CoD CM2 = delivered − clawback = SUM of signed cod_* rows, minor units. */
  codNetMinor: bigint;
  /** Prepaid recognized revenue (finalization), minor units — the mix counterweight. */
  prepaidMinor: bigint;
  /** CoD share of recognized revenue (CoD net ÷ (CoD net + prepaid)), 2dp string; null when denom ≤ 0. */
  codSharePct: string | null;
}

/** Exact 2-decimal percentage from two bigint magnitudes (integer math; null on non-positive denom). */
function ratePct(numerator: bigint, denominator: bigint): string | null {
  if (denominator <= 0n) return null;
  const bps = (numerator * 10000n) / denominator;
  const whole = bps / 100n;
  const frac = bps % 100n;
  const absFrac = frac < 0n ? -frac : frac;
  return `${whole}.${String(absFrac).padStart(2, '0')}`;
}

/**
 * computeCodMix — CoD-vs-prepaid mix + CoD CM2 as of now, per currency.
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param deps    - The StarRocks Silver/Gold pool (mysql2) — gold_revenue_ledger via withSilverBrand.
 * @returns CodMixResult — hasData=false when no cod_* rows exist (honest no_data).
 */
export async function computeCodMix(
  brandId: string,
  deps: { srPool: SilverPool },
): Promise<CodMixResult> {
  return withSilverBrand(deps.srPool, brandId, async (scope) => {
    // Per-event_type signed sum + the per-row currency. The signed amount_minor carries the sign.
    const rows = await scope.runScoped<{ event_type: string; sum_minor: string | number; currency_code: string | null }>(
      `SELECT event_type,
              COALESCE(SUM(amount_minor), 0) AS sum_minor,
              MAX(currency_code)             AS currency_code
         FROM brain_gold.gold_revenue_ledger
        WHERE event_type IN ('${COD_DELIVERED}', '${COD_CLAWBACK}', '${PREPAID_FINALIZATION}')
          AND ${BRAND_PREDICATE}
        GROUP BY event_type`,
      [],
    );

    const sumByType = new Map<string, bigint>();
    let currencyCode: CurrencyCode | null = null;
    for (const r of rows) {
      sumByType.set(r.event_type, BigInt(String(r.sum_minor).split('.')[0] ?? '0'));
      if (r.currency_code) currencyCode = r.currency_code as CurrencyCode;
    }

    const codDeliveredSigned = sumByType.get(COD_DELIVERED) ?? 0n; // (+)
    const codClawbackSigned = sumByType.get(COD_CLAWBACK) ?? 0n;   // (−)
    const prepaidMinor = sumByType.get(PREPAID_FINALIZATION) ?? 0n;

    const hasCod = sumByType.has(COD_DELIVERED) || sumByType.has(COD_CLAWBACK);
    if (!hasCod || currencyCode === null) {
      return {
        hasData: false,
        currencyCode,
        codDeliveredMinor: 0n,
        codRtoClawbackMinor: 0n,
        codNetMinor: 0n,
        prepaidMinor: 0n,
        codSharePct: null,
      };
    }

    // Net CoD = signed delivered + signed clawback (clawback is already negative).
    const codNetMinor = codDeliveredSigned + codClawbackSigned;
    // Clawback as a POSITIVE magnitude for display ("− ₹X").
    const codRtoClawbackMinor = codClawbackSigned < 0n ? -codClawbackSigned : codClawbackSigned;

    // Mix denominator = net CoD + prepaid. Guard non-positive (no divide-by-zero / honest null).
    const codSharePct = ratePct(codNetMinor, codNetMinor + prepaidMinor);

    return {
      hasData: true,
      currencyCode,
      codDeliveredMinor: codDeliveredSigned,
      codRtoClawbackMinor,
      codNetMinor,
      prepaidMinor,
      codSharePct,
    };
  });
}
