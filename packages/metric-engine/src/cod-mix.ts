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
 * whose source is SYNTHETIC in dev (real shape, synthetic source). The ledger does not
 * carry a per-row data_source; this surface is labelled synthetic at the BFF/UI layer
 * whenever the AWB connector data is synthetic (consistent with cod-rto-rates).
 *
 * F-SEC-02: reads inside withBrandTxn (GUC transaction-scoped, RLS-enforced).
 *
 * @see db/migrations/0030_gokwik_shopflo_connectors.sql §B (cod_* event_types)
 * @see settlement-summary.ts — the sibling compute fn this mirrors
 */

import type { CurrencyCode } from '@brain/money';
import type { EngineDeps } from './deps.js';
import { withBrandTxn } from './deps.js';

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
 * @param deps    - EngineDeps with raw pg.Pool.
 * @returns CodMixResult — hasData=false when no cod_* rows exist (honest no_data).
 */
export async function computeCodMix(
  brandId: string,
  deps: EngineDeps,
): Promise<CodMixResult> {
  return withBrandTxn(deps.pool, brandId, async (client) => {
    const brandRow = await client.query<{ currency_code: string }>(
      `SELECT currency_code FROM brand WHERE id = $1`,
      [brandId],
    );
    const currencyCode = (brandRow.rows[0]?.currency_code ?? null) as CurrencyCode | null;

    // Per-event_type signed sum. The signed amount_minor carries the sign (engine never re-signs).
    const rows = await client.query<{ event_type: string; sum_minor: string }>(
      `SELECT event_type, COALESCE(SUM(amount_minor), 0)::text AS sum_minor
         FROM realized_revenue_ledger
        WHERE brand_id = $1
          AND event_type = ANY($2::text[])
        GROUP BY event_type`,
      [brandId, [COD_DELIVERED, COD_CLAWBACK, PREPAID_FINALIZATION]],
    );

    const sumByType = new Map<string, bigint>();
    for (const r of rows.rows) sumByType.set(r.event_type, BigInt(r.sum_minor));

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
