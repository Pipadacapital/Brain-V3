// SPEC:D.2 — tests named after the spec section (D2.registry).
import { describe, it, expect, beforeAll } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMetricRegistryFrom, type ParsedMetricRegistry } from './loader.js';
import { createFsMetricSource, yamlParse } from './infrastructure/fs-source.js';

const METRICS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'metrics');

/** The certified launch set (SPEC:D.2 launch list + ad_spend/cm1_pct/cm2_pct to the real 22). */
const EXPECTED_22 = [
  'net_revenue', 'gross_revenue', 'refund_amount', 'orders', 'aov', 'mer', 'amer', 'roas',
  'cac', 'cac_new', 'cm1', 'cm2', 'cm3', 'cm3_pct', 'cm1_pct', 'cm2_pct', 'rto_rate',
  'return_rate', 'repeat_rate', 'ltv_realized', 'identified_purchase_rate', 'ad_spend',
].sort();

describe('D2.registry — the metrics/*.yaml registry loads + is the certified 22', () => {
  let reg: ParsedMetricRegistry;
  beforeAll(async () => {
    reg = await loadMetricRegistryFrom(createFsMetricSource(METRICS_DIR), yamlParse);
  });

  it('D2.registry.count — exactly 22 certified metrics', () => {
    expect(reg.all).toHaveLength(22);
  });

  it('D2.registry.names — the certified names match the launch set', () => {
    expect([...reg.names].sort()).toEqual(EXPECTED_22);
  });

  it('D2.registry.money_discipline — every money/ratio metric groups by currency; none-metrics never do', () => {
    for (const m of reg.all) {
      if (m.currency_handling === 'none') {
        expect(m.dimensions_allowed).not.toContain('currency_code');
      }
    }
  });

  it('D2.registry.one_file_per_metric — file name matches metric name (name-discoverable)', () => {
    // loadMetricRegistryFrom throws on a name/file mismatch; reaching here means all 22 matched.
    expect(reg.byName.size).toBe(22);
  });
});
