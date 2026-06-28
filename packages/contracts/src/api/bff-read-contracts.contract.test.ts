/**
 * CI GATE: BFF read-contract alignment guard (feat-shared-bff-read-contracts, Track A).
 *
 * This is a build-failing alignment gate, NOT a behavioural unit test. It runs under
 * `test:contract` / `test:unit` (vitest run) so a PR that drifts a core read DTO away from
 * its `@brain/contracts` schema is REJECTED by CI at the contract — never as a deep
 * `BigInt(undefined)` in the browser.
 *
 * Two guarantees per covered DTO:
 *
 *  1. POSITIVE round-trip — a representative core-shaped payload (BOTH the no_data/refusal
 *     arm AND the has_data/answer arm, with real-shaped money strings incl. a negative and
 *     a MoneyRecord) passes `Schema.parse()` AND round-trips (parse output deep-equals input).
 *
 *  2. NEGATIVE drift rejection — a drifted payload (renamed / removed / wrong-typed money
 *     field, or a discriminant rename like `cells`→`grades`, `attributed_minor`→
 *     `attributed_gmv_minor`, `order_id`→`brain_anon_id`) is REJECTED by `safeParse`, and the
 *     error path NAMES the offending field. This is the exact crash class the slice kills.
 *
 * The schemas are NOT `.strict()` (decision §7): additive core fields are tolerated; the guard
 * is on MISSING / RENAMED / WRONG-TYPED *required* fields.
 *
 * @see .engineering-os/runs/.../02-architecture.md §7
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import {
  RevenueSnapshotSchema,
  KpiSummarySchema,
  BillingPeriodsSchema,
  InspectableBillSchema,
  InvoiceSchema,
  IssueInvoiceResultSchema,
  RecommendationsSchema,
  FoundationHealthSchema,
  EntitlementsSchema,
  AttributionByChannelSchema,
  AttributionReconciliationSchema,
  ChannelRoasSchema,
  JourneyFirstTouchMixSchema,
  JourneyTimelineSchema,
  JourneyStitchRateSchema,
  OrderStatusMixSchema,
  DataQualitySummarySchema,
  AskBrainResultSchema,
  MinorUnitsSchema,
  // #67/#63 — widen the gate to the remaining drift-prone read DTOs (identity / billing-result /
  // recommendation-generate) the BFF returns and web parses at the seam.
  Customer360Schema,
  VaultCoverageSchema,
  ErasureResultSchema,
  MergeReviewListSchema,
  MergeResolveResultSchema,
  UnmergeResultSchema,
  SealPeriodResultSchema,
  IssueCreditNoteResultSchema,
  GenerateRecommendationsResultSchema,
  RecommendationActionSchema,
  RecordRecommendationActionRequestSchema,
} from '../index.js';

/** First-issue field path of a failed safeParse, dotted (e.g. 'kpis.0.realized_minor'). */
function firstIssuePath(result: z.SafeParseReturnType<unknown, unknown>): string {
  if (result.success) return '<parsed-ok>';
  return result.error.issues[0]?.path.join('.') ?? '<root>';
}

// ── The money primitive ─────────────────────────────────────────────────────────

describe('MinorUnitsSchema — the single money primitive', () => {
  it('accepts a positive minor-unit string, a negative clawback, and a net-zero', () => {
    expect(MinorUnitsSchema.parse('123450')).toBe('123450');
    expect(MinorUnitsSchema.parse('-500')).toBe('-500');
    expect(MinorUnitsSchema.parse('0')).toBe('0');
  });
  it('REJECTS a float, a number type, and a non-numeric string', () => {
    expect(MinorUnitsSchema.safeParse('1234.50').success).toBe(false); // float banned
    expect(MinorUnitsSchema.safeParse(123450).success).toBe(false); // number type banned
    expect(MinorUnitsSchema.safeParse('₹1234').success).toBe(false);
  });
});

// ── #1 RevenueSnapshot ───────────────────────────────────────────────────────────

describe('RevenueSnapshot (#1)', () => {
  const noData = { state: 'no_data', as_of: '2026-06-18', realized: null, provisional: null };
  const hasData = {
    state: 'has_data',
    as_of: '2026-06-18',
    realized: { INR: '123450', USD: '-500' },
    provisional: {},
  };
  it('round-trips both arms', () => {
    expect(RevenueSnapshotSchema.parse(noData)).toEqual(noData);
    expect(RevenueSnapshotSchema.parse(hasData)).toEqual(hasData);
  });
  it('REJECTS a float money value inside the MoneyRecord', () => {
    const drifted = { ...hasData, realized: { INR: '1234.50' } };
    const r = RevenueSnapshotSchema.safeParse(drifted);
    expect(r.success).toBe(false);
    expect(firstIssuePath(r)).toBe('realized.INR');
  });
});

