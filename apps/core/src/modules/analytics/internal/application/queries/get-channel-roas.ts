/**
 * getChannelRoas — analytics use-case (ADR-002 sole-read-path).
 *
 * Per-channel ROAS = attributed_revenue ÷ ad_spend, from computeChannelRoas (metric engine).
 * Makes blended_roas PER-CHANNEL (joins the attribution credit ledger's channel contribution
 * with ad_spend_ledger). SAME-CURRENCY ONLY; HONEST roas_ratio=null when spend=0 (no
 * divide-by-zero). NO ad-hoc arithmetic here (D-3). Serializes bigint→string (D-1).
 *
 * Honest no_data when the brand has zero ad_spend_ledger rows (no denominator → no ROAS).
 * brandId from session (D-1; NEVER body).
 */

import type { EngineDeps, AttributionModelId } from '@brain/metric-engine';
import { computeChannelRoas, withBrandTxn } from '@brain/metric-engine';

export interface ChannelRoasDto {
  channel: string;
  currency_code: string;
  attributed_minor: string; // bigint → string (D-1)
  spend_minor: string;      // bigint → string (D-1)
  roas_ratio: string | null; // exact decimal string, or null when spend=0 (honest)
}

export type ChannelRoasResult =
  | { state: 'no_data'; from: string; to: string; model: AttributionModelId }
  | {
      state: 'has_data';
      from: string;
      to: string;
      model: AttributionModelId;
      rows: ChannelRoasDto[];
      data_source: 'synthetic' | 'live';
    };

export interface ChannelRoasParams {
  model: AttributionModelId;
  fromDate: Date;
  toDate: Date;
  fromStr: string;
  toStr: string;
  dataSource: 'synthetic' | 'live';
}

export async function getChannelRoas(
  brandId: string,
  params: ChannelRoasParams,
  deps: EngineDeps,
): Promise<ChannelRoasResult> {
  // ROAS requires a spend denominator — no spend → no_data (honest, like blended_roas).
  const hasSpend = await withBrandTxn(deps.pool, brandId, async (client) => {
    const r = await client.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM ad_spend_ledger WHERE brand_id = $1) AS exists`,
      [brandId],
    );
    return r.rows[0]?.exists === true;
  });

  if (!hasSpend) {
    return { state: 'no_data', from: params.fromStr, to: params.toStr, model: params.model };
  }

  const rows = await computeChannelRoas(
    brandId,
    { model: params.model, fromDate: params.fromDate, toDate: params.toDate },
    deps,
  );

  return {
    state: 'has_data',
    from: params.fromStr,
    to: params.toStr,
    model: params.model,
    rows: rows.map((r) => ({
      channel: r.channel,
      currency_code: r.currencyCode,
      attributed_minor: String(r.attributedMinor),
      spend_minor: String(r.spendMinor),
      roas_ratio: r.roasRatio,
    })),
    data_source: params.dataSource,
  };
}
