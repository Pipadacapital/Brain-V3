// SPEC: E
/**
 * @brain/ai-features — the registry LOADER skeleton (Wave E, scaffold-only).
 *
 * Loads the `features/*.yaml` declarations into a validated ParsedFeatureRegistry. This is a
 * LOADER ONLY (the Wave-D compiler pattern, conceptually): parse → validate → assemble. It
 * emits NO SQL, materializes NO table, computes NO value. The materialization / online-write /
 * as-of-resolution entrypoints below are NotImplemented stubs, DEFERRED to Wave E logic and
 * gated by the `features.online_serving` flag at the serving edge.
 *
 * Hexagonal: this module is PURE — it imports no fs / redis / yaml driver. YAML parsing and
 * directory reads are injected as PORTS (YamlParsePort / FeatureSourcePort); adapters live in
 * ./infrastructure. That keeps the registry contract decoupled from any concrete parser or
 * store (AMD-19 store-agnostic posture).
 */

import {
  buildRegistry,
  validateFeatureDefinition,
  type FeatureDefinition,
  type ParsedFeatureRegistry,
} from './registry.js';
import type { AiFeatureRow, AsOfFeatureQuery } from './schema.js';

/** A raw feature document read from disk (or any source): its source label + YAML text. */
export interface RawFeatureDoc {
  /** File name / identifier, used in validation error messages. */
  readonly source: string;
  /** The raw YAML text of exactly one feature declaration. */
  readonly raw: string;
}

/** PORT: parse one YAML document's text into an unknown JS value. Injected (no driver here). */
export type YamlParsePort = (raw: string, source: string) => unknown;

/** PORT: enumerate the raw feature documents (e.g. read `features/*.yaml` from disk). */
export interface FeatureSourcePort {
  load(): Promise<readonly RawFeatureDoc[]>;
}

/**
 * Load + validate the feature registry from raw YAML docs using the injected parser. Pure:
 * deterministic, no I/O. Throws FeatureDefinitionError on the first invalid/duplicate doc.
 */
export function loadFeatureRegistry(
  docs: readonly RawFeatureDoc[],
  parse: YamlParsePort,
): ParsedFeatureRegistry {
  const defs: FeatureDefinition[] = docs.map((d) => validateFeatureDefinition(parse(d.raw, d.source), d.source));
  return buildRegistry(defs);
}

/** Convenience: read via the source port, then load+validate. Still no compute. */
export async function loadFeatureRegistryFrom(
  source: FeatureSourcePort,
  parse: YamlParsePort,
): Promise<ParsedFeatureRegistry> {
  return loadFeatureRegistry(await source.load(), parse);
}

// ── DEFERRED (§PART 6.E "Deferred: computation jobs, embeddings, materialization") ──────────
// These entrypoints define the SHAPE of the deferred work and FAIL BY DESIGN. They exist so
// callers/tests can bind against a stable contract; enabling them is Wave E logic, out of scope
// for scaffolding. The serving edge additionally gates online reads behind `features.online_serving`.

/** Thrown by every deferred entrypoint — honest NotImplemented (never a silent no-op). */
export class FeatureLayerNotImplementedError extends Error {
  constructor(what: string) {
    super(`[ai-features] ${what} is not implemented in the Wave-E scaffold (deferred — see CONTRACT-E.md)`);
    this.name = 'FeatureLayerNotImplementedError';
  }
}

/**
 * DEFERRED — offline TRAINING read: resolve each requested feature by an AS-OF JOIN over the
 * Silver/Gold spine at `query.asOf` (greatest event_timestamp <= asOf), NEVER "latest".
 * AMD-19 posture R2: this reads the spine at run time; it does NOT read a precompute table.
 */
export function resolveAsOfFeatures(_query: AsOfFeatureQuery): Promise<readonly AiFeatureRow[]> {
  throw new FeatureLayerNotImplementedError('resolveAsOfFeatures (as-of training read)');
}

/**
 * DEFERRED — ONLINE materialization: write the current feature values to the Redis hash
 * `{brand_id}:feat:{entity_type}:{entity_id}` for low-latency inference. Cache, not truth.
 */
export function materializeOnline(_rows: readonly AiFeatureRow[]): Promise<void> {
  throw new FeatureLayerNotImplementedError('materializeOnline (Redis online hash write)');
}

/**
 * DEFERRED — OFFLINE materialization / backfill of the feature layer. No embeddings, no jobs.
 */
export function materializeOffline(): Promise<void> {
  throw new FeatureLayerNotImplementedError('materializeOffline (offline feature jobs / embeddings)');
}
