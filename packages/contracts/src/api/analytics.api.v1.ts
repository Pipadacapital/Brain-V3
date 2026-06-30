/**
 * analytics.api.v1 — Zod response contracts for the drift-prone analytics BFF READ DTOs.
 *
 * THE SINGLE SOURCE OF TRUTH for these read shapes. Core's use-case return types and web's
 * consumer types BOTH derive from these schemas (z.infer); neither hand-redeclares a covered
 * DTO. A field rename/removal on either side fails the alignment guard test (positive +
 * negative) and the core `satisfies` (compile-time) — never a deep `BigInt(undefined)`.
 *
 * EACH schema mirrors core's CURRENT real output, field-for-field, verified by reading the
 * cited use-case return type (see the `@see` on each section). DO NOT invent or add fields;
 * DO NOT widen the honest-empty discriminated unions; mirror `currency_code` nullability
 * EXACTLY per-endpoint.
 *
 * INVARIANTS (02-architecture.md §3):
 *  - Money = MinorUnitsSchema (bigint-as-string, `^-?\d+$`) — NEVER z.number()/float/`/100`.
 *  - Honest-empty = z.discriminatedUnion('state', [...]); `no_data` carries NO has_data fields.
 *  - Ratio/pct fields core sends nullable → z.string().nullable() (exact-decimal strings).
 *  - Schemas are NOT `.strict()` (decision §7): core may ADD a benign field without breaking
 *    web reads; the guard is on MISSING / RENAMED / WRONG-TYPED *required* fields (the crash
 *    class), never on additive ones.
 */
import { z } from 'zod';
import {
  MinorUnitsSchema,
  MoneyRecordSchema,
  AttributionModelIdSchema,
  JourneyChannelSchema,
  LifecycleStateSchema,
  DataSourceSchema,
} from './_money.js';

// ── #1 GET /v1/dashboard/realized-revenue ─────────────────────────────────────
// @see apps/core/.../analytics/internal/domain/metrics/revenue-snapshot.ts:35-47 (RevenueSnapshot)

export const RevenueSnapshotSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('no_data'),
    as_of: z.string(), // YYYY-MM-DD
    realized: z.null(),
    provisional: z.null(),
  }),
  z.object({
    state: z.literal('has_data'),
    as_of: z.string(),
    realized: MoneyRecordSchema,
    provisional: MoneyRecordSchema, // empty {} when no provisional rows
    // FX convenience view (display-only): realized/provisional rolled up to the brand's PRIMARY
    // currency at the latest rate. The per-currency `realized`/`provisional` maps remain the source
    // of truth. null when there's nothing to convert or FX was unavailable.
    primary_currency: z.string().nullable().optional(),
    realized_in_primary_minor: MinorUnitsSchema.nullable().optional(),
    provisional_in_primary_minor: MinorUnitsSchema.nullable().optional(),
  }),
]);
export type RevenueSnapshot = z.infer<typeof RevenueSnapshotSchema>;

// ── #2 GET /v1/analytics/kpi-summary ──────────────────────────────────────────
// @see apps/core/.../analytics/.../get-kpi-summary.ts:11-22 (KpiSummaryDto, KpiSummaryResult)

export const KpiSummaryDtoSchema = z.object({
  currency_code: z.string(),
  realized_minor: MinorUnitsSchema,
  provisional_minor: MinorUnitsSchema,
  order_count: MinorUnitsSchema, // bigint → string (a count, but serialized identically)
  aov_minor: MinorUnitsSchema,
  rto_rate_pct: z.string(), // numeric string e.g. '3.25'
});
export type KpiSummaryDto = z.infer<typeof KpiSummaryDtoSchema>;

export const KpiSummarySchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('no_data'), as_of: z.string() }),
  z.object({
    state: z.literal('has_data'),
    as_of: z.string(),
    // Data-coverage window the (cumulative) KPIs span — earliest/latest recognised order date.
    // Surfaced in the UI as the metric's timeframe so a brand can verify the period. ISO date,
    // nullable + optional (older cached payloads / empty-ledger edge may omit it).
    coverage_start: z.string().nullable().optional(),
    coverage_end: z.string().nullable().optional(),
    kpis: z.array(KpiSummaryDtoSchema),
  }),
]);
export type KpiSummary = z.infer<typeof KpiSummarySchema>;

// ── #3 GET /v1/analytics/attribution/by-channel ───────────────────────────────
// @see apps/core/.../analytics/.../get-attribution-by-channel.ts:19-39

export const ChannelContributionDtoSchema = z.object({
  channel: z.string(),
  currency_code: z.string(),
  contribution_minor: MinorUnitsSchema,
});
export type ChannelContributionDto = z.infer<typeof ChannelContributionDtoSchema>;

