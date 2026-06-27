/**
 * mcp-dispatch.ts — the READ-ONLY MCP tool DISPATCH (Brain V4; D5 / I-S08 / I-S01).
 *
 * This is the runtime that turns a tool NAME + a validated input into an engine-produced answer.
 * It lives in @brain/ai-gateway-client (alongside the MCP_TOOLS registry SoR) so BOTH apps/core
 * (which wires the real read seams and mounts the dispatch) AND tools/isolation-fuzz (the CI-blocking
 * I-S08 canary) import the SAME dispatch — no drift, no cross-rootDir source import.
 *
 * NON-NEGOTIABLE INVARIANTS (the canary in tools/isolation-fuzz asserts these):
 *   - READ-ONLY BY CONSTRUCTION. The dispatch can call ONLY the read seams in `McpReadSeams` — a
 *     surface of pure read functions. There is NO handle to any writer (identity-graph mutate, Gold
 *     write, Decision-Log write, control-plane). A writer is structurally unreachable: it is not a
 *     property of McpReadSeams, so no tool body can name it.
 *   - brand_id comes ONLY from the MCP PRINCIPAL (`principal.brandId`), NEVER a tool input (fixes the
 *     I-S01 divergence). An empty/absent principal scope FAILS CLOSED (McpPrincipalScopeError).
 *   - The MODEL selects a binding/identifier; the ENGINE produces every number. The dispatch authors
 *     NO number — it only stringifies the engine's bigints. NO tool emits SQL.
 *   - MONEY = bigint MINOR units serialized as a string + a sibling currency_code (never a float,
 *     never blended). HONEST-EMPTY (has_data=false) mirrors FIGURE_NONE.
 *   - A `disabled-not-implemented` tool FAILS CLOSED (throws NotImplementedYetError) — never faked.
 *   - There is NO replay / idempotency / algorithm-migration / backfill path reachable from any tool
 *     (those are operator-controlled; the seam-name allowlist + forbidden-substring list enforce it).
 *
 * The Zod I/O schemas (in @brain/contracts) are INJECTED via `McpSchemaProvider` so this package keeps
 * its zero dependency on @brain/contracts (a Zod schema satisfies the structural `SchemaLike`).
 *
 * @see packages/ai-gateway-client/src/mcp-tools.ts (the registry SoR) · 02-architecture.md §D5
 */

import {
  MCP_TOOLS,
  FORBIDDEN_TOOL_NAME_SUBSTRINGS,
  listMetricIds,
} from './mcp-tools.js';

// ── Principal + failure modes ───────────────────────────────────────────────────

/** The MCP principal — the ONLY source of brand scope (I-S01). brand_id is NEVER a tool input. */
export interface McpPrincipal {
  /** The tenant the session is bound to. Injected by the MCP mount from the session, not the model. */
  readonly brandId: string;
}

/** Thrown by a `disabled-not-implemented` tool — fails closed (never fakes/empties an answer). */
export class NotImplementedYetError extends Error {
  readonly code = 'NOT_IMPLEMENTED_YET';
  constructor(
    public readonly toolName: string,
    public readonly reason: string,
  ) {
    super(`MCP tool "${toolName}" is disabled and fails closed: ${reason}`);
    this.name = 'NotImplementedYetError';
  }
}

/** Thrown when the principal carries no brand scope — fail closed (tenant isolation, I-S01). */
export class McpPrincipalScopeError extends Error {
  readonly code = 'MCP_PRINCIPAL_NO_SCOPE';
  constructor(public readonly toolName: string) {
    super(`MCP tool "${toolName}" requires a brand-scoped principal; none was present (fail closed).`);
    this.name = 'McpPrincipalScopeError';
  }
}

/** Thrown when a tool name is not in the registry. */
export class UnknownMcpToolError extends Error {
  readonly code = 'MCP_UNKNOWN_TOOL';
  constructor(public readonly toolName: string) {
    super(`MCP: unknown tool "${toolName}" (not in the registry).`);
    this.name = 'UnknownMcpToolError';
  }
}