// ── #2 KpiSummary ─────────────────────────────────────────────────────────────────

describe('KpiSummary (#2)', () => {
  const hasData = {
    state: 'has_data',
    as_of: '2026-06-18',
    kpis: [
      {
        currency_code: 'INR',
        realized_minor: '123450',
        provisional_minor: '5000',
        order_count: '42',
        aov_minor: '2939',
        rto_rate_pct: '3.25',
      },
    ],
  };
  it('round-trips has_data + no_data', () => {
    expect(KpiSummarySchema.parse(hasData)).toEqual(hasData);
    const noData = { state: 'no_data', as_of: '2026-06-18' };
    expect(KpiSummarySchema.parse(noData)).toEqual(noData);
  });
  it('REJECTS a removed money field — error path names kpis.0.realized_minor', () => {
    const drifted = {
      ...hasData,
      kpis: [{ ...hasData.kpis[0] }],
    } as Record<string, unknown> & { kpis: Array<Record<string, unknown>> };
    delete drifted.kpis[0]!['realized_minor']; // historical removal drift
    const r = KpiSummarySchema.safeParse(drifted);
    expect(r.success).toBe(false);
    expect(firstIssuePath(r)).toBe('kpis.0.realized_minor');
  });
  it('REJECTS a wrong-typed money field (number not string)', () => {
    const drifted = {
      ...hasData,
      kpis: [{ ...hasData.kpis[0], realized_minor: 123450 }],
    };
    const r = KpiSummarySchema.safeParse(drifted);
    expect(r.success).toBe(false);
    expect(firstIssuePath(r)).toBe('kpis.0.realized_minor');
  });
});

// ── #3 AttributionByChannel ─────────────────────────────────────────────────────────

describe('AttributionByChannel (#3)', () => {
  const hasData = {
    state: 'has_data',
    from: '2026-06-01',
    to: '2026-06-18',
    model: 'last_touch',
    currency_code: null, // core sends string|null
    attributed_gmv_minor: '900000',
    realized_gmv_minor: '1000000',
    unattributed_minor: '100000',
    reconciliation_rate_pct: '90.00',
    by_channel: [{ channel: 'paid_meta', currency_code: 'INR', contribution_minor: '500000' }],
    data_source: 'synthetic',
  };
  it('round-trips has_data (currency_code null) + no_data', () => {
    expect(AttributionByChannelSchema.parse(hasData)).toEqual(hasData);
    const noData = { state: 'no_data', from: '2026-06-01', to: '2026-06-18', model: 'linear' };
    expect(AttributionByChannelSchema.parse(noData)).toEqual(noData);
  });
  it('REJECTS the renamed money field attributed_minor (must be attributed_gmv_minor)', () => {
    const { attributed_gmv_minor, ...rest } = hasData;
    const drifted = { ...rest, attributed_minor: attributed_gmv_minor }; // the historical rename
    const r = AttributionByChannelSchema.safeParse(drifted);
    expect(r.success).toBe(false);
    expect(firstIssuePath(r)).toBe('attributed_gmv_minor');
  });
});

// ── #4 AttributionReconciliation ─────────────────────────────────────────────────────

describe('AttributionReconciliation (#4)', () => {
  const hasData = {
    state: 'has_data',
    from: '2026-06-01',
    to: '2026-06-18',
    model: 'linear',
    currency_code: 'INR',
    attributed_gmv_minor: '900000',
    realized_gmv_minor: '1000000',
    unattributed_minor: '100000',
    reconciliation_rate_pct: null, // nullable pct
    data_source: 'live',
  };
  it('round-trips', () => {
    expect(AttributionReconciliationSchema.parse(hasData)).toEqual(hasData);
  });
});

// ── #5 ChannelRoas ────────────────────────────────────────────────────────────────

describe('ChannelRoas (#5)', () => {
  const hasData = {
    state: 'has_data',
    from: '2026-06-01',
    to: '2026-06-18',
    model: 'last_touch',
    rows: [
      { channel: 'paid_meta', currency_code: 'INR', attributed_minor: '500000', spend_minor: '250000', roas_ratio: '2.00' },
      { channel: 'email', currency_code: 'INR', attributed_minor: '100000', spend_minor: '0', roas_ratio: null },
    ],
    data_source: 'synthetic',
  };
  it('round-trips (incl. honest null roas_ratio when spend=0)', () => {
    expect(ChannelRoasSchema.parse(hasData)).toEqual(hasData);
  });
});

// ── #6 JourneyFirstTouchMix ─────────────────────────────────────────────────────────