export const AttributionByChannelSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('no_data'),
    from: z.string(),
    to: z.string(),
    model: AttributionModelIdSchema,
  }),
  // The brand HAS realized revenue but the attribution_credit_ledger is empty — the credit
  // pipeline has not populated yet. Surfaced distinctly so the UI shows "not computed" instead
  // of rendering 0%/100%-unattributed as if it were a real result (audit R-10 honesty fix).
  z.object({
    state: z.literal('not_computed'),
    from: z.string(),
    to: z.string(),
    model: AttributionModelIdSchema,
  }),
  z.object({
    state: z.literal('has_data'),
    from: z.string(),
    to: z.string(),
    model: AttributionModelIdSchema,
    currency_code: z.string().nullable(), // core sends string|null
    attributed_gmv_minor: MinorUnitsSchema,
    realized_gmv_minor: MinorUnitsSchema,
    unattributed_minor: MinorUnitsSchema,
    reconciliation_rate_pct: z.string().nullable(),
    by_channel: z.array(ChannelContributionDtoSchema),
    data_source: DataSourceSchema,
  }),
]);
export type AttributionByChannel = z.infer<typeof AttributionByChannelSchema>;

// ── #4 GET /v1/analytics/attribution/reconciliation ───────────────────────────
// @see apps/core/.../analytics/.../get-attribution-reconciliation.ts:16-29

export const AttributionReconciliationSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('no_data'),
    from: z.string(),
    to: z.string(),
    model: AttributionModelIdSchema,
  }),
  z.object({
    state: z.literal('not_computed'),
    from: z.string(),
    to: z.string(),
    model: AttributionModelIdSchema,
  }),
  z.object({
    state: z.literal('has_data'),
    from: z.string(),
    to: z.string(),
    model: AttributionModelIdSchema,
    currency_code: z.string().nullable(),
    attributed_gmv_minor: MinorUnitsSchema,
    realized_gmv_minor: MinorUnitsSchema,
    unattributed_minor: MinorUnitsSchema,
    reconciliation_rate_pct: z.string().nullable(),
    data_source: DataSourceSchema,
  }),
]);
export type AttributionReconciliation = z.infer<typeof AttributionReconciliationSchema>;

// ── #5 GET /v1/analytics/attribution/channel-roas ─────────────────────────────
// @see apps/core/.../analytics/.../get-channel-roas.ts:16-34

export const ChannelRoasDtoSchema = z.object({
  channel: z.string(),
  currency_code: z.string(),
  attributed_minor: MinorUnitsSchema,
  spend_minor: MinorUnitsSchema,
  roas_ratio: z.string().nullable(), // exact decimal string, null when spend=0 (honest)
});
export type ChannelRoasDto = z.infer<typeof ChannelRoasDtoSchema>;

export const ChannelRoasSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('no_data'),
    from: z.string(),
    to: z.string(),
    model: AttributionModelIdSchema,
  }),
  z.object({
    state: z.literal('not_computed'),
    from: z.string(),
    to: z.string(),
    model: AttributionModelIdSchema,
  }),
  z.object({
    state: z.literal('has_data'),
    from: z.string(),
    to: z.string(),
    model: AttributionModelIdSchema,
    rows: z.array(ChannelRoasDtoSchema),
    data_source: DataSourceSchema,
  }),
]);
export type ChannelRoas = z.infer<typeof ChannelRoasSchema>;

// ── #6 GET /v1/analytics/journey/first-touch-mix ──────────────────────────────
// @see apps/core/.../analytics/.../get-journey-first-touch-mix.ts:27-42 (NO money column)

export const FirstTouchMixRowDtoSchema = z.object({
  channel: JourneyChannelSchema,
  count: MinorUnitsSchema, // bigint → string
  share_pct: z.string().nullable(), // 2dp string; null when total=0
});
export type FirstTouchMixRowDto = z.infer<typeof FirstTouchMixRowDtoSchema>;

export const JourneyFirstTouchMixSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('no_data') }),
  z.object({
    state: z.literal('has_data'),
    from: z.string(),
    to: z.string(),
    total: MinorUnitsSchema,
    by_channel: z.array(FirstTouchMixRowDtoSchema),
    data_source: DataSourceSchema,
  }),
]);
export type JourneyFirstTouchMix = z.infer<typeof JourneyFirstTouchMixSchema>;

// ── #7 GET /v1/analytics/journey/timeline ─────────────────────────────────────
// @see apps/core/.../analytics/.../get-journey-timeline.ts:20-47
// CRITICAL: the journey is identified by `brain_anon_id`, NOT `order_id` (historical drift).

