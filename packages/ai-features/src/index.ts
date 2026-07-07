// SPEC: E
/**
 * @brain/ai-features — the AI Feature Layer contract package (Wave E, SCAFFOLD ONLY).
 *
 * Public surface:
 *   schema.ts    — the PIT EAV `gold_ai_features` row contract, typed value union, the online
 *                  Redis-hash contract, and the as-of training-read discipline (types only).
 *   registry.ts  — the YAML-per-feature declaration shape + pure validator/assembler.
 *   loader.ts    — the registry loader skeleton + DEFERRED NotImplemented compute stubs.
 *   infrastructure/ — a minimal flat-YAML parser + an fs directory source (adapters).
 *
 * NO computation, materialization, or embeddings ship here (see CONTRACT-E.md §Deferred).
 * AMD-19 posture: store-agnostic, as-of over Silver/Gold — no new precompute table (guard-safe).
 */

export {
  type FeatureEntityType,
  FEATURE_ENTITY_TYPES,
  isFeatureEntityType,
  type FeatureDtype,
  FEATURE_DTYPES,
  isFeatureDtype,
  type FeatureValue,
  type AiFeatureRow,
  type AsOfFeatureQuery,
  ONLINE_FEATURE_KEY_PREFIX,
  onlineFeatureKeyTemplate,
} from './schema.js';

export {
  type FeatureDefinition,
  type ParsedFeatureRegistry,
  FeatureDefinitionError,
  validateFeatureDefinition,
  buildRegistry,
} from './registry.js';

export {
  type RawFeatureDoc,
  type YamlParsePort,
  type FeatureSourcePort,
  loadFeatureRegistry,
  loadFeatureRegistryFrom,
  FeatureLayerNotImplementedError,
  resolveAsOfFeatures,
  materializeOnline,
  materializeOffline,
} from './loader.js';

export { parseFlatFeatureYaml } from './infrastructure/flat-yaml.js';
export { createFsFeatureSource } from './infrastructure/fs-source.js';
