/**
 * @brain/ai-gateway-client — the LLM seam for Phase 8 NLQ resolution (Track A).
 *
 * The ONLY model call in Phase 8 (cost-routing Tier-3). It resolves an NL question
 * to a CONSTRAINED metric binding over the registry enum, or honestly refuses. The
 * model can structurally emit NEITHER SQL NOR a number (resolver-schema.ts):
 *   - `metric_id` is an enum derived from the metric registry keys.
 *   - the result union has no `sql` and no numeric-answer member.
 *   - the untrusted payload is coerced fail-closed (out-of-enum/malformed → refusal).
 *
 * litellm gateway at LITELLM_BASE_URL (default http://localhost:4000), latest Claude.
 * See docs/05_Brain_Implementation_Build_Plan.md §5.
 */

export {
  ResolverClient,
  fetchTransport,
  DEFAULT_RESOLVER_MODEL,
  RESOLVER_MAX_OUTPUT_TOKENS,
  RESOLVER_TEMPERATURE,
  type GatewayTransport,
  type GatewayRequest,
  type ResolverClientConfig,
  type ResolveCall,
} from './client.js';

export {
  METRIC_ID_ENUM,
  PARAM_KEYS,
  CHANNEL_ENUM,
  buildResolverJsonSchema,
  coerceResolverResult,
  type ResolverResult,
  type BindingResult,
  type RefusalResult,
  type ResolvedParams,
  type ParamKey,
  type Channel,
} from './resolver-schema.js';

// The READ-ONLY MCP tool registry (I-S08: writeToolCount===0, CI-blocking). Lives here so
// apps/core (mount) and tools/isolation-fuzz (assertion) import the SAME registry (no drift).
export {
  MCP_TOOLS,
  writeToolCount,
  listMetricIds,
  FORBIDDEN_TOOL_NAME_SUBSTRINGS,
  type McpToolSpec,
  type McpToolAccess,
  type McpToolStatus,
  type McpReadScope,
} from './mcp-tools.js';

// The READ-ONLY MCP tool DISPATCH (Brain V4; D5 / I-S08 / I-S01). The single dispatch imported by
// BOTH apps/core (the mount, wiring the real read seams) AND tools/isolation-fuzz (the I-S08 canary).
export {
  dispatchMcpTool,
  assertSeamNamesClean,
  MCP_READ_SEAM_NAMES,
  FORBIDDEN_SEAM_NAME_SUBSTRINGS,
  NotImplementedYetError,
  McpPrincipalScopeError,
  UnknownMcpToolError,
  type McpPrincipal,
  type McpReadSeams,
  type McpSchemaProvider,
  type SchemaLike,
  type RoasParamsLike,
  type Customer360RowLike,
  type Customer360SummaryLike,
  type CustomerJourneyRowLike,
  type CustomerJourneySummaryLike,
  type TimelineEntryLike,
  type IdentityTimelineLike,
  type ExplainIdentifierLike,
  type ExplainMergeLike,
  type IdentityExplainLike,
  type ChannelRoasLike,
  type CampaignRoasLike,
  type CustomerScoreLike,
  type RecFeatureRowLike,
  type RecommendationFeaturesLike,
} from './mcp-dispatch.js';