export const TimelineTouchDtoSchema = z.object({
  touch_seq: z.number(),
  is_first_touch: z.boolean(),
  is_last_touch: z.boolean(),
  occurred_at: z.string(),
  channel: JourneyChannelSchema,
  utm_source: z.string().nullable(),
  utm_medium: z.string().nullable(),
  utm_campaign: z.string().nullable(),
  utm_term: z.string().nullable(),
  utm_content: z.string().nullable(),
  fbclid: z.string().nullable(),
  gclid: z.string().nullable(),
  ttclid: z.string().nullable(),
  referrer_host: z.string().nullable(),
  landing_path: z.string().nullable(),
  event_type: z.string(),
});
export type TimelineTouchDto = z.infer<typeof TimelineTouchDtoSchema>;

export const JourneyTimelineSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('no_data') }),
  z.object({
    state: z.literal('has_data'),
    brain_anon_id: z.string(),
    stitched: z.boolean(),
    touches: z.array(TimelineTouchDtoSchema),
    data_source: DataSourceSchema,
  }),
]);
export type JourneyTimeline = z.infer<typeof JourneyTimelineSchema>;

// ── #8 GET /v1/analytics/journey/stitch-rate ──────────────────────────────────
// @see apps/core/.../analytics/.../get-journey-stitch-rate.ts:21-31 (NO money column)

export const JourneyStitchRateSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('no_data') }),
  z.object({
    state: z.literal('has_data'),
    from: z.string(),
    to: z.string(),
    total: MinorUnitsSchema, // bigint → string (distinct anon journeys)
    stitched: MinorUnitsSchema, // bigint → string (distinct stitched journeys)
    hit_pct: z.string().nullable(), // 2dp string; null when total=0
    data_source: DataSourceSchema,
  }),
]);
export type JourneyStitchRate = z.infer<typeof JourneyStitchRateSchema>;

// ── #9 GET /v1/analytics/order-status-mix ─────────────────────────────────────
// @see apps/core/.../analytics/.../get-order-status-mix.ts:32-50

export const OrderStatusMixRowDtoSchema = z.object({
  lifecycle_state: LifecycleStateSchema,
  count: MinorUnitsSchema, // bigint → string
  share_pct: z.string().nullable(), // 2dp string; null when total=0
  value_minor: MinorUnitsSchema, // bigint → string (minor units, I-S07)
});
export type OrderStatusMixRowDto = z.infer<typeof OrderStatusMixRowDtoSchema>;

export const OrderStatusMixSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('no_data') }),
  z.object({
    state: z.literal('has_data'),
    from: z.string(),
    to: z.string(),
    currency_code: z.string(), // non-null single brand currency (Slice 1)
    total: MinorUnitsSchema,
    terminal_count: MinorUnitsSchema,
    by_state: z.array(OrderStatusMixRowDtoSchema),
    data_source: DataSourceSchema,
  }),
]);
export type OrderStatusMix = z.infer<typeof OrderStatusMixSchema>;

// ── #N CM2 / cost inputs (feat-cm2-cost-inputs) ───────────────────────────────
// @see apps/core/.../analytics/.../get-contribution-margin.ts + cost-inputs.ts

export const CostConfidenceSchema = z.enum(['Trusted', 'Estimated', 'Insufficient']);
export type CostConfidence = z.infer<typeof CostConfidenceSchema>;
export const CostScopeSchema = z.enum(['global', 'sku', 'category']);
export const CostTypeSchema = z.enum(['cogs', 'shipping', 'packaging', 'payment_fee', 'marketplace_fee']);

export const ContributionMarginDtoSchema = z.object({
  currency_code: z.string(),
  net_revenue_minor: MinorUnitsSchema,
  cogs_minor: MinorUnitsSchema,
  variable_cost_minor: MinorUnitsSchema,
  cm1_minor: MinorUnitsSchema,
  marketing_minor: MinorUnitsSchema,
  cm2_minor: MinorUnitsSchema,
  cost_confidence: CostConfidenceSchema,
});
export type ContributionMarginDto = z.infer<typeof ContributionMarginDtoSchema>;

export const ContributionMarginSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('no_data'), as_of: z.string() }),
  z.object({ state: z.literal('has_data'), as_of: z.string(), margin: ContributionMarginDtoSchema }),
]);
export type ContributionMargin = z.infer<typeof ContributionMarginSchema>;

export const CostInputDtoSchema = z.object({
  scope: CostScopeSchema,
  scope_ref: z.string(),
  cost_type: CostTypeSchema,
  amount_minor: MinorUnitsSchema.nullable(),
  pct_bps: z.number().nullable(),
  currency_code: z.string(),
  cost_confidence: CostConfidenceSchema,
  effective_from: z.string(),
});
export type CostInputDto = z.infer<typeof CostInputDtoSchema>;

export const CostInputsListSchema = z.object({ cost_inputs: z.array(CostInputDtoSchema) });
export type CostInputsList = z.infer<typeof CostInputsListSchema>;

