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
