/**
 * mcp/dispatch-wiring.ts — the MCP MOUNT: wires the READ-ONLY dispatch to its real read seams.
 *
 * The dispatch itself (registry-driven, write-free, fail-closed) lives in @brain/ai-gateway-client so
 * the I-S08 canary (tools/isolation-fuzz) shares it verbatim. THIS file is the composition root: it
 * binds each enabled tool to its EXISTING read use-case and hands the dispatch a `McpReadSeams` surface
 * that contains ONLY read functions — there is no handle to any writer here.
 *
 *   - The INTELLIGENCE / MARKETING seams are the @brain/metric-engine reads over brain_serving.mv_*
 *     (the ai module already depends on metric-engine). brand_id is injected at the seam.
 *   - The IDENTITY seams (timeline, explainability) are CROSS-MODULE; to respect the module boundary
 *     they are INJECTED by the app assembly (main.ts) already shaped as the structural Like types,
 *     built over apps/core identity reads (getIdentityTimeline / getCustomer360). They are read-only.
 *   - The Zod I/O schemas come from @brain/contracts MCP_LOOKUP_SCHEMAS (the dispatch validates I/O).
 *
 * brand_id is ALWAYS taken from the McpPrincipal (the session), NEVER a tool input (I-S01).
 *
 * @see packages/ai-gateway-client/src/mcp-dispatch.ts
 */

import {
  dispatchMcpTool,
  type McpPrincipal,
  type McpReadSeams,
  type McpSchemaProvider,
  type SchemaLike,
  type IdentityTimelineLike,
  type IdentityExplainLike,
  type RoasParamsLike,
  type ChannelRoasLike,
  type CampaignRoasLike,
} from '@brain/ai-gateway-client';
import {
  getCustomer360Summary,
  getCustomerJourneySummary,
  computeChannelRoas,
  computeCampaignRoas,
  getCustomerScore,
  getRecommendationFeatures,
  type SilverPool,
  type AttributionModelId,
} from '@brain/metric-engine';
import { MCP_LOOKUP_SCHEMAS } from '@brain/contracts';

/**
 * The injected identity read seams (cross-module). The app assembly (main.ts) builds these over the
 * identity module's read use-cases, shaped as the structural Like types — read-only, hash-only.
 */
export interface McpIdentitySeams {
  readonly identityTimeline: (brandId: string, brainId: string) => Promise<IdentityTimelineLike>;
  readonly identityExplain: (brandId: string, brainId: string) => Promise<IdentityExplainLike>;
}

export interface McpMountDeps {
  /** The StarRocks serving pool — the metric-engine seams read brain_serving.mv_* through this. */
  readonly srPool: SilverPool;
  /** The injected, read-only identity seams (timeline + explainability). */
  readonly identity: McpIdentitySeams;
}

/** The schema provider: resolve a tool's input/output ref against the contracts Zod registry. */
const schemaProvider: McpSchemaProvider = (ref: string): SchemaLike => {
  const schema = MCP_LOOKUP_SCHEMAS[ref];
  if (schema === undefined) {
    throw new Error(`MCP mount: no Zod schema registered for ref "${ref}".`);
  }
  return schema as unknown as SchemaLike;
};

/** Build the metric-engine half of the read-seam surface (intelligence + marketing reads). */
function buildMetricEngineSeams(
  srPool: SilverPool,
): Pick<
  McpReadSeams,
  | 'customer360Summary'
  | 'customerJourneySummary'
  | 'channelRoas'
  | 'campaignRoas'
  | 'customerScore'
  | 'recommendationFeatures'
> {
  const deps = { srPool };
  const toRoas = (p: RoasParamsLike) => ({
    model: p.model as AttributionModelId,
    fromDate: p.fromDate,
    toDate: p.toDate,
  });

  return {
    customer360Summary: (brandId) => getCustomer360Summary(brandId, deps),
    customerJourneySummary: (brandId) => getCustomerJourneySummary(brandId, deps),
    channelRoas: async (brandId, params): Promise<ChannelRoasLike[]> =>
      computeChannelRoas(brandId, toRoas(params), deps),
    campaignRoas: async (brandId, params): Promise<CampaignRoasLike[]> =>
      computeCampaignRoas(brandId, toRoas(params), deps),
    // ltv_lookup needs money paired with a currency; the score mart has no currency, so fold the
    // brand's currency from the 360 summary (a single brand-level read). Honest-null when no score.
    customerScore: async (brandId, brainId) => {
      const row = await getCustomerScore(brandId, brainId, deps);
      if (row === null) return null;
      const summary = await getCustomer360Summary(brandId, deps);
      return { ...row, currencyCode: summary.currencyCode };
    },
    recommendationFeatures: (brandId) => getRecommendationFeatures(brandId, deps),
  };
}

/**
 * createMcpDispatch — the MCP MOUNT. Returns a single function the MCP server transport calls per
 * tool invocation. brand_id is read ONLY from the principal; the dispatch can call ONLY the read
 * seams; disabled tools fail closed; money leaves as a bigint-minor string + currency_code.
 */
export function createMcpDispatch(
  deps: McpMountDeps,
): (toolName: string, rawInput: unknown, principal: McpPrincipal) => Promise<unknown> {
  const seams: McpReadSeams = {
    ...buildMetricEngineSeams(deps.srPool),
    identityTimeline: deps.identity.identityTimeline,
    identityExplain: deps.identity.identityExplain,
  };

  return (toolName, rawInput, principal) =>
    dispatchMcpTool(toolName, rawInput, principal, seams, schemaProvider);
}