// ── #N GET /v1/analytics/orders-list ──────────────────────────────────────────
// Paginated latest-state orders from Bronze (feat-shopify-order-depth).
// @see apps/core/.../analytics/.../get-orders-list.ts (OrdersListResult / OrderListItemDto)

export const OrderListItemDtoSchema = z.object({
  order_id: z.string(),
  occurred_at: z.string(),
  amount_minor: MinorUnitsSchema,
  currency_code: z.string(),
  payment_method: z.string().nullable(),
  financial_status: z.string().nullable(),
  fulfillment_status: z.string().nullable(),
  has_depth: z.boolean(),
  /**
   * APPROXIMATE amount in the brand's primary currency (FX-converted at the latest rate, display
   * only — the native amount_minor/currency_code remain the source of truth). null when the order
   * is already in the primary currency or FX was unavailable. Pair with the result's primary_currency.
   */
  amount_in_primary_minor: MinorUnitsSchema.nullable().optional(),
});
export type OrderListItemDto = z.infer<typeof OrderListItemDtoSchema>;

export const OrdersListSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('no_data'),
    page: z.number(),
    page_size: z.number(),
    total: MinorUnitsSchema,
  }),
  z.object({
    state: z.literal('has_data'),
    page: z.number(),
    page_size: z.number(),
    total: MinorUnitsSchema,
    orders: z.array(OrderListItemDtoSchema),
    /** The brand's primary currency — target of each order's amount_in_primary_minor (display). */
    primary_currency: z.string().optional(),
  }),
]);
export type OrdersList = z.infer<typeof OrdersListSchema>;

// ── #N GET /v1/analytics/top-products ─────────────────────────────────────────
// Per-SKU rollup (units / line GMV / order count) over the Silver order-line mart.
// @see apps/core/.../analytics/.../get-top-products.ts (TopProductsResult / TopProductDto)

export const TopProductDtoSchema = z.object({
  sku: z.string(),
  title: z.string().nullable(),
  units: MinorUnitsSchema,          // bigint → string
  line_gmv_minor: MinorUnitsSchema, // bigint → string (minor units, I-S07)
  order_count: MinorUnitsSchema,    // bigint → string
});
export type TopProductDto = z.infer<typeof TopProductDtoSchema>;

export const TopProductsSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('no_data') }),
  z.object({
    state: z.literal('has_data'),
    from: z.string(),
    to: z.string(),
    currency_code: z.string(),
    data_source: DataSourceSchema,
    products: z.array(TopProductDtoSchema),
  }),
]);
export type TopProducts = z.infer<typeof TopProductsSchema>;

// ── #N GET /v1/analytics/order-detail ─────────────────────────────────────────
// A single order's economic breakdown, read from Bronze (feat-shopify-order-depth).
// @see apps/core/.../analytics/.../get-order-detail.ts (OrderDetailResult / OrderDetailDto)

export const OrderLineItemDtoSchema = z.object({
  sku: z.string().nullable(),
  title: z.string().nullable(),
  quantity: z.number(),
  unit_price_minor: MinorUnitsSchema,
  line_total_minor: MinorUnitsSchema,
  line_discount_minor: MinorUnitsSchema,
  product_id: z.string().nullable(),
  variant_id: z.string().nullable(),
});
export type OrderLineItemDto = z.infer<typeof OrderLineItemDtoSchema>;

export const OrderTaxLineDtoSchema = z.object({
  title: z.string().nullable(),
  rate: z.number().nullable(),
  amount_minor: MinorUnitsSchema,
});
export type OrderTaxLineDto = z.infer<typeof OrderTaxLineDtoSchema>;

export const OrderDiscountCodeDtoSchema = z.object({
  code: z.string().nullable(),
  amount_minor: MinorUnitsSchema,
  type: z.string().nullable(),
});
export type OrderDiscountCodeDto = z.infer<typeof OrderDiscountCodeDtoSchema>;

export const OrderRefundDtoSchema = z.object({
  refund_id: z.string().nullable(),
  processed_at: z.string().nullable(),
  amount_minor: MinorUnitsSchema,
  reason: z.string().nullable(),
});
export type OrderRefundDto = z.infer<typeof OrderRefundDtoSchema>;

export const OrderDetailDtoSchema = z.object({
  order_id: z.string(),
  occurred_at: z.string(),
  currency_code: z.string(),
  amount_minor: MinorUnitsSchema,
  payment_method: z.string().nullable(),
  financial_status: z.string().nullable(),
  fulfillment_status: z.string().nullable(),
  cancelled_at: z.string().nullable(),
  has_depth: z.boolean(),
  line_items: z.array(OrderLineItemDtoSchema),
  tax_lines: z.array(OrderTaxLineDtoSchema),
  tax_total_minor: MinorUnitsSchema.nullable(),
  shipping_total_minor: MinorUnitsSchema.nullable(),
  discount_codes: z.array(OrderDiscountCodeDtoSchema),
  discount_total_minor: MinorUnitsSchema.nullable(),
  refunds: z.array(OrderRefundDtoSchema),
  refund_total_minor: MinorUnitsSchema.nullable(),
});
export type OrderDetailDto = z.infer<typeof OrderDetailDtoSchema>;

