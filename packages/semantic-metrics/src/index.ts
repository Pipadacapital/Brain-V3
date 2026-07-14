// SPEC:D.2
/**
 * @brain/semantic-metrics — the Wave-D metric DEFINITION registry + compiler (metrics-as-code).
 *
 * Public surface:
 *   schema.ts     — the exact shape of a `metrics/<name>.yaml` doc + the pure validator (fail-closed).
 *   entities.ts   — semantic ENTITY → physical Iceberg object + §1.4 basis metadata + ${BRAND_PREDICATE}.
 *   loader.ts     — load `metrics/*.yaml` → a validated, name-keyed registry (hexagonal ports).
 *   compiler.ts   — a validated metric → compiled Trino views (+ Spark pre-aggs for interactive).
 *   catalog.ts    — the JSON discovery catalog + one MCP-shaped tool per metric.
 *   infrastructure/ — the fs directory source + `yaml` parser adapters.
 *
 * Governance (§D.2): metric definitions change ONLY via a YAML PR → the compiler regenerates
 * `generated/**` → the D2.snapshot test pins each metric's SQL. Every compiled view embeds the
 * ${BRAND_PREDICATE} sentinel (compile-time row-level tenancy, AMD-07 D3). Behind `semantic.serving`
 * where it changes serving (the flag is registered in @brain/platform-flags).
 */

export {
  SEMANTIC_ENTITIES,
  type SemanticEntity,
  TIME_GRAINS,
  type TimeGrain,
  CURRENCY_HANDLING,
  type CurrencyHandling,
  IDENTITY_BASIS,
  type IdentityBasis,
  measureSchema,
  type Measure,
  crossSchema,
  type Cross,
  metricSchema,
  type MetricDefinition,
  parseMetric,
} from './schema.js';

export {
  BRAND_PREDICATE,
  ENTITY_BINDINGS,
  type EntityBinding,
  resolveEntity,
} from './entities.js';

export {
  type RawMetricDoc,
  type YamlParsePort,
  type MetricSourcePort,
  type ParsedMetricRegistry,
  loadMetricRegistry,
  loadMetricRegistryFrom,
} from './loader.js';

export {
  type CompiledPreagg,
  type CompiledGrain,
  type CompiledMetric,
  metricViewName,
  compileMetric,
} from './compiler.js';

export {
  type DeterministicExclusion,
  type McpMetricTool,
  type MetricCatalogEntry,
  type SemanticMetricsCatalog,
  mcpToolName,
  buildCatalogEntry,
  buildCatalog,
} from './catalog.js';

export {
  yamlParse,
  createFsMetricSource,
  PACKAGED_METRICS_DIR,
  loadPackagedRegistry,
  buildPackagedCatalog,
} from './infrastructure/fs-source.js';