describe('JourneyFirstTouchMix (#6)', () => {
  const hasData = {
    state: 'has_data',
    from: '2026-06-01',
    to: '2026-06-18',
    total: '120',
    by_channel: [{ channel: 'direct', count: '40', share_pct: '33.33' }],
    data_source: 'live',
  };
  it('round-trips has_data + no_data', () => {
    expect(JourneyFirstTouchMixSchema.parse(hasData)).toEqual(hasData);
    expect(JourneyFirstTouchMixSchema.parse({ state: 'no_data' })).toEqual({ state: 'no_data' });
  });
});

// ── #7 JourneyTimeline ──────────────────────────────────────────────────────────────

describe('JourneyTimeline (#7)', () => {
  const touch = {
    touch_seq: 1,
    is_first_touch: true,
    is_last_touch: false,
    occurred_at: '2026-06-18T10:00:00.000Z',
    channel: 'paid_google',
    utm_source: 'google',
    utm_medium: 'cpc',
    utm_campaign: null,
    utm_term: null,
    utm_content: null,
    fbclid: null,
    gclid: 'abc123',
    ttclid: null,
    referrer_host: null,
    landing_path: '/lp',
    event_type: 'page_view',
  };
  const hasData = {
    state: 'has_data',
    brain_anon_id: 'anon_42', // NOT order_id
    stitched: true,
    touches: [touch],
    data_source: 'synthetic',
  };
  it('round-trips has_data (keyed by brain_anon_id) + no_data', () => {
    expect(JourneyTimelineSchema.parse(hasData)).toEqual(hasData);
    expect(JourneyTimelineSchema.parse({ state: 'no_data' })).toEqual({ state: 'no_data' });
  });
  it('REJECTS the historical order_id drift (must be brain_anon_id)', () => {
    const { brain_anon_id, ...rest } = hasData;
    const drifted = { ...rest, order_id: brain_anon_id };
    const r = JourneyTimelineSchema.safeParse(drifted);
    expect(r.success).toBe(false);
    expect(firstIssuePath(r)).toBe('brain_anon_id');
  });
});

// ── #8 JourneyStitchRate ──────────────────────────────────────────────────────────

describe('JourneyStitchRate (#8)', () => {
  const hasData = {
    state: 'has_data',
    from: '2026-06-01',
    to: '2026-06-18',
    total: '200',
    stitched: '150',
    hit_pct: '75.00',
    data_source: 'live',
  };
  it('round-trips', () => {
    expect(JourneyStitchRateSchema.parse(hasData)).toEqual(hasData);
  });
});

// ── #9 OrderStatusMix ──────────────────────────────────────────────────────────────

describe('OrderStatusMix (#9)', () => {
  const hasData = {
    state: 'has_data',
    from: '2026-06-01',
    to: '2026-06-18',
    currency_code: 'INR', // non-null
    total: '300',
    terminal_count: '180',
    by_state: [
      { lifecycle_state: 'delivered', count: '150', share_pct: '50.00', value_minor: '7500000' },
      { lifecycle_state: 'rto', count: '30', share_pct: '10.00', value_minor: '1500000' },
    ],
    data_source: 'synthetic',
  };
  it('round-trips', () => {
    expect(OrderStatusMixSchema.parse(hasData)).toEqual(hasData);
  });
  it('REJECTS a float value_minor', () => {
    const drifted = {
      ...hasData,
      by_state: [{ ...hasData.by_state[0], value_minor: '75000.00' }],
    };
    const r = OrderStatusMixSchema.safeParse(drifted);
    expect(r.success).toBe(false);
    expect(firstIssuePath(r)).toBe('by_state.0.value_minor');
  });
});

// ── #10 DataQualitySummary ──────────────────────────────────────────────────────────

describe('DataQualitySummary (#10)', () => {
  const hasData = {
    state: 'has_data',
    grades: [
      {
        category: 'freshness',
        target: 'silver.order_state',
        grade: 'A',
        passing: true,
        observed: '42',
        threshold: '60',
        checkedAt: '2026-06-18T10:00:00.000Z',
      },
    ],
    freshnessSla: 'green',
    coverage: { graded: 6, expected: 8 },
    costConfidence: 'A',
    attributionConfidence: 'B',
    effectiveConfidence: 'B',
    tier: 'trusted',
    gate: {
      tier: 'trusted',
      billingCapApplies: true,
      includedInMmm: true,
      blocksHighRiskRecommendation: false,
    },
  };
  it('round-trips has_data (field is `grades`) + no_data', () => {
    expect(DataQualitySummarySchema.parse(hasData)).toEqual(hasData);
    expect(DataQualitySummarySchema.parse({ state: 'no_data' })).toEqual({ state: 'no_data' });
  });
  it('REJECTS the historical `cells` drift (must be `grades`)', () => {
    const { grades, ...rest } = hasData;
    const drifted = { ...rest, cells: grades };
    const r = DataQualitySummarySchema.safeParse(drifted);
    expect(r.success).toBe(false);
    expect(firstIssuePath(r)).toBe('grades');
  });
});

