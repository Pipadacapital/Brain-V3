/**
 * mcp.api.v1.ts — the per-tool Zod input/output schemas for the READ-ONLY MCP lookup tools.
 *
 * Zod is the source of truth (I-E01). These schemas are the wire contract the MCP dispatch layer
 * (a later phase) validates against; the tool *registry* (names, access, status, scope) is the
 * separate single SoR in @brain/ai-gateway-client `MCP_TOOLS`. A McpToolSpec references a schema
 * here by NAME (inputSchemaRef / outputSchemaRef) — a loose string coupling so ai-gateway-client
 * never has to depend on @brain/contracts. The codegen (packages/contracts/scripts/codegen.ts)
 * joins the two: it iterates MCP_TOOLS and resolves each ref against MCP_LOOKUP_SCHEMAS below.
 *
 * INVARIANTS (NON-NEGOTIABLE — Brain V4 MCP rules):
 *  - READ-ONLY: every tool is access:'read'. There is no input that mutates anything.
 *  - brand_id is NEVER an input. It comes from the MCP PRINCIPAL (the session), never a tool arg
 *    (fixes the I-S01 divergence). The only key that crosses a tool boundary is `brain_id`.
 *  - MONEY = bigint MINOR units as a string (MinorUnitsSchema) + a sibling `currency_code`. Never a
 *    float, never a z.number(), never blended across currencies. `currency_code` may be null only on
 *    an honest-empty result (has_data=false).
 *  - HONEST-EMPTY: every output carries `has_data` — false mirrors the FIGURE_NONE pattern (no fake
 *    zero-as-data). The disabled tool (segment_lookup) has NO output schema: it fails closed.
 *  - CONFIDENCE is an INTEGER 0-100 (ConfidenceScoreSchema) — never money, never blended with money.
 *  - IDENTITY reads are HASH-ONLY (I-S02): identifier references are a 12-hex salted-hash prefix,
 *    never raw PII.
 */
import { z } from 'zod';

import { MinorUnitsSchema, AttributionModelIdSchema } from './_money.js';
import { ConfidenceScoreSchema } from './intelligence.api.v1.js';

// ── Shared lookup primitives ───────────────────────────────────────────────────

/** A non-negative bigint count serialized as a decimal string (JSON has no bigint; I-S07). */
export const BigIntCountSchema = z
  .string()
  .regex(/^\d+$/, 'non-negative bigint count as a decimal string (no float)');
export type BigIntCount = z.infer<typeof BigIntCountSchema>;

/** A calendar date `YYYY-MM-DD` — the inclusive window bound for the marketing/attribution reads. */
export const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD');
export type IsoDate = z.infer<typeof IsoDateSchema>;

/**
 * The brain_id lookup key — the ONLY key that crosses a tool boundary. brand_id is NEVER here
 * (it is taken from the MCP principal). Reused by the per-subject lookup tools.
 */
export const BrainIdLookupInputSchema = z.object({
  brain_id: z
    .string()
    .uuid()
    .describe('The resolved identity (brain_id) to look up. brand_id is from the MCP principal — never an input.'),
});
export type BrainIdLookupInput = z.infer<typeof BrainIdLookupInputSchema>;

/** No-arg input — the brand is taken from the MCP principal; the read is a brand-grained aggregate. */
export const PrincipalScopedInputSchema = z
  .object({})
  .describe('No args — brand_id is taken from the MCP principal (never an input).');
export type PrincipalScopedInput = z.infer<typeof PrincipalScopedInputSchema>;

/** A 12-hex-char salted-hash prefix — an opaque identifier reference, NEVER raw PII (I-S02). */
export const HashPrefix12Schema = z
  .string()
  .regex(/^[0-9a-f]{12}$/, '12-hex-char salted-hash prefix (opaque reference, never raw PII)');
export type HashPrefix12 = z.infer<typeof HashPrefix12Schema>;

// ── 1. customer360_lookup → getCustomer360Summary (intelligence aggregate; money) ──

