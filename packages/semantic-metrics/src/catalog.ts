// SPEC:D.2
/**
 * @brain/semantic-metrics — the CATALOG builder.
 *
 * Turns the validated metric registry into the two DISCOVERY surfaces (§D.2 / D.4.2):
 *   • a JSON catalog served at `GET /v1/semantic/metrics` — the machine-readable metric directory
 *     (definitions + compiled view names + tenancy/determinism posture).
 *   • one MCP-shaped tool definition PER metric — the Wave-F copilot binds to these (read-only,
 *     brand_id NEVER in the input schema: it comes from the McpPrincipal, never a tool arg).
 *
 * Pure: no I/O. The compiled-catalog snapshot test (D2.catalog) pins this output.
 */

import { compileMetric, metricViewName } from './compiler.js';
import { resolveEntity } from './entities.js';
import type { MetricDefinition } from './schema.js';

/** How a deterministic_only metric PROVES probabilistic exclusion (§1.4). */
export type DeterministicExclusion = 'injected_predicate' | 'by_construction' | 'not_applicable';

/** One metric's MCP tool definition (read-only; shape mirrors @brain/ai-gateway-client McpToolSpec). */
export interface McpMetricTool {
  /** Read-only tool name — MUST NOT contain sql/write/mutate/insert/update/delete (asserted). */
  readonly name: string;
  readonly access: 'read';
  readonly description: string;
  /** The certified metric this tool binds to. */
  readonly metric: string;
  readonly version: string;
  /** JSON-Schema for the tool INPUT. brand_id is NEVER here — it comes from the principal. */
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Record<string, unknown>;
    readonly required: readonly string[];
    readonly additionalProperties: false;
  };
}

/** One metric's catalog entry — the JSON row served by GET /v1/semantic/metrics. */
export interface MetricCatalogEntry {
  readonly name: string;
  readonly version: string;
  readonly entity: string;
  readonly grain: readonly string[];
  readonly dimensions_allowed: readonly string[];
  readonly currency_handling: string;
  readonly identity_basis: string;
  readonly interactive: boolean;
  readonly owner: string;
  readonly description: string;
  readonly examples: readonly string[];
  /** grain → compiled Trino view name. */
  readonly views: Record<string, string>;
  /** Spark pre-agg table names (interactive time-grains only). */
  readonly preaggs: readonly string[];
  /** How §1.4 probabilistic-exclusion is guaranteed for this metric. */
  readonly deterministic_exclusion: DeterministicExclusion;
  readonly mcp_tool: McpMetricTool;
}

export interface SemanticMetricsCatalog {
  readonly spec: 'D.2';
  readonly generator: '@brain/semantic-metrics';
  readonly count: number;
  readonly metrics: readonly MetricCatalogEntry[];
}

/** The read-only MCP tool name for a metric (no forbidden verbs; snake_case). */
export function mcpToolName(metricName: string): string {
  return `get_metric_${metricName}`;
}

function buildMcpTool(m: MetricDefinition): McpMetricTool {
  return {
    name: mcpToolName(m.name),
    access: 'read',
    metric: m.name,
    version: m.version,
    description:
      `Read the certified '${m.name}' metric (${m.description}) at a time grain, for the ` +
      `authenticated brand. Returns governed numbers from the compiled semantic view — never SQL, ` +
      `never a model-invented figure. Currency handling: ${m.currency_handling}; identity basis: ` +
      `${m.identity_basis}.`,
    inputSchema: {
      type: 'object',
      properties: {
        grain: { type: 'string', enum: [...m.grain], description: 'Time grain to aggregate at.' },
        dimensions: {
          type: 'array',
          items: { type: 'string', enum: [...m.dimensions_allowed] },
          description: 'Optional dimensions to break the metric down by (subset of dimensions_allowed).',
        },
        date_from: { type: 'string', format: 'date', description: 'Inclusive start date (ignored at grain=all).' },
        date_to: { type: 'string', format: 'date', description: 'Inclusive end date (ignored at grain=all).' },
      },
      required: ['grain'],
      additionalProperties: false,
    },
  };
}

function deterministicExclusion(m: MetricDefinition): DeterministicExclusion {
  if (m.identity_basis !== 'deterministic_only') return 'not_applicable';
  const binding = resolveEntity(m.entity);
  if (binding.identityBasisColumn) return 'injected_predicate';
  return 'by_construction';
}

/** Build one catalog entry (also compiles to resolve the per-grain view names + pre-agg tables). */
export function buildCatalogEntry(m: MetricDefinition): MetricCatalogEntry {
  const compiled = compileMetric(m);
  const views: Record<string, string> = {};
  const preaggs: string[] = [];
  for (const g of compiled.grains) {
    views[g.grain] = metricViewName(m.name, g.grain);
    if (g.preagg) preaggs.push(g.preagg.tableName);
  }
  return {
    name: m.name,
    version: m.version,
    entity: m.entity,
    grain: m.grain,
    dimensions_allowed: m.dimensions_allowed,
    currency_handling: m.currency_handling,
    identity_basis: m.identity_basis,
    interactive: m.interactive,
    owner: m.owner,
    description: m.description,
    examples: m.examples,
    views,
    preaggs,
    deterministic_exclusion: deterministicExclusion(m),
    mcp_tool: buildMcpTool(m),
  };
}

/** Build the full catalog from the validated registry (sorted by name for determinism). */
export function buildCatalog(metrics: readonly MetricDefinition[]): SemanticMetricsCatalog {
  const entries = [...metrics]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(buildCatalogEntry);
  return { spec: 'D.2', generator: '@brain/semantic-metrics', count: entries.length, metrics: entries };
}
