/**
 * cost-inputs.unit.test.ts — DR-003 one-door invariant: per-SKU unit COGS lives ONLY in the
 * product cost sheet (billing.product_cost_sheet); upsertCostInput rejects scope='sku' +
 * cost_type='cogs' amount rows before touching the pool. Rate configs are unaffected.
 */
import { describe, it, expect, vi } from 'vitest';
import type { EngineDeps } from '@brain/metric-engine';
import { upsertCostInput } from '../internal/application/queries/cost-inputs.js';

const BRAND = '124e6af5-e6c5-4b85-bf43-7b36fa528101';

function untouchedDeps(): EngineDeps {
  const query = vi.fn(async () => {
    throw new Error('pool must not be touched for a rejected input');
  });
  return { pool: { query, connect: query } as never };
}

describe('upsertCostInput — DR-003 one door for per-SKU COGS', () => {
  it('rejects scope=sku + cost_type=cogs amount rows with a pointer to the sheet upload', async () => {
    await expect(
      upsertCostInput(
        BRAND,
        { scope: 'sku', scope_ref: 'SKU-1', cost_type: 'cogs', amount_minor: '12500', currency_code: 'INR' },
        untouchedDeps(),
      ),
    ).rejects.toThrow(/product cost sheet/);
  });

  it('still rejects the amount-XOR-pct invariant first', async () => {
    await expect(
      upsertCostInput(
        BRAND,
        { scope: 'sku', scope_ref: 'SKU-1', cost_type: 'cogs', currency_code: 'INR' },
        untouchedDeps(),
      ),
    ).rejects.toThrow(/exactly one of/);
  });
});