// ── Schema injection (no @brain/contracts dependency) ───────────────────────────

/** A minimal structural validator — a Zod schema satisfies this (`.parse`). */
export interface SchemaLike {
  parse(input: unknown): unknown;
}

/** Resolves a tool's input/output schema by the registry ref name (input/outputSchemaRef). */
export type McpSchemaProvider = (ref: string) => SchemaLike;

// ── Structural mirrors of the read-seam DTOs ────────────────────────────────────
// Declared locally (bigint where money/count) so this package imports no metric-engine/identity types.

export interface RoasParamsLike {
  readonly model: string;
  readonly fromDate: Date;
  readonly toDate: Date;
}

export interface Customer360RowLike {
  brainId: string;
  lifetimeOrders: bigint;
  lifetimeValueMinor: bigint;
  deliveredOrders: bigint;
  rtoOrders: bigint;
  firstIdentifiedAt: string | null;
}
export interface Customer360SummaryLike {
  hasData: boolean;
  customerCount: bigint;
  totalLifetimeValueMinor: bigint;
  totalLifetimeOrders: bigint;
  currencyCode: string | null;
  topCustomers: Customer360RowLike[];
}

export interface CustomerJourneyRowLike {
  brainAnonId: string;
  touchpointCount: bigint;
  distinctChannels: number;
  distinctSessions: bigint;
  firstChannel: string | null;
  lastChannel: string | null;
  firstTouchAt: string | null;
  lastTouchAt: string | null;
  converted: boolean;
  daysToConvert: number | null;
}
export interface CustomerJourneySummaryLike {
  hasData: boolean;
  journeyCount: bigint;
  convertedJourneyCount: bigint;
  conversionRatePct: number;
  totalTouchpoints: bigint;
  avgTouchpointsPerJourney: number;
  avgDaysToConvert: number | null;
  topJourneys: CustomerJourneyRowLike[];
}

export interface TimelineEntryLike {
  sequence: number;
  action: string;
  occurred_at: string | null;
  rule_version: string;
  merge_id: string | null;
  related_brain_id: string | null;
  identifier_types: string[];
  reason: string | null;
  decision_id: string | null;
}
export type IdentityTimelineLike =
  | { state: 'invalid'; brain_id: string }
  | { state: 'found'; brain_id: string; entries: TimelineEntryLike[]; count: number };

export interface ExplainIdentifierLike {
  identifier_type: string;
  /** 12-hex salted-hash prefix — opaque, never raw PII. */
  identifier_hash_prefix: string;
}
export interface ExplainMergeLike {
  role: 'canonical' | 'merged';
  canonical_brain_id: string;
  merged_brain_id: string;
  /** Confidence as the graph stores it (0-1 float or 0-100), normalized to int 0-100 here. */
  confidence: string;
  rule_version: string;
  reasons?: string[];
}
export type IdentityExplainLike =
  | { state: 'not_found'; brain_id: string }
  | {
      state: 'found';
      brain_id: string;
      identifiers: ExplainIdentifierLike[];
      merges: ExplainMergeLike[];
    };

export interface ChannelRoasLike {
  channel: string;
  currencyCode: string;
  attributedMinor: bigint;
  spendMinor: bigint;
  roasRatio: string | null;
}
export interface CampaignRoasLike {
  campaignId: string;
  campaignName: string | null;
  currencyCode: string;
  attributedMinor: bigint;
  spendMinor: bigint;
  roasRatio: string | null;
}

export interface CustomerScoreLike {
  brainId: string;
  recencyScore: number;
  frequencyScore: number;
  monetaryScore: number;
  churnRisk: string;
  lifetimeOrders: bigint;
  lifetimeValueMinor: bigint;
  currencyCode: string | null;
  daysSinceLastOrder: number | null;
  scoredOn: string | null;
}