// ── #11 AskBrainResult ──────────────────────────────────────────────────────────────

describe('AskBrainResult (#11)', () => {
  const answer = {
    kind: 'answer',
    binding: {
      metric_id: 'realized_revenue',
      metric_version: 'v1',
      params: { date_from: '2026-06-01', date_to: '2026-06-18', channel: 'paid_meta' },
      snapshot_id: 'snap_abc',
    },
    number: { figure_kind: 'money', money: { INR: '123450', USD: '-500' }, scalar: null, no_data: false },
    confidence_grade: 'B',
    trust_tier: 'Trusted',
    provenance_id: 'prov_1',
  };
  const refusal = { kind: 'refusal', reason: 'no certified metric answers this' };
  it('round-trips the answer (kind discriminant) + refusal arms', () => {
    expect(AskBrainResultSchema.parse(answer)).toEqual(answer);
    expect(AskBrainResultSchema.parse(refusal)).toEqual(refusal);
  });
  it('round-trips a none/no_data answer (figure_kind none, money null)', () => {
    const none = { ...answer, number: { figure_kind: 'none', money: null, scalar: null, no_data: false } };
    expect(AskBrainResultSchema.parse(none)).toEqual(none);
  });
  it('REJECTS a float inside ComputedNumber.money', () => {
    const drifted = { ...answer, number: { figure_kind: 'money', money: { INR: '1234.50' }, scalar: null, no_data: false } };
    const r = AskBrainResultSchema.safeParse(drifted);
    expect(r.success).toBe(false);
    expect(firstIssuePath(r)).toBe('number.money.INR');
  });
  it('REJECTS a wrong discriminant value (state instead of kind)', () => {
    const drifted = { state: 'answer', reason: 'x' } as unknown;
    const r = AskBrainResultSchema.safeParse(drifted);
    expect(r.success).toBe(false);
  });
});

describe('BillingPeriods (#15 — realized-GMV meter)', () => {
  const hasData = {
    state: 'has_data',
    periods: [
      {
        billing_period: '2099-03',
        currency_code: 'INR',
        metered_gmv_minor: '80000',
        as_of_date: '2099-03-31',
        ledger_row_count: 3,
        sealed_at: '2099-04-01T00:00:00.000Z',
      },
    ],
  };
  it('round-trips has_data + no_data', () => {
    expect(BillingPeriodsSchema.parse(hasData)).toEqual(hasData);
    const noData = { state: 'no_data' };
    expect(BillingPeriodsSchema.parse(noData)).toEqual(noData);
  });
  it('REJECTS a float metered_gmv_minor — error path names periods.0.metered_gmv_minor', () => {
    const drifted = { ...hasData, periods: [{ ...hasData.periods[0], metered_gmv_minor: '800.00' }] };
    const r = BillingPeriodsSchema.safeParse(drifted);
    expect(r.success).toBe(false);
    expect(firstIssuePath(r)).toBe('periods.0.metered_gmv_minor');
  });
  it('REJECTS a wrong-typed money field (number not string)', () => {
    const drifted = { ...hasData, periods: [{ ...hasData.periods[0], metered_gmv_minor: 80000 }] };
    const r = BillingPeriodsSchema.safeParse(drifted);
    expect(r.success).toBe(false);
    expect(firstIssuePath(r)).toBe('periods.0.metered_gmv_minor');
  });
  it('REJECTS a renamed period discriminant field (billing_period → period)', () => {
    const renamed = { billing_period: undefined, period: '2099-03' };
    const drifted = { ...hasData, periods: [{ ...hasData.periods[0], ...renamed }] };
    const r = BillingPeriodsSchema.safeParse(drifted);
    expect(r.success).toBe(false);
  });
});