const Customer360LookupInputSchema = PrincipalScopedInputSchema;

export const Customer360TopCustomerSchema = z.object({
  brain_id: z.string().uuid(),
  lifetime_orders: BigIntCountSchema,
  /** Lifetime value, bigint minor units — paired with currency_code, never blended. */
  lifetime_value_minor: MinorUnitsSchema,
  currency_code: z.string().nullable(),
  delivered_orders: BigIntCountSchema,
  rto_orders: BigIntCountSchema,
  first_identified_at: z.string().nullable(),
});
export type Customer360TopCustomer = z.infer<typeof Customer360TopCustomerSchema>;

export const Customer360LookupOutputSchema = z.object({
  has_data: z.boolean(),
  customer_count: BigIntCountSchema,
  total_lifetime_value_minor: MinorUnitsSchema,
  total_lifetime_orders: BigIntCountSchema,
  currency_code: z.string().nullable(),
  top_customers: z.array(Customer360TopCustomerSchema),
});
export type Customer360LookupOutput = z.infer<typeof Customer360LookupOutputSchema>;

// ── 2. journey_lookup → getCustomerJourneySummary (NO money) ───────────────────

const JourneyLookupInputSchema = PrincipalScopedInputSchema;

export const JourneyTopRowSchema = z.object({
  brain_anon_id: z.string(),
  touchpoint_count: BigIntCountSchema,
  distinct_channels: z.number().int(),
  distinct_sessions: BigIntCountSchema,
  first_channel: z.string().nullable(),
  last_channel: z.string().nullable(),
  first_touch_at: z.string().nullable(),
  last_touch_at: z.string().nullable(),
  converted: z.boolean(),
  days_to_convert: z.number().int().nullable(),
});
export type JourneyTopRow = z.infer<typeof JourneyTopRowSchema>;

export const JourneyLookupOutputSchema = z.object({
  has_data: z.boolean(),
  journey_count: BigIntCountSchema,
  converted_journey_count: BigIntCountSchema,
  conversion_rate_pct: z.number(),
  total_touchpoints: BigIntCountSchema,
  avg_touchpoints_per_journey: z.number(),
  avg_days_to_convert: z.number().nullable(),
  top_journeys: z.array(JourneyTopRowSchema),
});
export type JourneyLookupOutput = z.infer<typeof JourneyLookupOutputSchema>;

// ── 3. timeline_lookup → getIdentityTimeline (identity decision history; no money) ──

const TimelineLookupInputSchema = BrainIdLookupInputSchema;

export const TimelineEntrySchema = z.object({
  sequence: z.number().int(),
  action: z.string(),
  occurred_at: z.string().nullable(),
  rule_version: z.string(),
  merge_id: z.string().nullable(),
  related_brain_id: z.string().nullable(),
  /** Identifier TYPES that participated — type-only, never raw PII (I-S02). */
  identifier_types: z.array(z.string()),
  reason: z.string().nullable(),
  decision_id: z.string().nullable(),
});
export type TimelineEntry = z.infer<typeof TimelineEntrySchema>;

export const TimelineLookupOutputSchema = z.object({
  has_data: z.boolean(),
  brain_id: z.string(),
  entries: z.array(TimelineEntrySchema),
  count: z.number().int(),
});
export type TimelineLookupOutput = z.infer<typeof TimelineLookupOutputSchema>;

// ── 4. identity_explainability_lookup → explain a merge (identity graph; hash-only) ──

const IdentityExplainabilityLookupInputSchema = BrainIdLookupInputSchema;

/** One hash-only member of the identifier combination that produced a merge verdict (I-S02). */
export const IdentityComboMemberSchema = z.object({
  identifier_type: z.string(),
  /** 12-hex salted-hash prefix — opaque, never raw PII. */
  identifier_hash_prefix: HashPrefix12Schema,
});
export type IdentityComboMember = z.infer<typeof IdentityComboMemberSchema>;