export interface RecFeatureRowLike {
  brainId: string;
  recencyDays: number | null;
  frequency: bigint;
  monetaryMinor: bigint;
  currencyCode: string | null;
  topChannel: string | null;
  distinctProducts: bigint;
  tenureDays: number | null;
}
export interface RecommendationFeaturesLike {
  hasData: boolean;
  customerCount: bigint;
  rows: RecFeatureRowLike[];
}

// ── The READ-ONLY seam surface ──────────────────────────────────────────────────

/**
 * McpReadSeams — the COMPLETE surface the dispatch may call. Every member is a pure READ function
 * bound to an existing read use-case (the metric-engine seams over brain_serving.mv_*, or the core
 * identity reads). There is NO writer here — a write/replay/migration path is structurally
 * unreachable because it is not a property of this interface. brand_id is always the first arg,
 * supplied by the dispatch from the principal (never the model).
 */
export interface McpReadSeams {
  readonly customer360Summary: (brandId: string) => Promise<Customer360SummaryLike>;
  readonly customerJourneySummary: (brandId: string) => Promise<CustomerJourneySummaryLike>;
  readonly identityTimeline: (brandId: string, brainId: string) => Promise<IdentityTimelineLike>;
  readonly identityExplain: (brandId: string, brainId: string) => Promise<IdentityExplainLike>;
  readonly channelRoas: (brandId: string, params: RoasParamsLike) => Promise<ChannelRoasLike[]>;
  readonly campaignRoas: (brandId: string, params: RoasParamsLike) => Promise<CampaignRoasLike[]>;
  readonly customerScore: (brandId: string, brainId: string) => Promise<CustomerScoreLike | null>;
  readonly recommendationFeatures: (brandId: string) => Promise<RecommendationFeaturesLike>;
}

/** The frozen allowlist of read-seam names — the dispatch surface is EXACTLY these (no writer). */
export const MCP_READ_SEAM_NAMES = [
  'customer360Summary',
  'customerJourneySummary',
  'identityTimeline',
  'identityExplain',
  'channelRoas',
  'campaignRoas',
  'customerScore',
  'recommendationFeatures',
] as const satisfies readonly (keyof McpReadSeams)[];

/**
 * Substrings BANNED from any seam name. Beyond the write verbs, this bans the operator-only control
 * paths (replay / idempotency / algorithm-migration / backfill / reprocess) so they can never be
 * smuggled in as a "read" seam. The isolation-fuzz canary asserts every seam name is clean.
 */
export const FORBIDDEN_SEAM_NAME_SUBSTRINGS: readonly string[] = [
  'write',
  'insert',
  'update',
  'delete',
  'upsert',
  'create',
  'drop',
  'mutate',
  'unmerge',
  'erase',
  'replay',
  'idempot',
  'migrat',
  'backfill',
  'reprocess',
  'rebind',
];

// ── Money / number formatting (the engine produced the value; we only stringify) ──

function asMinorString(v: bigint): string {
  return v.toString();
}
function asCountString(v: bigint): string {
  return v.toString();
}

/** Normalize a graph confidence string (0-1 float or 0-100) to an INTEGER 0-100 (ConfidenceVerdict). */
function confidenceToInt(raw: string): number {
  const f = Number.parseFloat(raw);
  if (!Number.isFinite(f)) return 0;
  const pct = f <= 1 ? Math.round(f * 100) : Math.round(f);
  return Math.max(0, Math.min(100, pct));
}

const HEX12 = /^[0-9a-f]{12}$/;

// ── Per-tool mappers (engine DTO → wire output; honest-empty; money as string) ────