describe('InspectableBill (#16 — fee derivation)', () => {
  const billed = {
    state: 'billed',
    billing_period: '2099-03',
    currency_code: 'INR',
    basis: {
      metered_gmv_minor: '80000',
      as_of_date: '2099-03-31',
      ledger_row_count: 3,
      sealed_at: '2099-04-01T00:00:00.000Z',
    },
    rate: { rate_bps: 150, source: 'plan' },
    fee_minor: '1200',
    rounding_adjustment_minor: '0',
    lines: [
      { event_type: 'finalization', amount_minor: '100000' },
      { event_type: 'refund', amount_minor: '-20000' }, // honest negative
    ],
    reconciliation: {
      sealed_basis_minor: '80000',
      live_composition_minor: '80000',
      reconciles: true,
      drift_minor: '0',
    },
  };
  it('round-trips billed + not_sealed', () => {
    expect(InspectableBillSchema.parse(billed)).toEqual(billed);
    const notSealed = { state: 'not_sealed', billing_period: '2099-01' };
    expect(InspectableBillSchema.parse(notSealed)).toEqual(notSealed);
  });
  it('REJECTS a float fee_minor — error path names fee_minor', () => {
    const drifted = { ...billed, fee_minor: '12.00' };
    const r = InspectableBillSchema.safeParse(drifted);
    expect(r.success).toBe(false);
    expect(firstIssuePath(r)).toBe('fee_minor');
  });
  it('REJECTS a number-typed line amount (float drift class)', () => {
    const drifted = { ...billed, lines: [{ event_type: 'finalization', amount_minor: 100000 }] };
    const r = InspectableBillSchema.safeParse(drifted);
    expect(r.success).toBe(false);
    expect(firstIssuePath(r)).toBe('lines.0.amount_minor');
  });
  it('REJECTS a removed reconciliation field — error path names reconciliation.reconciles', () => {
    const recon = { ...billed.reconciliation } as Record<string, unknown>;
    delete recon['reconciles'];
    const drifted = { ...billed, reconciliation: recon };
    const r = InspectableBillSchema.safeParse(drifted);
    expect(r.success).toBe(false);
    expect(firstIssuePath(r)).toBe('reconciliation.reconciles');
  });
});

describe('Invoice (#17 — issued GST invoice)', () => {
  const issued = {
    state: 'issued',
    invoice_id: '11111111-1111-4111-8111-111111111111',
    invoice_number: 'BRAIN/2098-2099/000001',
    billing_period: '2098-05',
    legal_entity: 'BRAIN',
    fy: '2098-2099',
    currency_code: 'INR',
    basis_gmv_minor: '100000',
    rate_bps: 100,
    fee_minor: '1000',
    tax_minor: '180',
    total_minor: '1180',
    regime: 'cgst_sgst',
    cgst_minor: '90',
    sgst_minor: '90',
    igst_minor: '0',
    sac_hsn_code: '998314',
    tax_rate_bps: 1800,
    seller_gstin: '29AAAAA0000A1Z5',
    place_of_supply: '29-Karnataka',
    status: 'issued',
    issued_at: '2098-06-01T00:00:00.000Z',
    lines: [
      {
        line_no: 1,
        line_type: 'platform_fee',
        description: 'Brain platform fee on realized GMV',
        basis_gmv_minor: '100000',
        rate_bps: 100,
        metric_definition_version: 'realized_gmv_as_of/v1',
        source_billing_period: '2098-05',
        sac_hsn_code: '998314',
        taxable_minor: '1000',
        tax_rate_bps: 1800,
        tax_minor: '180',
        amount_minor: '1180',
      },
    ],
    credit_notes: [
      {
        credit_note_id: '22222222-2222-4222-8222-222222222222',
        credit_note_number: 'BRAIN/2098-2099/CN/000001',
        reason: 'billing correction',
        regime: 'cgst_sgst',
        taxable_minor: '1000',
        tax_minor: '180',
        total_minor: '1180',
        cgst_minor: '90',
        sgst_minor: '90',
        igst_minor: '0',
        issued_at: '2098-06-02T00:00:00.000Z',
      },
    ],
    net_total_minor: '0',
  };
  it('round-trips issued + not_issued', () => {
    expect(InvoiceSchema.parse(issued)).toEqual(issued);
    const notIssued = { state: 'not_issued', billing_period: '2098-05' };
    expect(InvoiceSchema.parse(notIssued)).toEqual(notIssued);
  });
  it('REJECTS a float total_minor — error path names total_minor', () => {
    const drifted = { ...issued, total_minor: '11.80' };
    const r = InvoiceSchema.safeParse(drifted);
    expect(r.success).toBe(false);
    expect(firstIssuePath(r)).toBe('total_minor');
  });
  it('REJECTS a number-typed line amount (float drift class)', () => {
    const drifted = { ...issued, lines: [{ ...issued.lines[0], amount_minor: 1180 }] };
    const r = InvoiceSchema.safeParse(drifted);
    expect(r.success).toBe(false);
    expect(firstIssuePath(r)).toBe('lines.0.amount_minor');
  });
});

describe('IssueInvoiceResult (#18)', () => {
  const issued = {
    state: 'issued',
    issued: true,
    billing_period: '2098-05',
    invoice_id: '11111111-1111-4111-8111-111111111111',
    invoice_number: 'BRAIN/2098-2099/000001',
    currency_code: 'INR',
    fee_minor: '1000',
    tax_minor: '180',
    total_minor: '1180',
  };
  it('round-trips issued + not_sealed', () => {
    expect(IssueInvoiceResultSchema.parse(issued)).toEqual(issued);
    const notSealed = { state: 'not_sealed', billing_period: '2098-01' };
    expect(IssueInvoiceResultSchema.parse(notSealed)).toEqual(notSealed);
  });
  it('REJECTS a float fee_minor — error path names fee_minor', () => {
    const drifted = { ...issued, fee_minor: '10.00' };
    const r = IssueInvoiceResultSchema.safeParse(drifted);
    expect(r.success).toBe(false);
    expect(firstIssuePath(r)).toBe('fee_minor');
  });
});

