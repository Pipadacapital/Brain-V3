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

export interface McpToolSpec {
  /** Tool name — MUST NOT contain sql/write/mutate/insert/update/delete (asserted in CI). */
  readonly name: string;
  /** Always 'read' — the registry is read-only by construction. */
  readonly access: McpToolAccess;
  /** Human-readable description (surfaced to the model). */
  readonly description: string;
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
    description:
      'List the certified metric ids the assistant may bind to (the registry enum). ' +
      'Read-only; returns names only — no SQL, no number.',
  },
  {
    name: 'resolve_and_compute',
    access: 'read',
    description:
      'Resolve a natural-language question to a certified metric_binding and compute the ' +
      'number over the metric-engine sole read path, returning the binding + provenance. ' +
      'Read-only; the model selects the binding, the engine produces the number (never the model).',
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
