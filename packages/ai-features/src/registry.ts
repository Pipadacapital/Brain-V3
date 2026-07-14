// SPEC: E
/**
 * @brain/ai-features — the FEATURE REGISTRY contract (Wave E, scaffold-only).
 *
 * §PART 6.E: "Registry packages/ai-features YAML per feature {name, entity, dtype, source,
 * freshness_sla, owner, pii}; PII features join shred manifest."
 *
 * A feature is DECLARED as one YAML document under `features/*.yaml`. This module defines the
 * typed shape of a declaration and a pure validator. It is the store-agnostic SOURCE OF TRUTH
 * for which features EXIST and their metadata — analogous to the Wave-D semantic-metrics
 * registry pattern (YAML-as-code, PR-governed). NO computation is derived here (the compiler /
 * materializer is DEFERRED — CONTRACT-E.md §Deferred).
 */

import { isFeatureDtype, isFeatureEntityType, type FeatureDtype, type FeatureEntityType } from './schema.js';

/**
 * One feature declaration (the parsed, validated form of a `features/<name>.yaml` document).
 * Every field is required except `currency` (money features only) and `description`.
 */
export interface FeatureDefinition {
  /** Registry key, unique across the whole registry. Snake_case. Also the EAV `feature_name`. */
  readonly name: string;
  /** The entity this feature describes (customer | product | campaign). */
  readonly entity: FeatureEntityType;
  /** The physical value type (double | long | string | vector). */
  readonly dtype: FeatureDtype;
  /**
   * The upstream SOURCE, expressed as a reference into the Wave-D semantic layer — either a
   * certified metric (`metric:<metric_name>`) or a semantic entity field (`entity:<entity>.<field>`).
   * String-typed & opaque here; the (deferred) compiler resolves it. Keeps this registry
   * store-agnostic and decoupled from any Spark/Trino wiring.
   */
  readonly source: string;
  /** Freshness SLA, e.g. `realtime` | `hourly` | `daily` | an ISO-8601 duration. Opaque string. */
  readonly freshness_sla: string;
  /** Owning team/person (accountability; shown in the catalog). */
  readonly owner: string;
  /**
   * Does this feature derive from / expose subject PII? PII-flagged features MUST be registered
   * in knowledge-base/privacy/shred-manifest.md (§1.9 invariant 3) — enforced by convention +
   * the CONTRACT-E note; a crypto-shred of the subject neutralizes their materialized value.
   */
  readonly pii: boolean;
  /** ISO-4217 currency for a `long` MONEY feature (§1.2). Omitted for non-money features. */
  readonly currency?: string;
  /** Optional one-line human description for the catalog. */
  readonly description?: string;
}

/** The validated, in-memory registry: name → definition, plus deterministic ordering. */
export interface ParsedFeatureRegistry {
  readonly byName: ReadonlyMap<string, FeatureDefinition>;
  readonly all: readonly FeatureDefinition[];
  /** Names of features flagged pii:true — the set that MUST appear in the shred manifest. */
  readonly piiFeatureNames: readonly string[];
}

/** A validation failure carrying the offending source (file/name) for operator diagnostics. */
export class FeatureDefinitionError extends Error {
  constructor(
    message: string,
    readonly source: string,
  ) {
    super(`[ai-features] ${source}: ${message}`);
    this.name = 'FeatureDefinitionError';
  }
}

const NAME_RE = /^[a-z][a-z0-9_]*$/;

/**
 * Validate one raw (parsed-from-YAML) object into a FeatureDefinition. Pure, throws
 * FeatureDefinitionError on any violation. `source` is the file/name for error messages.
 */
export function validateFeatureDefinition(raw: unknown, source: string): FeatureDefinition {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new FeatureDefinitionError('expected a YAML mapping', source);
  }
  const o = raw as Record<string, unknown>;

  const name = o.name;
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new FeatureDefinitionError(`invalid or missing "name" (snake_case required)`, source);
  }
  if (!isFeatureEntityType(o.entity)) {
    throw new FeatureDefinitionError(`"entity" must be customer|product|campaign`, source);
  }
  if (!isFeatureDtype(o.dtype)) {
    throw new FeatureDefinitionError(`"dtype" must be double|long|string|vector`, source);
  }
  if (typeof o.source !== 'string' || o.source.length === 0) {
    throw new FeatureDefinitionError(`"source" (metric:… | entity:…) is required`, source);
  }
  if (typeof o.freshness_sla !== 'string' || o.freshness_sla.length === 0) {
    throw new FeatureDefinitionError(`"freshness_sla" is required`, source);
  }
  if (typeof o.owner !== 'string' || o.owner.length === 0) {
    throw new FeatureDefinitionError(`"owner" is required`, source);
  }
  if (typeof o.pii !== 'boolean') {
    throw new FeatureDefinitionError(`"pii" must be a boolean`, source);
  }
  if (o.currency !== undefined && typeof o.currency !== 'string') {
    throw new FeatureDefinitionError(`"currency" must be an ISO-4217 string when present`, source);
  }
  if (o.description !== undefined && typeof o.description !== 'string') {
    throw new FeatureDefinitionError(`"description" must be a string when present`, source);
  }

  return {
    name,
    entity: o.entity,
    dtype: o.dtype,
    source: o.source,
    freshness_sla: o.freshness_sla,
    owner: o.owner,
    pii: o.pii,
    ...(o.currency !== undefined ? { currency: o.currency as string } : {}),
    ...(o.description !== undefined ? { description: o.description as string } : {}),
  };
}

/** Assemble validated definitions into a registry, rejecting duplicate names. Pure. */
export function buildRegistry(defs: readonly FeatureDefinition[]): ParsedFeatureRegistry {
  const byName = new Map<string, FeatureDefinition>();
  for (const d of defs) {
    if (byName.has(d.name)) {
      throw new FeatureDefinitionError(`duplicate feature name "${d.name}"`, d.name);
    }
    byName.set(d.name, d);
  }
  const all = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  const piiFeatureNames = all.filter((d) => d.pii).map((d) => d.name);
  return { byName, all, piiFeatureNames };
}
