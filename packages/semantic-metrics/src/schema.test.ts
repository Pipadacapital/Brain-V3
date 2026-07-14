// SPEC:D.2 — tests named after the spec section (D2.schema).
import { describe, it, expect } from 'vitest';
import { parseMetric } from './schema.js';

const VALID = {
  name: 'net_revenue',
  version: 'v1',
  entity: 'semantic_order',
  time_column: 'conversion_at',
  grain: ['day', 'month'],
  dimensions_allowed: ['channel'],
  currency_handling: 'per_currency',
  identity_basis: 'deterministic_only',
  interactive: true,
  owner: 'measurement-team',
  description: 'net revenue',
  examples: ['e1'],
  measures: [{ name: 'net_revenue_minor', agg: 'SUM(net_revenue_minor)' }],
  expression: 'net_revenue_minor',
};

describe('D2.schema — metric definition validator (fail-closed)', () => {
  it('D2.schema.valid — a well-formed definition parses', () => {
    const m = parseMetric(VALID, 'net_revenue.yaml');
    expect(m.name).toBe('net_revenue');
    expect(m.interactive).toBe(true);
  });

  it('D2.schema.unknown_key — an unknown key is rejected (typo cannot slip a field in)', () => {
    expect(() => parseMetric({ ...VALID, wat: 1 }, 'x.yaml')).toThrow(/invalid metric/);
  });

  it('D2.schema.undefined_measure_ref — expression referencing an undefined measure is rejected', () => {
    expect(() => parseMetric({ ...VALID, expression: 'not_a_measure' }, 'x.yaml')).toThrow(/undefined measure/);
  });

  it('D2.schema.currency_none_no_currency_dim — none cannot expose currency_code', () => {
    expect(() =>
      parseMetric({ ...VALID, currency_handling: 'none', dimensions_allowed: ['currency_code'] }, 'x.yaml'),
    ).toThrow(/currency_code/);
  });

  it('D2.schema.cross_requires_all_grain — a cross-entity metric must be grain:[all]', () => {
    const cross = {
      ...VALID,
      grain: ['day'],
      cross: { entity: 'semantic_campaign', measures: [{ name: 'spend_minor', agg: 'SUM(spend_minor)' }] },
      expression: 'net_revenue_minor',
    };
    expect(() => parseMetric(cross, 'x.yaml')).toThrow(/grain: \[all\]/);
  });

  it('D2.schema.interactive_needs_time_grain — interactive with only grain:[all] is rejected', () => {
    expect(() => parseMetric({ ...VALID, interactive: true, grain: ['all'] }, 'x.yaml')).toThrow(/time-bucketed grain/);
  });
});