export const OrderDetailSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('not_found'), order_id: z.string() }),
  z.object({ state: z.literal('has_data'), order_id: z.string(), detail: OrderDetailDtoSchema }),
]);
export type OrderDetail = z.infer<typeof OrderDetailSchema>;

// ── Logistics shipment outcomes (Slice 2) — delivered/RTO + RTO% by courier/pincode ──────────
// @see apps/core/.../analytics/.../get-shipment-outcomes.ts (multi-source silver_shipment mart).
// Counts use MinorUnitsSchema (bigint-as-string, identical serialization); rto_pct is a 2dp string.

export const CourierOutcomeDtoSchema = z.object({
  courier: z.string(),
  delivered: MinorUnitsSchema,
  rto: MinorUnitsSchema,
  rto_pct: z.string().nullable(),
});
export type CourierOutcomeDto = z.infer<typeof CourierOutcomeDtoSchema>;

export const PincodeOutcomeDtoSchema = z.object({
  pincode: z.string(),
  delivered: MinorUnitsSchema,
  rto: MinorUnitsSchema,
  rto_pct: z.string().nullable(),
});
export type PincodeOutcomeDto = z.infer<typeof PincodeOutcomeDtoSchema>;

export const ShipmentOutcomesSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('no_data') }),
  z.object({
    state: z.literal('has_data'),
    from: z.string(),
    to: z.string(),
    total: MinorUnitsSchema,
    delivered: MinorUnitsSchema,
    rto: MinorUnitsSchema,
    other: MinorUnitsSchema,
    in_transit: MinorUnitsSchema,
    rto_pct: z.string().nullable(),
    by_courier: z.array(CourierOutcomeDtoSchema),
    by_pincode: z.array(PincodeOutcomeDtoSchema),
    data_source: DataSourceSchema,
  }),
]);
export type ShipmentOutcomes = z.infer<typeof ShipmentOutcomesSchema>;

// ── Logistics return funnel (SR-10) — per-return_class breakdown + completion% ────────────────
// @see apps/core/.../analytics/.../get-return-funnel.ts (silver_return mart, SR-4). Counts use
// MinorUnitsSchema (bigint-as-string, identical serialization); completion_pct is a 2dp string.
// SEPARATE from shipment outcomes: returns carry NO terminal_class (never a false forward DELIVERED).

export const ReturnClassSchema = z.enum([
  'return_initiated',
  'return_in_transit',
  'return_delivered',
  'return_completed',
  'none',
]);
export type ReturnClass = z.infer<typeof ReturnClassSchema>;

export const ReturnClassBucketDtoSchema = z.object({
  return_class: ReturnClassSchema,
  count: MinorUnitsSchema,
});
export type ReturnClassBucketDto = z.infer<typeof ReturnClassBucketDtoSchema>;

export const ReturnCourierBucketDtoSchema = z.object({
  courier: z.string(),
  total: MinorUnitsSchema,
  completed: MinorUnitsSchema,
});
export type ReturnCourierBucketDto = z.infer<typeof ReturnCourierBucketDtoSchema>;

export const ReturnFunnelSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('no_data') }),
  z.object({
    state: z.literal('has_data'),
    from: z.string(),
    to: z.string(),
    total: MinorUnitsSchema,
    completed: MinorUnitsSchema,
    in_progress: MinorUnitsSchema,
    completion_pct: z.string().nullable(),
    by_class: z.array(ReturnClassBucketDtoSchema),
    by_courier: z.array(ReturnCourierBucketDtoSchema),
    data_source: DataSourceSchema,
  }),
]);
export type ReturnFunnel = z.infer<typeof ReturnFunnelSchema>;

// ── Storefront behavior (pixel browse/search/view) — from silver_touchpoint ──────────────────
// @see apps/core/.../analytics/.../get-behavior-overview.ts. Counts use MinorUnitsSchema
// (bigint-as-string, identical serialization); share_pct is a 2dp string.

export const PageTypeBucketDtoSchema = z.object({
  page_type: z.string(),
  count: MinorUnitsSchema,
  share_pct: z.string().nullable(),
});
export type PageTypeBucketDto = z.infer<typeof PageTypeBucketDtoSchema>;

export const BrowsedItemDtoSchema = z.object({
  key: z.string(),
  count: MinorUnitsSchema,
  reach: MinorUnitsSchema,
});
export type BrowsedItemDto = z.infer<typeof BrowsedItemDtoSchema>;

