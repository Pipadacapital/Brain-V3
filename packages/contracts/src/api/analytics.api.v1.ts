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