function mapCustomer360(s: Customer360SummaryLike): unknown {
  return {
    has_data: s.hasData,
    customer_count: asCountString(s.customerCount),
    total_lifetime_value_minor: asMinorString(s.totalLifetimeValueMinor),
    total_lifetime_orders: asCountString(s.totalLifetimeOrders),
    currency_code: s.currencyCode,
    top_customers: s.topCustomers.map((r) => ({
      brain_id: r.brainId,
      lifetime_orders: asCountString(r.lifetimeOrders),
      lifetime_value_minor: asMinorString(r.lifetimeValueMinor),
      // Per-row money is paired with the brand currency from the summary (never blended).
      currency_code: s.currencyCode,
      delivered_orders: asCountString(r.deliveredOrders),
      rto_orders: asCountString(r.rtoOrders),
      first_identified_at: r.firstIdentifiedAt,
    })),
  };
}

function mapJourney(s: CustomerJourneySummaryLike): unknown {
  return {
    has_data: s.hasData,
    journey_count: asCountString(s.journeyCount),
    converted_journey_count: asCountString(s.convertedJourneyCount),
    conversion_rate_pct: s.conversionRatePct,
    total_touchpoints: asCountString(s.totalTouchpoints),
    avg_touchpoints_per_journey: s.avgTouchpointsPerJourney,
    avg_days_to_convert: s.avgDaysToConvert,
    top_journeys: s.topJourneys.map((r) => ({
      brain_anon_id: r.brainAnonId,
      touchpoint_count: asCountString(r.touchpointCount),
      distinct_channels: r.distinctChannels,
      distinct_sessions: asCountString(r.distinctSessions),
      first_channel: r.firstChannel,
      last_channel: r.lastChannel,
      first_touch_at: r.firstTouchAt,
      last_touch_at: r.lastTouchAt,
      converted: r.converted,
      days_to_convert: r.daysToConvert,
    })),
  };
}

function mapTimeline(t: IdentityTimelineLike, brainId: string): unknown {
  if (t.state === 'invalid') {
    return { has_data: false, brain_id: brainId, entries: [], count: 0 };
  }
  return {
    has_data: t.entries.length > 0,
    brain_id: t.brain_id,
    entries: t.entries.map((e) => ({
      sequence: e.sequence,
      action: e.action,
      occurred_at: e.occurred_at,
      rule_version: e.rule_version,
      merge_id: e.merge_id,
      related_brain_id: e.related_brain_id,
      identifier_types: e.identifier_types,
      reason: e.reason,
      decision_id: e.decision_id,
    })),
    count: t.count,
  };
}

function mapExplain(x: IdentityExplainLike, brainId: string): unknown {
  if (x.state === 'not_found') {
    return { has_data: false, brain_id: brainId, role: null, merges: [] };
  }
  // The hash-only identifier combination that constitutes this identity (12-hex prefixes only).
  const combo = x.identifiers
    .filter((i) => HEX12.test(i.identifier_hash_prefix))
    .map((i) => ({
      identifier_type: i.identifier_type,
      identifier_hash_prefix: i.identifier_hash_prefix,
    }));
  const merges = x.merges.map((m) => ({
    role: m.role,
    merged_brain_id: m.merged_brain_id,
    rule_version: m.rule_version,
    confidence: confidenceToInt(m.confidence),
    reasons: m.reasons ?? [],
    identifier_combo: combo,
  }));
  const role = x.merges.length > 0 ? x.merges[0]!.role : null;
  return {
    has_data: merges.length > 0,
    brain_id: x.brain_id,
    role,
    merges,
  };
}

function mapChannelRoasRow(r: ChannelRoasLike): unknown {
  return {
    channel: r.channel,
    currency_code: r.currencyCode,
    attributed_minor: asMinorString(r.attributedMinor),
    spend_minor: asMinorString(r.spendMinor),
    roas_ratio: r.roasRatio,
  };
}
function mapCampaignRoasRow(r: CampaignRoasLike): unknown {
  return {
    campaign_id: r.campaignId,
    campaign_name: r.campaignName,
    currency_code: r.currencyCode,
    attributed_minor: asMinorString(r.attributedMinor),
    spend_minor: asMinorString(r.spendMinor),
    roas_ratio: r.roasRatio,
  };
}