export const BehaviorOverviewSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('no_data') }),
  z.object({
    state: z.literal('has_data'),
    from: z.string(),
    to: z.string(),
    sessions: MinorUnitsSchema,
    journeys: MinorUnitsSchema,
    touches: MinorUnitsSchema,
    page_type_mix: z.array(PageTypeBucketDtoSchema),
    top_products: z.array(BrowsedItemDtoSchema),
    top_searches: z.array(BrowsedItemDtoSchema),
    data_source: DataSourceSchema,
  }),
]);
export type BehaviorOverview = z.infer<typeof BehaviorOverviewSchema>;

// ── Funnel analytics — sessions → product views → cart adds → purchases (Phase H pixel) ──
export const FunnelStageDtoSchema = z.object({
  key: z.string(),
  sessions: MinorUnitsSchema,
  conversion_pct: z.string().nullable(),
  step_pct: z.string().nullable(),
});
export type FunnelStageDto = z.infer<typeof FunnelStageDtoSchema>;

export const FunnelAnalyticsSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('no_data') }),
  z.object({
    state: z.literal('has_data'),
    from: z.string(),
    to: z.string(),
    stages: z.array(FunnelStageDtoSchema),
    data_source: DataSourceSchema,
  }),
]);
export type FunnelAnalytics = z.infer<typeof FunnelAnalyticsSchema>;

// ── Abandoned cart — cart sessions converted vs abandoned (Phase H pixel) ──
export const AbandonedCartSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('no_data') }),
  z.object({
    state: z.literal('has_data'),
    from: z.string(),
    to: z.string(),
    cart_sessions: MinorUnitsSchema,
    converted_sessions: MinorUnitsSchema,
    abandoned_sessions: MinorUnitsSchema,
    abandonment_rate_pct: z.string().nullable(),
    recovery_rate_pct: z.string().nullable(),
    data_source: DataSourceSchema,
  }),
]);
export type AbandonedCart = z.infer<typeof AbandonedCartSchema>;

// ── Insight + Opportunity Engine + AI Copilot briefing (GET /v1/insights/briefing) ──────────
// @see apps/core/.../analytics/.../get-insights-briefing.ts (InsightDto / BriefingDto). Numbers come
// from the Gold marts via the metric-engine, NEVER a model. Money = bigint minor-unit strings (I-S07).
// data_source ('synthetic'|'live') is aggregated synthetic-if-any across the contributing marts so the
// /insights surface can honestly badge synthetic demo data (MK-1..MK-4).

export const InsightKindSchema = z.enum(['risk', 'opportunity', 'trend']);
export const InsightSeveritySchema = z.enum(['high', 'medium', 'low', 'info']);
export const InsightConfidenceSchema = z.enum(['high', 'medium', 'low']);

export const InsightDtoSchema = z.object({
  id: z.string(),
  detector: z.string(),
  kind: InsightKindSchema,
  severity: InsightSeveritySchema,
  title: z.string(),
  why: z.string(),
  recommended_action: z.string(),
  currency_code: z.string().nullable(),
  impact_minor: MinorUnitsSchema.nullable(),
  direction: z.enum(['up', 'down', 'flat']).nullable(),
  delta_pct: z.string().nullable(),
  confidence: InsightConfidenceSchema,
  evidence: z.record(z.union([z.string(), z.number(), z.null()])),
  // Set by the BFF once the insight is materialized as a recommendation (the audited decision loop).
  recommendation_id: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
});
export type InsightDto = z.infer<typeof InsightDtoSchema>;

export const BriefingDtoSchema = z.object({
  headline: z.string(),
  summary: z.array(z.string()),
  primary_currency: z.string().nullable(),
  counts: z.object({ risks: z.number(), opportunities: z.number(), trends: z.number() }),
  total_impact_minor: MinorUnitsSchema.nullable(),
  window: z.object({
    current: z.object({ from: z.string(), to: z.string() }),
    prior: z.object({ from: z.string(), to: z.string() }),
  }),
  source: z.literal('deterministic'),
  // Provenance of the contributing marts — 'synthetic' when ANY contributing row is synthetic.
  data_source: DataSourceSchema,
  // FRESHNESS GUARD: when the underlying gold marts were last REBUILT (dbt build time, not the
  // latest order). ISO-8601, null if unknown. `stale` = as_of older than the freshness SLO → the UI
  // warns the briefing may be out of date instead of silently serving stale insights (prod-safety:
  // if the dbt refresh cron stops, this surfaces it).
  as_of: z.string().datetime({ offset: true }).nullable().optional(),
  stale: z.boolean().optional(),
});
export type BriefingDto = z.infer<typeof BriefingDtoSchema>;

export const InsightsBriefingSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('no_data') }),
  z.object({
    state: z.literal('has_data'),
    briefing: BriefingDtoSchema,
    insights: z.array(InsightDtoSchema),
  }),
]);
export type InsightsBriefing = z.infer<typeof InsightsBriefingSchema>;