export const IdentityMergeExplanationSchema = z.object({
  role: z.enum(['canonical', 'merged']),
  merged_brain_id: z.string().uuid(),
  rule_version: z.string(),
  /** ConfidenceVerdict — INTEGER 0-100, never money. */
  confidence: ConfidenceScoreSchema,
  reasons: z.array(z.string()),
  identifier_combo: z.array(IdentityComboMemberSchema),
});
export type IdentityMergeExplanation = z.infer<typeof IdentityMergeExplanationSchema>;

export const IdentityExplainabilityLookupOutputSchema = z.object({
  has_data: z.boolean(),
  brain_id: z.string().uuid(),
  role: z.enum(['canonical', 'merged']).nullable(),
  merges: z.array(IdentityMergeExplanationSchema),
});
export type IdentityExplainabilityLookupOutput = z.infer<typeof IdentityExplainabilityLookupOutputSchema>;

// ── 5. attribution_lookup → computeChannelRoas (channel attributed revenue; money) ──

export const AttributionLookupInputSchema = z.object({
  model: AttributionModelIdSchema.describe('The attribution model the credit is read under.'),
  date_from: IsoDateSchema,
  date_to: IsoDateSchema,
});
export type AttributionLookupInput = z.infer<typeof AttributionLookupInputSchema>;

export const McpChannelRoasSchema = z.object({
  channel: z.string(),
  currency_code: z.string(),
  /** Attributed revenue (net of clawback), bigint minor units. */
  attributed_minor: MinorUnitsSchema,
  /** Ad spend mapped to the channel, bigint minor units. */
  spend_minor: MinorUnitsSchema,
  /** attributed ÷ spend, 4dp string from exact operands; null when spend=0 (honest). */
  roas_ratio: z.string().nullable(),
});
export type McpChannelRoas = z.infer<typeof McpChannelRoasSchema>;

export const AttributionLookupOutputSchema = z.object({
  has_data: z.boolean(),
  model: AttributionModelIdSchema,
  channels: z.array(McpChannelRoasSchema),
});
export type AttributionLookupOutput = z.infer<typeof AttributionLookupOutputSchema>;

// ── 6. ltv_lookup → getCustomerScore / getCustomer360Summary (lifetime value; money) ──

const LtvLookupInputSchema = BrainIdLookupInputSchema;

export const LtvLookupOutputSchema = z.object({
  has_data: z.boolean(),
  brain_id: z.string().uuid(),
  lifetime_orders: BigIntCountSchema,
  /** Lifetime value, bigint minor units — paired with currency_code (nullable on empty). */
  lifetime_value_minor: MinorUnitsSchema,
  currency_code: z.string().nullable(),
  recency_score: z.number().int(),
  frequency_score: z.number().int(),
  monetary_score: z.number().int(),
  churn_risk: z.string(),
  days_since_last_order: z.number().int().nullable(),
  scored_on: z.string().nullable(),
});
export type LtvLookupOutput = z.infer<typeof LtvLookupOutputSchema>;

// ── 7. marketingperf_lookup → computeChannelRoas + computeCampaignRoas (money) ─────

export const MarketingPerfLookupInputSchema = z.object({
  model: AttributionModelIdSchema.describe('The attribution model the credit is read under.'),
  date_from: IsoDateSchema,
  date_to: IsoDateSchema,
});
export type MarketingPerfLookupInput = z.infer<typeof MarketingPerfLookupInputSchema>;

export const McpCampaignRoasSchema = z.object({
  campaign_id: z.string(),
  campaign_name: z.string().nullable(),
  currency_code: z.string(),
  attributed_minor: MinorUnitsSchema,
  spend_minor: MinorUnitsSchema,
  roas_ratio: z.string().nullable(),
});
export type McpCampaignRoas = z.infer<typeof McpCampaignRoasSchema>;

export const MarketingPerfLookupOutputSchema = z.object({
  has_data: z.boolean(),
  model: AttributionModelIdSchema,
  channels: z.array(McpChannelRoasSchema),
  campaigns: z.array(McpCampaignRoasSchema),
});
export type MarketingPerfLookupOutput = z.infer<typeof MarketingPerfLookupOutputSchema>;