function mapAttribution(model: string, channels: ChannelRoasLike[]): unknown {
  const mapped = channels.map(mapChannelRoasRow);
  return { has_data: mapped.length > 0, model, channels: mapped };
}

function mapMarketingPerf(
  model: string,
  channels: ChannelRoasLike[],
  campaigns: CampaignRoasLike[],
): unknown {
  const ch = channels.map(mapChannelRoasRow);
  const ca = campaigns.map(mapCampaignRoasRow);
  return { has_data: ch.length > 0 || ca.length > 0, model, channels: ch, campaigns: ca };
}

function mapLtv(s: CustomerScoreLike | null, brainId: string): unknown {
  if (s === null) {
    return {
      has_data: false,
      brain_id: brainId,
      lifetime_orders: '0',
      lifetime_value_minor: '0',
      currency_code: null,
      recency_score: 0,
      frequency_score: 0,
      monetary_score: 0,
      churn_risk: 'unknown',
      days_since_last_order: null,
      scored_on: null,
    };
  }
  return {
    has_data: true,
    brain_id: s.brainId,
    lifetime_orders: asCountString(s.lifetimeOrders),
    lifetime_value_minor: asMinorString(s.lifetimeValueMinor),
    currency_code: s.currencyCode,
    recency_score: s.recencyScore,
    frequency_score: s.frequencyScore,
    monetary_score: s.monetaryScore,
    churn_risk: s.churnRisk,
    days_since_last_order: s.daysSinceLastOrder,
    scored_on: s.scoredOn,
  };
}

function mapRecFeatures(r: RecommendationFeaturesLike): unknown {
  return {
    has_data: r.hasData,
    customer_count: asCountString(r.customerCount),
    rows: r.rows.map((x) => ({
      brain_id: x.brainId,
      recency_days: x.recencyDays,
      frequency: asCountString(x.frequency),
      monetary_minor: asMinorString(x.monetaryMinor),
      currency_code: x.currencyCode,
      top_channel: x.topChannel,
      distinct_products: asCountString(x.distinctProducts),
      tenure_days: x.tenureDays,
    })),
  };
}

// ── Input coercion helpers ──────────────────────────────────────────────────────

function brainIdOf(input: unknown): string {
  const o = (input ?? {}) as Record<string, unknown>;
  return typeof o['brain_id'] === 'string' ? (o['brain_id'] as string) : '';
}

function roasParamsOf(input: unknown): RoasParamsLike {
  const o = (input ?? {}) as Record<string, unknown>;
  return {
    model: String(o['model'] ?? ''),
    fromDate: new Date(String(o['date_from'] ?? '')),
    toDate: new Date(String(o['date_to'] ?? '')),
  };
}

// ── The dispatch ────────────────────────────────────────────────────────────────

/**
 * dispatchMcpTool — execute a registered, ENABLED, read-only MCP tool.
 *
 * @param toolName  - the registry tool name (e.g. 'customer360_lookup').
 * @param rawInput  - the untrusted tool input (brand_id is NEVER read from here — I-S01).
 * @param principal - the brand-scoped MCP principal (the ONLY source of brand_id).
 * @param seams     - the read-only seam surface (the dispatch can call nothing else).
 * @param schemas   - injected Zod-like schema provider (validates input + output).
 * @returns the engine-produced, schema-valid wire output (money = bigint-minor string + currency).
 *
 * Fails closed: unknown tool → UnknownMcpToolError; disabled tool → NotImplementedYetError; missing
 * principal scope → McpPrincipalScopeError.
 */
