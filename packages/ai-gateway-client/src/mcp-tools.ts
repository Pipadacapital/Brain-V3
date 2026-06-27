/**
 * mcp-tools.ts — the READ-ONLY MCP tool registry (Phase 8, D5 / I-S08).
 *
 * Lives in @brain/ai-gateway-client (the AI seam package) so BOTH apps/core (which mounts
 * the MCP over the metric-engine read path) AND tools/isolation-fuzz (the CI-blocking
 * write-tool-count assertion) import the SAME registry — Single-Primitive, no drift, and no
 * cross-rootDir import.
 *
 * I-S08 — THE MCP IS READ-ONLY BY CONSTRUCTION:
 *   - Every tool declares `access: 'read'`. There is NO write tool, NO SQL tool, NO mutation
 *     tool — and no code path to add one: a write tool would set access:'write', which the
 *     CI-blocking assertion (tools/isolation-fuzz/src/mcp.test.ts) rejects (writeToolCount===0).
 *   - The tools expose the certified metrics over the metric-engine read path (resolve →
 *     compute). NO tool emits SQL; NO tool returns a model-authored number — the model SELECTS
 *     a binding; the number comes ONLY from the engine (I-ST01 / METRICS.md §5).
 *   - The MCP mounts OVER the existing read path — no new deployable/topic/envelope.
 *
 * @see 02-architecture.md §D5
 */

import { METRIC_ID_ENUM } from './resolver-schema.js';

/** A tool's access classification. Only 'read' may ever appear in this registry (I-S08). */
export type McpToolAccess = 'read';

/**
 * A tool's lifecycle status. A `disabled-not-implemented` tool is FIRST-CLASS: it is registered,
 * carries a reason, and FAILS CLOSED at dispatch (throws NotImplementedYet) — it is NEVER faked or
 * silently returned as empty. `enabled` ⇔ a real read seam backs it.
 */
export type McpToolStatus = 'enabled' | 'disabled-not-implemented';

/**
 * The read scope a tool binds to. Distinguishes the IDENTITY graph reads (hash-only, who/why) from
 * the INTELLIGENCE aggregates (what a subject is worth, money) — the two are never coupled; brain_id
 * is the only key that crosses. There is NO write scope (the registry is read-only by construction).
 */
export type McpReadScope =
  | 'read:intelligence'
  | 'read:identity'
  | 'read:journey'
  | 'read:marketing';

export interface McpToolSpec {
  /** Tool name — MUST NOT contain sql/write/mutate/insert/update/delete (asserted in CI). */
  readonly name: string;
  /** Always 'read' — the registry is read-only by construction. */
  readonly access: McpToolAccess;
  /** Human-readable description (surfaced to the model). */
  readonly description: string;
  /** Lifecycle status — `disabled-not-implemented` tools fail closed at dispatch (never faked). */
  readonly status: McpToolStatus;
  /** The read scope this tool binds to (identity graph vs intelligence aggregate vs …). */
  readonly scope?: McpReadScope;
  /**
   * Name of the Zod INPUT schema in @brain/contracts MCP_LOOKUP_SCHEMAS. A loose string coupling so
   * this package never depends on @brain/contracts; the codegen resolves it. brand_id is NEVER in
   * any referenced input schema — the lookup key is brain_id, brand_id comes from the principal.
   */
  readonly inputSchemaRef?: string;
  /** Name of the Zod OUTPUT schema in @brain/contracts MCP_LOOKUP_SCHEMAS. Omitted for disabled tools. */
  readonly outputSchemaRef?: string;
  /** Why a `disabled-not-implemented` tool is disabled (the NotImplementedYet reason). */
  readonly notImplementedReason?: string;
}

/**
 * MCP_TOOLS — the complete, typed MCP tool registry. READ-ONLY.
 *
 * `list_metrics`        — return the 16 certified metric ids (the binding enum). No SQL, no number.
 * `resolve_and_compute` — resolve an NL question to a binding → engine number + provenance.
 *                         The number comes from the metric-engine, NEVER the model.
 */