// ── 8. recfeature_lookup → getRecommendationFeatures (RFM features; money) ─────────

const RecFeatureLookupInputSchema = PrincipalScopedInputSchema;

export const RecFeatureRowSchema = z.object({
  brain_id: z.string().uuid(),
  recency_days: z.number().int().nullable(),
  frequency: BigIntCountSchema,
  /** The M of RFM — lifetime value, bigint minor units, paired with currency_code. */
  monetary_minor: MinorUnitsSchema,
  currency_code: z.string().nullable(),
  top_channel: z.string().nullable(),
  distinct_products: BigIntCountSchema,
  tenure_days: z.number().int().nullable(),
});
export type RecFeatureRow = z.infer<typeof RecFeatureRowSchema>;

export const RecFeatureLookupOutputSchema = z.object({
  has_data: z.boolean(),
  customer_count: BigIntCountSchema,
  rows: z.array(RecFeatureRowSchema),
});
export type RecFeatureLookupOutput = z.infer<typeof RecFeatureLookupOutputSchema>;

// ── 9. segment_lookup → DISABLED (no honest per-brain_id backing read) ─────────────

/**
 * The disabled segment_lookup carries an INPUT schema (so the tool is first-class) but NO output
 * schema: gold_customer_segments is BRAND-grained, not a per-brain_id lookup. The tool is registered
 * DISABLED and FAILS CLOSED (throws NotImplementedYet) — it never fakes an empty segment. Do NOT add
 * an output schema until a per-subject segment-membership read exists.
 */
export const SegmentLookupInputSchema = z
  .object({
    brain_id: z
      .string()
      .uuid()
      .describe('The brain_id whose segment membership would be read — DISABLED (no per-subject backing).'),
  })
  .describe('DISABLED — gold_customer_segments is brand-grained; fails closed (NotImplementedYet).');
export type SegmentLookupInput = z.infer<typeof SegmentLookupInputSchema>;

// ── The schema-ref registry — the codegen join target (ref name → Zod schema) ─────

/**
 * MCP_LOOKUP_SCHEMAS — maps a McpToolSpec inputSchemaRef/outputSchemaRef string to its Zod schema.
 * The codegen iterates @brain/ai-gateway-client `MCP_TOOLS` (the single tool-registry SoR) and
 * resolves each ref here. A ref that is missing here is a build-time error (no silent drift).
 * The disabled segment_lookup has an input ref but deliberately NO output ref (it fails closed).
 */
export const MCP_LOOKUP_SCHEMAS: Readonly<Record<string, z.ZodTypeAny>> = {
  Customer360LookupInput: Customer360LookupInputSchema,
  Customer360LookupOutput: Customer360LookupOutputSchema,
  JourneyLookupInput: JourneyLookupInputSchema,
  JourneyLookupOutput: JourneyLookupOutputSchema,
  TimelineLookupInput: TimelineLookupInputSchema,
  TimelineLookupOutput: TimelineLookupOutputSchema,
  IdentityExplainabilityLookupInput: IdentityExplainabilityLookupInputSchema,
  IdentityExplainabilityLookupOutput: IdentityExplainabilityLookupOutputSchema,
  AttributionLookupInput: AttributionLookupInputSchema,
  AttributionLookupOutput: AttributionLookupOutputSchema,
  LtvLookupInput: LtvLookupInputSchema,
  LtvLookupOutput: LtvLookupOutputSchema,
  MarketingPerfLookupInput: MarketingPerfLookupInputSchema,
  MarketingPerfLookupOutput: MarketingPerfLookupOutputSchema,
  RecFeatureLookupInput: RecFeatureLookupInputSchema,
  RecFeatureLookupOutput: RecFeatureLookupOutputSchema,
  SegmentLookupInput: SegmentLookupInputSchema,
} as const;