export async function dispatchMcpTool(
  toolName: string,
  rawInput: unknown,
  principal: McpPrincipal,
  seams: McpReadSeams,
  schemas: McpSchemaProvider,
): Promise<unknown> {
  const spec = MCP_TOOLS.find((t) => t.name === toolName);
  if (spec === undefined) throw new UnknownMcpToolError(toolName);

  // A disabled tool fails closed — never faked, never empty.
  if (spec.status === 'disabled-not-implemented') {
    throw new NotImplementedYetError(spec.name, spec.notImplementedReason ?? 'not implemented');
  }

  // list_metrics is the binding enum — no brand, no input, no number.
  if (spec.name === 'list_metrics') {
    return { metric_ids: listMetricIds() };
  }
  // resolve_and_compute is the NLQ resolver path, not a per-subject lookup — not dispatched here.
  if (spec.name === 'resolve_and_compute') {
    throw new Error(
      'MCP: resolve_and_compute is served by the NLQ resolver path (askBrain), not the lookup dispatch.',
    );
  }

  // brand_id comes ONLY from the principal — fail closed if the session has no brand scope (I-S01).
  const brandId = principal.brandId;
  if (typeof brandId !== 'string' || brandId.trim() === '') {
    throw new McpPrincipalScopeError(spec.name);
  }

  // Validate the untrusted input against the tool's Zod input schema (brand_id is never present).
  const input = spec.inputSchemaRef ? schemas(spec.inputSchemaRef).parse(rawInput ?? {}) : {};

  let output: unknown;
  switch (spec.name) {
    case 'customer360_lookup':
      output = mapCustomer360(await seams.customer360Summary(brandId));
      break;
    case 'journey_lookup':
      output = mapJourney(await seams.customerJourneySummary(brandId));
      break;
    case 'timeline_lookup': {
      const brainId = brainIdOf(input);
      output = mapTimeline(await seams.identityTimeline(brandId, brainId), brainId);
      break;
    }
    case 'identity_explainability_lookup': {
      const brainId = brainIdOf(input);
      output = mapExplain(await seams.identityExplain(brandId, brainId), brainId);
      break;
    }
    case 'attribution_lookup': {
      const params = roasParamsOf(input);
      output = mapAttribution(params.model, await seams.channelRoas(brandId, params));
      break;
    }
    case 'ltv_lookup': {
      const brainId = brainIdOf(input);
      output = mapLtv(await seams.customerScore(brandId, brainId), brainId);
      break;
    }
    case 'marketingperf_lookup': {
      const params = roasParamsOf(input);
      const [channels, campaigns] = await Promise.all([
        seams.channelRoas(brandId, params),
        seams.campaignRoas(brandId, params),
      ]);
      output = mapMarketingPerf(params.model, channels, campaigns);
      break;
    }
    case 'recfeature_lookup':
      output = mapRecFeatures(await seams.recommendationFeatures(brandId));
      break;
    default:
      // An ENABLED tool with no handler is a build error (the completeness test catches this).
      throw new Error(`MCP: no dispatch handler for enabled tool "${spec.name}".`);
  }

  // Validate the engine output against the tool's Zod output schema before it leaves the dispatch.
  return spec.outputSchemaRef ? schemas(spec.outputSchemaRef).parse(output) : output;
}

/**
 * assertSeamNamesClean — a self-check the canary calls: every read-seam name passes BOTH the tool-name
 * forbidden list AND the seam-name forbidden list (no write/replay/idempotency/migration path). Throws
 * on the first violation (so removing the check would surface a smuggled writer at CI).
 */
export function assertSeamNamesClean(): void {
  for (const name of MCP_READ_SEAM_NAMES) {
    const lower = name.toLowerCase();
    for (const bad of FORBIDDEN_TOOL_NAME_SUBSTRINGS) {
      if (lower.includes(bad)) throw new Error(`MCP seam "${name}" contains forbidden "${bad}"`);
    }
    for (const bad of FORBIDDEN_SEAM_NAME_SUBSTRINGS) {
      if (lower.includes(bad)) throw new Error(`MCP seam "${name}" contains forbidden "${bad}"`);
    }
  }
}