export const MCP_TOOLS: readonly McpToolSpec[] = [
  {
    name: 'list_metrics',
    access: 'read',
    status: 'enabled',
    description:
      'List the certified metric ids the assistant may bind to (the registry enum). ' +
      'Read-only; returns names only — no SQL, no number.',
  },
  {
    name: 'resolve_and_compute',
    access: 'read',
    status: 'enabled',
    description:
      'Resolve a natural-language question to a certified metric_binding and compute the ' +
      'number over the metric-engine sole read path, returning the binding + provenance. ' +
      'Read-only; the model selects the binding, the engine produces the number (never the model).',
  },

  // ── The 9 V4 lookup tools (all access:read; brand_id from the principal, never an input) ──

  {
    name: 'customer360_lookup',
    access: 'read',
    status: 'enabled',
    scope: 'read:intelligence',
    inputSchemaRef: 'Customer360LookupInput',
    outputSchemaRef: 'Customer360LookupOutput',
    description:
      'The customer-base intelligence aggregate for the principal brand: customer count, total ' +
      'lifetime value (bigint minor units + currency_code) and top customers. Read-only; the engine ' +
      'produces every number. Honest-empty when the brand has no customers.',
  },
  {
    name: 'journey_lookup',
    access: 'read',
    status: 'enabled',
    scope: 'read:journey',
    inputSchemaRef: 'JourneyLookupInput',
    outputSchemaRef: 'JourneyLookupOutput',
    description:
      'The journey-intelligence aggregate for the principal brand: journey/conversion counts, ' +
      'touchpoint stats and top journeys. NO money. Read-only; engine-produced numbers only.',
  },
  {
    name: 'timeline_lookup',
    access: 'read',
    status: 'enabled',
    scope: 'read:identity',
    inputSchemaRef: 'TimelineLookupInput',
    outputSchemaRef: 'TimelineLookupOutput',
    description:
      'The identity DECISION timeline for one brain_id: the chronological mint/link/merge/unmerge/ ' +
      'rebind/erase log with rule_version + evidence references. Hash-only (identifier TYPES, never ' +
      'raw PII). Read-only; brand_id is from the principal.',
  },
  {
    name: 'identity_explainability_lookup',
    access: 'read',
    status: 'enabled',
    scope: 'read:identity',
    inputSchemaRef: 'IdentityExplainabilityLookupInput',
    outputSchemaRef: 'IdentityExplainabilityLookupOutput',
    description:
      'Explain WHY two profiles are the same person for one brain_id: the merge verdicts with their ' +
      'rule_version, integer 0-100 confidence and the identifier combination (12-hex salted-hash ' +
      'prefixes — never raw PII). Identity graph only; never coupled to the money aggregate. Read-only.',
  },
  {
    name: 'attribution_lookup',
    access: 'read',
    status: 'enabled',
    scope: 'read:marketing',
    inputSchemaRef: 'AttributionLookupInput',
    outputSchemaRef: 'AttributionLookupOutput',
    description:
      'Per-channel attributed revenue ÷ ad-spend (ROAS) for the principal brand over a date window ' +
      'under a chosen attribution model. Money is bigint minor units + currency_code. Read-only; ' +
      'engine-produced numbers only.',
  },
  {
    name: 'ltv_lookup',
    access: 'read',
    status: 'enabled',
    scope: 'read:intelligence',
    inputSchemaRef: 'LtvLookupInput',
    outputSchemaRef: 'LtvLookupOutput',
    description:
      'The lifetime value + RFM score for one brain_id: lifetime orders, lifetime value (bigint minor ' +
      'units + currency_code) and recency/frequency/monetary scores. Read-only; brand_id from the ' +
      'principal. Honest-empty when the subject has no score.',
  },
  {
    name: 'marketingperf_lookup',
    access: 'read',
    status: 'enabled',
    scope: 'read:marketing',
    inputSchemaRef: 'MarketingPerfLookupInput',
    outputSchemaRef: 'MarketingPerfLookupOutput',
    description:
      'Marketing performance for the principal brand over a date window under a chosen attribution ' +
      'model: per-channel AND per-campaign attributed revenue ÷ spend (ROAS). Money is bigint minor ' +
      'units + currency_code. Read-only; engine-produced numbers only.',
  },
  {
    name: 'recfeature_lookup',
    access: 'read',
    status: 'enabled',
    scope: 'read:intelligence',
    inputSchemaRef: 'RecFeatureLookupInput',
    outputSchemaRef: 'RecFeatureLookupOutput',
    description:
      'The recommendation RFM features for the principal brand: per-customer recency/frequency, ' +
      'monetary value (bigint minor units + currency_code), top channel and product breadth. ' +
      'Read-only; engine-produced numbers only. Honest-empty when the brand has no customers.',
  },
  {
    name: 'segment_lookup',
    access: 'read',
    status: 'disabled-not-implemented',
    scope: 'read:intelligence',
    inputSchemaRef: 'SegmentLookupInput',
    notImplementedReason:
      'gold_customer_segments is BRAND-grained, not a per-brain_id lookup — there is no honest ' +
      'per-subject backing read. Registered DISABLED; dispatch fails closed (NotImplementedYet). ' +
      'Do NOT fake an empty segment.',
    description:
      'DISABLED — per-subject segment membership for one brain_id. No honest per-brain_id backing ' +
      'read exists (gold_customer_segments is brand-grained). Fails closed (NotImplementedYet).',
  },
] as const;

/**
 * writeToolCount — the number of NON-read tools in the registry. MUST be 0 (I-S08).
 * Derived from the registry, not hand-maintained. The CI assertion reads THIS value.
 */
export const writeToolCount: number = MCP_TOOLS.filter((t) => t.access !== 'read').length;

/** Forbidden substrings in any tool name (text-to-SQL / mutation ban). */
export const FORBIDDEN_TOOL_NAME_SUBSTRINGS: readonly string[] = [
  'sql',
  'write',
  'mutate',
  'insert',
  'update',
  'delete',
  'upsert',
  'create',
  'drop',
];

/**
 * listMetricIds — the read tool body for `list_metrics`. Returns the certified enum only.
 * No SQL, no number — just the metric_id names the model may bind to.
 */
export function listMetricIds(): readonly string[] {
  return METRIC_ID_ENUM;
}