// ── Engagement — engaged (multi-touch) vs bounce sessions + avg touches (Phase H pixel) ──
export const EngagementSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('no_data') }),
  z.object({
    state: z.literal('has_data'),
    from: z.string(),
    to: z.string(),
    sessions: MinorUnitsSchema,
    touches: MinorUnitsSchema,
    engaged_sessions: MinorUnitsSchema,
    bounce_sessions: MinorUnitsSchema,
    engagement_rate_pct: z.string().nullable(),
    bounce_rate_pct: z.string().nullable(),
    avg_touches_per_session: z.string().nullable(),
    data_source: DataSourceSchema,
  }),
]);
export type Engagement = z.infer<typeof EngagementSchema>;

// ── P2 GET /v1/analytics/search — on-site search volume + reach (page_type='search' of gold_behavior) ──
// @see apps/core/.../analytics/.../get-search-behavior.ts. NO money — search is impression counting;
// every count is a bigint-as-string (MinorUnitsSchema, identical serialization).
export const SearchDayBucketDtoSchema = z.object({
  date: z.string(), // YYYY-MM-DD
  searches: MinorUnitsSchema,
  sessions: MinorUnitsSchema,
  journeys: MinorUnitsSchema,
});
export type SearchDayBucketDto = z.infer<typeof SearchDayBucketDtoSchema>;

export const SearchBehaviorSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('no_data') }),
  z.object({
    state: z.literal('has_data'),
    from: z.string(),
    to: z.string(),
    searches: MinorUnitsSchema,
    sessions: MinorUnitsSchema,
    journeys: MinorUnitsSchema,
    days: z.array(SearchDayBucketDtoSchema), // per-day series (Sparkline)
    data_source: DataSourceSchema,
  }),
]);
export type SearchBehavior = z.infer<typeof SearchBehaviorSchema>;

// ── P2 GET /v1/analytics/forms — lead-form submission counts/rates (gold_conversion_feedback) ──
// @see apps/core/.../analytics/.../get-form-conversion.ts. NO money — lead/intent + payment-reach
// counters (bigint-as-string). PII-SAFE: structural form_id + counts only. Rates are nullable 2dp
// strings (null when the denominator is 0 — honest, never 0/∞).
export const FormBucketDtoSchema = z.object({
  form_id: z.string(),
  submissions: MinorUnitsSchema,
  sessions: MinorUnitsSchema,
  journeys: MinorUnitsSchema,
  submission_rate_pct: z.string().nullable(),
});
export type FormBucketDto = z.infer<typeof FormBucketDtoSchema>;

export const FormDayBucketDtoSchema = z.object({
  date: z.string(), // YYYY-MM-DD
  submissions: MinorUnitsSchema,
  payments_succeeded: MinorUnitsSchema,
});
export type FormDayBucketDto = z.infer<typeof FormDayBucketDtoSchema>;

export const FormConversionSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('no_data') }),
  z.object({
    state: z.literal('has_data'),
    from: z.string(),
    to: z.string(),
    submissions: MinorUnitsSchema,
    sessions: MinorUnitsSchema,
    payments_succeeded: MinorUnitsSchema,
    submission_rate_pct: z.string().nullable(),
    forms: z.array(FormBucketDtoSchema),
    days: z.array(FormDayBucketDtoSchema), // per-day series (Sparkline)
    data_source: DataSourceSchema,
  }),
]);
export type FormConversion = z.infer<typeof FormConversionSchema>;

// ── #32a GET /v1/analytics/journey/paths — aggregate journey-path Sankey + drop-off ──
// @see apps/core/.../analytics/.../get-journey-paths.ts (NO money — paths are behavioral).
// One row per ordered channel PATH (top-N by journey_count) + the aggregated Sankey edges.

export const JourneyPathRowDtoSchema = z.object({
  path_signature: z.string(),
  path_length: z.number(),
  channels: z.array(z.string()), // ordered channel node sequence
  first_touch_channel: z.string(),
  last_touch_channel: z.string(),
  journey_count: MinorUnitsSchema, // bigint → string
  converted_count: MinorUnitsSchema, // bigint → string
  dropped_count: MinorUnitsSchema, // bigint → string (journey_count − converted_count)
  conversion_pct: z.string().nullable(), // 2dp string; null when journey_count = 0
  path_rank: z.number(),
});
export type JourneyPathRowDto = z.infer<typeof JourneyPathRowDtoSchema>;

export const JourneyPathLinkDtoSchema = z.object({
  step: z.number(), // 0-based transition index along the path
  from_channel: z.string(),
  to_channel: z.string(),
  journeys: MinorUnitsSchema, // bigint → string (Σ journey_count over paths with this edge)
});
export type JourneyPathLinkDto = z.infer<typeof JourneyPathLinkDtoSchema>;