describe('Recommendations (#19 — decision engine)', () => {
  const hasData = {
    state: 'has_data',
    recommendations: [
      {
        recommendation_id: '11111111-1111-4111-8111-111111111111',
        detector: 'rto_risk',
        kind: 'risk',
        confidence: 'Trusted',
        priority: 100,
        status: 'open',
        title: 'Elevated return-to-origin (RTO) rate',
        summary: '5.02% of orders were returned-to-origin (43 of 856).',
        recommended_action: 'Add address verification; cap COD for new customers.',
        evidence: { rto_count: 43, order_count: 856, rto_rate_pct: '5.02', gmv_at_risk_minor: '14900' },
        outcome: { metric: 'rto_rate_pct', then: 5.02, now: 4.1, delta: -0.92, improved: true },
        created_at: '2026-06-19T00:00:00.000Z',
        held: false,
        held_reason: null,
      },
    ],
  };
  it('round-trips has_data + no_data', () => {
    expect(RecommendationsSchema.parse(hasData)).toEqual(hasData);
    expect(RecommendationsSchema.parse({ state: 'no_data' })).toEqual({ state: 'no_data' });
  });
  it('REJECTS an out-of-enum confidence', () => {
    const drifted = {
      ...hasData,
      recommendations: [{ ...hasData.recommendations[0], confidence: 'High' }],
    };
    const r = RecommendationsSchema.safeParse(drifted);
    expect(r.success).toBe(false);
    expect(firstIssuePath(r)).toBe('recommendations.0.confidence');
  });
  it('REJECTS an out-of-enum kind', () => {
    const drifted = {
      ...hasData,
      recommendations: [{ ...hasData.recommendations[0], kind: 'insight' }],
    };
    const r = RecommendationsSchema.safeParse(drifted);
    expect(r.success).toBe(false);
    expect(firstIssuePath(r)).toBe('recommendations.0.kind');
  });
});

