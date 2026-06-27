/**
 * Contract tests: the Customer360 Phase-1→Phase-2 BI handoff + the Gold data-product registry.
 *
 * Proves the formal boundary BI binds to:
 *  - gold_customer_360 is a registered Gold data product (brand_id-first PK, money column named, served).
 *  - Customer360Contract parses a valid BI row and enforces the V4 money/PII/confidence invariants
 *    (money is bigint-minor STRINGS — no float; churn_score is an int 0-100; lifecycle/health are closed).
 * A breaking change (dropping brand_id, blending money into a float) MUST fail one of these.
 */
import { describe, it, expect } from 'vitest';

import {
  GOLD_DATA_PRODUCT_REGISTRY,
  findGoldDataProduct,
  Customer360ContractSchema,
  HealthBandSchema,
  ChurnScoreSchema,
  LifecycleStageSchema,
} from './intelligence.api.v1.js';

const VALID_360 = {
  brand_id: '22222222-2222-4222-8222-222222222222',
  brain_id: 'brn_abc123',
  lifetime_value_minor: '123450',
  aov_minor: '41150',
  currency_code: 'INR',
  lifetime_orders: 3,
  lifecycle_state: 'delivered',
  health_band: 'healthy',
  churn_score: 12,
  segment: 'loyal',
  acquisition_source: 'paid_meta',
  last_activity: '2026-06-20T10:00:00Z',
  // B2 enrichment
  last_activity_at: '2026-06-20T10:00:00Z',
  preferred_channel: 'paid_meta',
  preferred_device: 'mobile',
  top_category: 'Sneakers',
  lifecycle_stage: 'active',
};

describe('GOLD_DATA_PRODUCT_REGISTRY', () => {
  it('registers gold_customer_360 as a served, brand-first Gold product', () => {
    const p = findGoldDataProduct('gold_customer_360');
    expect(p).toBeDefined();
    expect(p?.layer).toBe('gold');
    // brand_id is the implicit-first tenant key on the PK (V4 rule 5).
    expect(p?.pk[0]).toBe('brand_id');
    expect(p?.pk).toEqual(['brand_id', 'brain_id']);
    expect(p?.tenant_column).toBe('brand_id');
    // the only money column is the bigint-minor lifetime value, paired with currency_code.
    expect(p?.money_columns).toEqual(['lifetime_value_minor']);
    expect(p?.currency_column).toBe('currency_code');
    // served THROUGH a Trino brain_serving.mv_* view, never the Iceberg table directly.
    expect(p?.serving_mv).toBe('brain_serving.mv_gold_customer_360');
    expect(p?.provisional).toBe(false);
  });

  it('every registered product is brand_id-first on its PK', () => {
    for (const p of GOLD_DATA_PRODUCT_REGISTRY) {
      expect(p.pk[0]).toBe('brand_id');
      expect(p.tenant_column).toBe('brand_id');
    }
  });
});

describe('Customer360ContractSchema — Phase-2 BI handoff', () => {
  it('parses a valid Customer360 row', () => {
    const r = Customer360ContractSchema.safeParse(VALID_360);
    expect(r.success).toBe(true);
  });

  it('rejects a missing brand_id (tenant key, I-S01)', () => {
    const { brand_id: _omit, ...noBrand } = VALID_360;
    expect(Customer360ContractSchema.safeParse(noBrand).success).toBe(false);
  });

  it('rejects float / non-integer money (money is bigint-minor strings, no float)', () => {
    expect(
      Customer360ContractSchema.safeParse({ ...VALID_360, lifetime_value_minor: '1234.50' }).success,
    ).toBe(false);
    // a JS number is not an accepted money type at all.
    expect(
      Customer360ContractSchema.safeParse({ ...VALID_360, aov_minor: 41150 }).success,
    ).toBe(false);
  });

  it('accepts a negative minor-unit value (clawback) but not a float', () => {
    expect(
      Customer360ContractSchema.safeParse({ ...VALID_360, lifetime_value_minor: '-500' }).success,
    ).toBe(true);
  });

  it('enforces churn_score as an integer 0-100 (not money, not a float)', () => {
    expect(ChurnScoreSchema.safeParse(0).success).toBe(true);
    expect(ChurnScoreSchema.safeParse(100).success).toBe(true);
    expect(ChurnScoreSchema.safeParse(101).success).toBe(false);
    expect(ChurnScoreSchema.safeParse(12.5).success).toBe(false);
    expect(Customer360ContractSchema.safeParse({ ...VALID_360, churn_score: 101 }).success).toBe(
      false,
    );
  });

  it('constrains health_band and lifecycle_state to their closed sets', () => {
    expect(HealthBandSchema.options).toEqual(['healthy', 'at_risk', 'churned']);
    expect(Customer360ContractSchema.safeParse({ ...VALID_360, health_band: 'fine' }).success).toBe(
      false,
    );
    expect(
      Customer360ContractSchema.safeParse({ ...VALID_360, lifecycle_state: 'bogus' }).success,
    ).toBe(false);
  });

  it('allows a null last_activity (never observed post-identification)', () => {
    expect(
      Customer360ContractSchema.safeParse({ ...VALID_360, last_activity: null }).success,
    ).toBe(true);
  });

  it('parses the B2 enrichment fields and allows them null (honest-empty, no source signal)', () => {
    // aov_minor stays bigint-minor (no float) and uses the SAME currency_code as lifetime_value_minor.
    expect(
      Customer360ContractSchema.safeParse({ ...VALID_360, aov_minor: '41150.5' }).success,
    ).toBe(false);
    // each enrichment field is independently nullable.
    for (const f of [
      'last_activity_at',
      'preferred_channel',
      'preferred_device',
      'top_category',
      'lifecycle_stage',
    ] as const) {
      expect(Customer360ContractSchema.safeParse({ ...VALID_360, [f]: null }).success).toBe(true);
    }
  });

  it('constrains lifecycle_stage to its closed set {new, active, at_risk, churned}', () => {
    expect(LifecycleStageSchema.options).toEqual(['new', 'active', 'at_risk', 'churned']);
    for (const stage of ['new', 'active', 'at_risk', 'churned']) {
      expect(Customer360ContractSchema.safeParse({ ...VALID_360, lifecycle_stage: stage }).success).toBe(
        true,
      );
    }
    expect(
      Customer360ContractSchema.safeParse({ ...VALID_360, lifecycle_stage: 'dormant' }).success,
    ).toBe(false);
  });
});
