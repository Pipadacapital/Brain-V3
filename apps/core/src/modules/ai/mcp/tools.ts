/**
 * mcp/tools.ts — the READ-ONLY MCP tool registry surface for the core `ai` module (D5 / I-S08).
 *
 * The registry's SINGLE SOURCE OF TRUTH lives in @brain/ai-gateway-client/mcp-tools so BOTH
 * this module (which mounts the MCP over the metric-engine read path) AND the CI-blocking
 * assertion in tools/isolation-fuzz/src/mcp.test.ts import the SAME values — no drift, and no
 * cross-package source import. This file re-exports it as the core `ai` module's MCP surface.
 *
 * I-S08: writeToolCount === 0 by construction (every tool is access:'read'); NO write/SQL/
 * mutation tool exists. The number comes ONLY from the metric-engine (I-ST01 / METRICS.md §5).
 *
 * @see packages/ai-gateway-client/src/mcp-tools.ts · 02-architecture.md §D5
 */

export {
  MCP_TOOLS,
  writeToolCount,
  listMetricIds,
  FORBIDDEN_TOOL_NAME_SUBSTRINGS,
  type McpToolSpec,
  type McpToolAccess,
} from '@brain/ai-gateway-client';