describe('RecommendationAction (M7 — decision-feedback loop)', () => {
  const action = {
    action_id: '22222222-2222-4222-8222-222222222222',
    recommendation_id: '11111111-1111-4111-8111-111111111111',
    action: 'dismissed',
    actor: 'a444444a-0a1a-4a1a-8a1a-000000000001',
    reason: 'not relevant',
    created_at: '2026-06-22T00:00:00.000Z',
  };
  it('round-trips the appended ledger row', () => {
    expect(RecommendationActionSchema.parse(action)).toEqual(action);
    expect(RecommendationActionSchema.parse({ ...action, reason: null })).toEqual({
      ...action,
      reason: null,
    });
  });
  it('REJECTS an out-of-enum action', () => {
    const r = RecommendationActionSchema.safeParse({ ...action, action: 'frobnicate' });
    expect(r.success).toBe(false);
    expect(firstIssuePath(r)).toBe('action');
  });
  it('request: reason optional, action required + enum-checked', () => {
    expect(RecordRecommendationActionRequestSchema.parse({ action: 'accepted' })).toEqual({
      action: 'accepted',
    });
    expect(RecordRecommendationActionRequestSchema.safeParse({ action: 'nope' }).success).toBe(false);
    expect(RecordRecommendationActionRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe('Entitlements (#P2 — progressive unlock)', () => {
  const ent = {
    centers: [
      { key: 'attribution', eligible: false, reason: 'Needs a ready foundation.', unlock_hint: 'Get to ready.' },
      { key: 'journey', eligible: true, reason: null, unlock_hint: null },
    ],
    connector_categories: [
      { key: 'storefront', eligible: true, reason: null, unlock_hint: null },
      { key: 'ads', eligible: false, reason: 'Needs established foundation.', unlock_hint: 'Connect a store.' },
    ],
  };
  it('round-trips a mixed eligible/locked verdict', () => {
    expect(EntitlementsSchema.parse(ent)).toEqual(ent);
  });
  it('REJECTS a non-boolean eligible', () => {
    const r = EntitlementsSchema.safeParse({
      ...ent,
      centers: [{ ...ent.centers[0], eligible: 'yes' }],
    });
    expect(r.success).toBe(false);
    expect(firstIssuePath(r)).toBe('centers.0.eligible');
  });
});

describe('FoundationHealth (#P1 — data foundation readiness)', () => {
  const verdict = {
    tier: 'ready',
    ready: true,
    steps: [
      { key: 'commerce', label: 'Connect your store', done: true },
      { key: 'pixel', label: 'Install the Brain Pixel', done: true },
      { key: 'trusted', label: 'Data quality trusted', done: false },
    ],
    gaps: ['Data quality trusted'],
    next_action: { label: 'Review data quality', href: '/data/quality' },
    headline: 'Your data foundation is ready. Some metrics are still estimated.',
  };
  it('round-trips a verdict (incl. null next_action)', () => {
    expect(FoundationHealthSchema.parse(verdict)).toEqual(verdict);
    expect(FoundationHealthSchema.parse({ ...verdict, next_action: null }).next_action).toBeNull();
  });
  it('REJECTS an out-of-enum tier', () => {
    const r = FoundationHealthSchema.safeParse({ ...verdict, tier: 'unknown' });
    expect(r.success).toBe(false);
    expect(firstIssuePath(r)).toBe('tier');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// #67/#63 — gate widening: the remaining BFF read DTOs (identity / billing-result /
// recommendation-generate). Same two guarantees per DTO: positive round-trip + a
// negative drift rejection whose error path NAMES the offending field.
// ════════════════════════════════════════════════════════════════════════════════

describe('Customer360 (#I1 — identity resolution)', () => {
  const found = {
    state: 'found',
    customer: {
      brain_id: '11111111-1111-4111-8111-111111111111',
      anonymous_id: 'anon_abc',
      merged_into: null,
      lifecycle_state: 'active',
      ai_processing_consent: true,
      resolution_consent: true,
      created_at: '2026-06-19T00:00:00.000Z',
    },
    identifiers: [
      {
        identifier_type: 'email',
        tier: 'deterministic',
        is_active: true,
        created_at: '2026-06-19T00:00:00.000Z',
        identifier_hash_prefix: 'a1b2c3d4e5f6',
      },
    ],
    merges: [
      {
        role: 'canonical',
        canonical_brain_id: '11111111-1111-4111-8111-111111111111',
        merged_brain_id: '22222222-2222-4222-8222-222222222222',
        confidence: 'high',
        rule_version: 'v3',
        identifier_combo: ['email', 'phone'],
        committed_at: '2026-06-19T00:00:00.000Z',
      },
    ],
    orders: [
      {
        order_id: 'ord_1001',
        lifecycle_state: 'delivered',
        is_terminal: true,
        order_value_minor: '123450',
        currency_code: 'INR',
        first_event_at: '2026-06-18T00:00:00.000Z',
        state_effective_at: '2026-06-19T00:00:00.000Z',
      },
    ],
  };
  it('round-trips found + not_found', () => {
    expect(Customer360Schema.parse(found)).toEqual(found);
    const notFound = { state: 'not_found', brain_id: '33333333-3333-4333-8333-333333333333' };
    expect(Customer360Schema.parse(notFound)).toEqual(notFound);
  });
  it('REJECTS a wrong-typed nested is_active — error path names identifiers.0.is_active', () => {
    const drifted = { ...found, identifiers: [{ ...found.identifiers[0], is_active: 'yes' }] };
    const r = Customer360Schema.safeParse(drifted);
    expect(r.success).toBe(false);
    expect(firstIssuePath(r)).toBe('identifiers.0.is_active');
  });
});

describe('VaultCoverage (#I2 — PII vault coverage)', () => {
  const cov = {
    resolved_customers: 1200,
    vaulted_customers: 1080,
    coverage_pct: 90,
    email_count: 1000,
    phone_count: 800,
  };
  it('round-trips a coverage verdict', () => {
    expect(VaultCoverageSchema.parse(cov)).toEqual(cov);
  });
  it('REJECTS coverage_pct above 100 — error path names coverage_pct', () => {
    const r = VaultCoverageSchema.safeParse({ ...cov, coverage_pct: 150 });
    expect(r.success).toBe(false);
    expect(firstIssuePath(r)).toBe('coverage_pct');
  });
});

describe('ErasureResult (#I3 — DPDP erasure)', () => {
  const erased = { erased: true, contact_pii_deleted: 3, links_tombstoned: 5 };
  it('round-trips an erasure result', () => {
    expect(ErasureResultSchema.parse(erased)).toEqual(erased);
  });
  it('REJECTS a string-typed erased flag — error path names erased', () => {
    const r = ErasureResultSchema.safeParse({ ...erased, erased: 'true' });
    expect(r.success).toBe(false);
    expect(firstIssuePath(r)).toBe('erased');
  });
});

describe('MergeReviewList (#I4 — merge review queue)', () => {
  const list = {
    reviews: [
      {
        review_id: '11111111-1111-4111-8111-111111111111',
        brain_id_a: '22222222-2222-4222-8222-222222222222',
        brain_id_b: '33333333-3333-4333-8333-333333333333',
        trigger_reason: 'shared_phone_hash',
        created_at: '2026-06-19T00:00:00.000Z',
      },
    ],
  };
  it('round-trips an empty and a populated queue', () => {
    expect(MergeReviewListSchema.parse({ reviews: [] })).toEqual({ reviews: [] });
    expect(MergeReviewListSchema.parse(list)).toEqual(list);
  });
  it('REJECTS a review missing trigger_reason — error path names reviews.0.trigger_reason', () => {
    const noReason = {
      review_id: '11111111-1111-4111-8111-111111111111',
      brain_id_a: '22222222-2222-4222-8222-222222222222',
      brain_id_b: '33333333-3333-4333-8333-333333333333',
      created_at: '2026-06-19T00:00:00.000Z',
    };
    const r = MergeReviewListSchema.safeParse({ reviews: [noReason] });
    expect(r.success).toBe(false);
    expect(firstIssuePath(r)).toBe('reviews.0.trigger_reason');
  });
});

describe('MergeResolveResult (#I5 — review resolution)', () => {
  const resolved = {
    resolved: true,
    decision: 'merged',
    canonical_brain_id: '11111111-1111-4111-8111-111111111111',
    merged_brain_id: '22222222-2222-4222-8222-222222222222',
  };
  it('round-trips a resolved decision (and the bare resolved flag)', () => {
    expect(MergeResolveResultSchema.parse(resolved)).toEqual(resolved);
    expect(MergeResolveResultSchema.parse({ resolved: false })).toEqual({ resolved: false });
  });
  it('REJECTS an out-of-enum decision — error path names decision', () => {
    const r = MergeResolveResultSchema.safeParse({ ...resolved, decision: 'approved' });
    expect(r.success).toBe(false);
    expect(firstIssuePath(r)).toBe('decision');
  });
});

describe('UnmergeResult (#I6 — unmerge)', () => {
  const unmerged = { unmerged: true, brain_id: '11111111-1111-4111-8111-111111111111' };
  it('round-trips an unmerge result', () => {
    expect(UnmergeResultSchema.parse(unmerged)).toEqual(unmerged);
  });
  it('REJECTS a string-typed unmerged flag — error path names unmerged', () => {
    const r = UnmergeResultSchema.safeParse({ ...unmerged, unmerged: 'yes' });
    expect(r.success).toBe(false);
    expect(firstIssuePath(r)).toBe('unmerged');
  });
});

describe('SealPeriodResult (#B1 — period seal/meter)', () => {
  const sealed = {
    sealed: true,
    billing_period: '2098-05',
    currency_code: 'INR',
    metered_gmv_minor: '1450000',
    as_of_date: '2098-05-31',
    ledger_row_count: 312,
  };
  it('round-trips a seal result', () => {
    expect(SealPeriodResultSchema.parse(sealed)).toEqual(sealed);
  });
  it('REJECTS a float metered_gmv_minor — error path names metered_gmv_minor', () => {
    const r = SealPeriodResultSchema.safeParse({ ...sealed, metered_gmv_minor: '14500.00' });
    expect(r.success).toBe(false);
    expect(firstIssuePath(r)).toBe('metered_gmv_minor');
  });
});

describe('IssueCreditNoteResult (#B2 — credit note)', () => {
  const issued = {
    state: 'issued',
    credit_note_id: '11111111-1111-4111-8111-111111111111',
    credit_note_number: 'BRAIN-CN/2098-2099/000001',
    taxable_minor: '1000',
    tax_minor: '180',
    total_minor: '1180',
  };
  it('round-trips issued + rejected', () => {
    expect(IssueCreditNoteResultSchema.parse(issued)).toEqual(issued);
    const rejected = { state: 'rejected', reason: 'exceeds invoice total', invoice_total_minor: '1000' };
    expect(IssueCreditNoteResultSchema.parse(rejected)).toEqual(rejected);
  });
  it('REJECTS a float taxable_minor — error path names taxable_minor', () => {
    const r = IssueCreditNoteResultSchema.safeParse({ ...issued, taxable_minor: '10.00' });
    expect(r.success).toBe(false);
    expect(firstIssuePath(r)).toBe('taxable_minor');
  });
});

describe('GenerateRecommendationsResult (#R1 — detector run)', () => {
  const result = { raised: 4, expired: 1 };
  it('round-trips a generate result', () => {
    expect(GenerateRecommendationsResultSchema.parse(result)).toEqual(result);
  });
  it('REJECTS a negative raised count — error path names raised', () => {
    const r = GenerateRecommendationsResultSchema.safeParse({ ...result, raised: -1 });
    expect(r.success).toBe(false);
    expect(firstIssuePath(r)).toBe('raised');
  });
});