export const JourneyPathsSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('no_data') }),
  z.object({
    state: z.literal('has_data'),
    total_paths: z.number(),
    total_journeys: MinorUnitsSchema, // bigint → string
    total_converted: MinorUnitsSchema, // bigint → string
    overall_conversion_pct: z.string().nullable(), // 2dp string; null when no journeys
    paths: z.array(JourneyPathRowDtoSchema),
    links: z.array(JourneyPathLinkDtoSchema),
    data_source: DataSourceSchema,
  }),
]);
export type JourneyPaths = z.infer<typeof JourneyPathsSchema>;

// ── #32b GET /v1/analytics/retention/repeat-latency — time-to-2nd-purchase median + histogram ──
// @see apps/core/.../analytics/.../get-repeat-latency.ts (NO money — integer day math only).
// Exactly six fixed, non-overlapping latency buckets per brand; brand scalars denormalized.

export const RepeatLatencyBucketDtoSchema = z.object({
  bucket_key: z.string(), // '0-7' | '8-14' | '15-30' | '31-60' | '61-90' | '90+'
  bucket_order: z.number(), // 1..6 (x-axis order)
  bucket_lo_days: z.number(), // inclusive lower day bound
  bucket_hi_days: z.number().nullable(), // inclusive upper bound; null for '90+'
  customers: MinorUnitsSchema, // bigint → string (histogram bar height)
});
export type RepeatLatencyBucketDto = z.infer<typeof RepeatLatencyBucketDtoSchema>;

export const RepeatLatencySchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('no_data'), generated_at: z.string().optional() }),
  z.object({
    state: z.literal('has_data'),
    median_days_to_second_purchase: MinorUnitsSchema.nullable(), // bigint day count; null when no repeat customers
    second_order_customers: MinorUnitsSchema, // bigint → string (median denominator)
    single_order_customers: MinorUnitsSchema, // bigint → string
    total_customers: MinorUnitsSchema, // bigint → string
    buckets: z.array(RepeatLatencyBucketDtoSchema),
    generated_at: z.string().optional(),
  }),
]);
export type RepeatLatency = z.infer<typeof RepeatLatencySchema>;

// ── #32c GET /v1/analytics/attribution/campaign-attribution — per-campaign attributed revenue + ROAS ──
// @see apps/core/.../analytics/.../get-campaign-attribution.ts (money = bigint minor + currency_code).
// One row per (platform, campaign, currency) under the selected attribution model.

export const CampaignAttributionRowDtoSchema = z.object({
  platform: z.string(),
  campaign_id: z.string(),
  campaign_name: z.string().nullable(),
  currency_code: z.string(),
  attributed_revenue_minor: MinorUnitsSchema, // bigint minor (signed, net of clawback)
  spend_minor: MinorUnitsSchema, // bigint minor
  attributed_order_count: MinorUnitsSchema, // bigint → string
  roas_bps: MinorUnitsSchema.nullable(), // integer basis points; null when spend = 0
  roas_ratio: z.string().nullable(), // roas_bps/10000 as a 4dp string; null when spend = 0
});
export type CampaignAttributionRowDto = z.infer<typeof CampaignAttributionRowDtoSchema>;

export const CampaignAttributionSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('no_data'), model: AttributionModelIdSchema }),
  z.object({
    state: z.literal('has_data'),
    model: AttributionModelIdSchema,
    rows: z.array(CampaignAttributionRowDtoSchema),
  }),
]);
export type CampaignAttribution = z.infer<typeof CampaignAttributionSchema>;

// ── #32c-ts GET /v1/analytics/attribution/campaign-timeseries — date-bucketed per-campaign/channel ──
// @see apps/core/.../analytics/.../get-campaign-timeseries.ts (money = bigint minor + currency_code).
// One row per (bucket, campaign, channel, currency) under the selected attribution model + window.

export const CampaignTimeseriesBucketDtoSchema = z.object({
  bucket: z.string(), // 'YYYY-MM-DD'
  campaign_id: z.string(),
  channel: z.string(),
  currency_code: z.string(),
  attributed_revenue_minor: MinorUnitsSchema, // bigint minor (signed, net of clawback)
});
export type CampaignTimeseriesBucketDto = z.infer<typeof CampaignTimeseriesBucketDtoSchema>;

export const CampaignTimeseriesSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('no_data'),
    from: z.string(),
    to: z.string(),
    grain: z.string(),
    model: AttributionModelIdSchema,
  }),
  z.object({
    state: z.literal('has_data'),
    from: z.string(),
    to: z.string(),
    grain: z.string(),
    model: AttributionModelIdSchema,
    buckets: z.array(CampaignTimeseriesBucketDtoSchema),
  }),
]);
export type CampaignTimeseries = z.infer<typeof CampaignTimeseriesSchema>;
