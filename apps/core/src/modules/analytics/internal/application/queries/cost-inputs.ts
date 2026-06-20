/**
 * cost-inputs.ts — read + upsert a brand's cost structure (feat-cm2-cost-inputs).
 *
 * The cost_input table (0055) is brand CONFIG that feeds CM1/CM2. Unlike the ledgers it is
 * upsert-able (a brand edits its COGS/shipping/fee rates). All access under withBrandTxn (RLS;
 * brand from session — D-1; never manual WHERE — F-SEC-02). cost_input_id is deterministic
 * (sha256 of brand‖scope‖scope_ref‖cost_type) so editing the same cost upserts in place.
 * Money is bigint-as-string minor units (I-S07).
 */
import { createHash } from 'node:crypto';
import type { EngineDeps } from '@brain/metric-engine';
import { withBrandTxn } from '@brain/metric-engine';

export type CostScope = 'global' | 'sku' | 'category';
export type CostType = 'cogs' | 'shipping' | 'packaging' | 'payment_fee' | 'marketplace_fee';
export type CostConfidence = 'Trusted' | 'Estimated' | 'Insufficient';

export interface CostInputDto {
  scope: CostScope;
  scope_ref: string;
  cost_type: CostType;
  amount_minor: string | null;
  pct_bps: number | null;
  currency_code: string;
  cost_confidence: CostConfidence;
  effective_from: string;
}

export interface UpsertCostInputInput {
  scope: CostScope;
  scope_ref?: string;
  cost_type: CostType;
  /** Exactly one of amount_minor (fixed per-order) or pct_bps (percent of revenue) must be set. */
  amount_minor?: string | null;
  pct_bps?: number | null;
  currency_code: string;
  cost_confidence?: CostConfidence;
}

function costInputId(brandId: string, scope: string, scopeRef: string, costType: string): string {
  return createHash('sha256').update(`${brandId}\0${scope}\0${scopeRef}\0${costType}`).digest('hex');
}

export async function listCostInputs(brandId: string, deps: EngineDeps): Promise<CostInputDto[]> {
  return withBrandTxn(deps.pool, brandId, async (client) => {
    const r = await client.query<{
      scope: CostScope; scope_ref: string; cost_type: CostType;
      amount_minor: string | null; pct_bps: number | null; currency_code: string;
      cost_confidence: CostConfidence; effective_from: Date;
    }>(
      `SELECT scope, scope_ref, cost_type, amount_minor::text AS amount_minor, pct_bps,
              currency_code, cost_confidence, effective_from
         FROM cost_input
        WHERE brand_id = $1 AND effective_to IS NULL
        ORDER BY scope, cost_type, scope_ref`,
      [brandId],
    );
    return r.rows.map((x) => ({
      scope: x.scope,
      scope_ref: x.scope_ref,
      cost_type: x.cost_type,
      amount_minor: x.amount_minor,
      pct_bps: x.pct_bps,
      currency_code: x.currency_code,
      cost_confidence: x.cost_confidence,
      effective_from: x.effective_from.toISOString().split('T')[0] as string,
    }));
  });
}

/** Upsert one cost input. Returns the deterministic id. Validates the rate-XOR-amount invariant. */
export async function upsertCostInput(
  brandId: string,
  input: UpsertCostInputInput,
  deps: EngineDeps,
): Promise<{ cost_input_id: string }> {
  const scopeRef = input.scope_ref ?? '';
  const hasAmount = input.amount_minor !== undefined && input.amount_minor !== null;
  const hasPct = input.pct_bps !== undefined && input.pct_bps !== null;
  if (hasAmount === hasPct) {
    throw new Error('cost input requires exactly one of amount_minor or pct_bps');
  }
  const id = costInputId(brandId, input.scope, scopeRef, input.cost_type);

  await withBrandTxn(deps.pool, brandId, async (client) => {
    await client.query(
      `INSERT INTO cost_input
         (brand_id, cost_input_id, scope, scope_ref, cost_type, amount_minor, pct_bps, currency_code, cost_confidence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (brand_id, cost_input_id) DO UPDATE
         SET amount_minor    = EXCLUDED.amount_minor,
             pct_bps         = EXCLUDED.pct_bps,
             currency_code   = EXCLUDED.currency_code,
             cost_confidence = EXCLUDED.cost_confidence,
             updated_at      = NOW()`,
      [
        brandId, id, input.scope, scopeRef, input.cost_type,
        hasAmount ? input.amount_minor : null,
        hasPct ? input.pct_bps : null,
        input.currency_code,
        input.cost_confidence ?? 'Estimated',
      ],
    );
    return null;
  });
  return { cost_input_id: id };
}
