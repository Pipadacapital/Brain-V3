// SPEC:D.2
/**
 * @brain/semantic-metrics — the registry LOADER.
 *
 * Reads the `metrics/*.yaml` definitions (ONE file per metric) into a validated, name-keyed
 * registry. Hexagonal: this module is PURE — it imports no fs / yaml driver. The YAML parse and
 * directory read are injected as PORTS; the concrete adapters live in ./infrastructure. That keeps
 * the metrics-as-code contract decoupled from any parser/filesystem and lets tests feed docs inline.
 */

import { parseMetric, type MetricDefinition } from './schema.js';

/** A raw metric document: its source label (file name) + the raw YAML text. */
export interface RawMetricDoc {
  readonly source: string;
  readonly raw: string;
}

/** PORT: parse one YAML document's text into an unknown JS value. */
export type YamlParsePort = (raw: string, source: string) => unknown;

/** PORT: enumerate the raw metric documents (e.g. read `metrics/*.yaml` from disk). */
export interface MetricSourcePort {
  load(): Promise<readonly RawMetricDoc[]>;
}

/** The validated registry: name → definition + deterministic ordering + a name index. */
export interface ParsedMetricRegistry {
  readonly byName: ReadonlyMap<string, MetricDefinition>;
  readonly all: readonly MetricDefinition[];
  readonly names: readonly string[];
}

/**
 * Load + validate the registry from raw YAML docs using the injected parser. Pure, deterministic.
 * Throws on the first invalid doc, on a duplicate metric name, or on a name/file-name mismatch
 * (the file MUST be `<name>.yaml` — one metric per file, discoverable by name).
 */
export function loadMetricRegistry(docs: readonly RawMetricDoc[], parse: YamlParsePort): ParsedMetricRegistry {
  const byName = new Map<string, MetricDefinition>();
  for (const d of docs) {
    const def = parseMetric(parse(d.raw, d.source), d.source);
    const expectedFile = `${def.name}.yaml`;
    const baseName = d.source.split('/').pop() ?? d.source;
    if (baseName !== expectedFile && baseName !== `${def.name}.yml`) {
      throw new Error(
        `[semantic-metrics] metric '${def.name}' must live in '${expectedFile}', found in '${baseName}'.`,
      );
    }
    if (byName.has(def.name)) {
      throw new Error(`[semantic-metrics] duplicate metric name '${def.name}' (${d.source}).`);
    }
    byName.set(def.name, def);
  }
  const all = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { byName, all, names: all.map((m) => m.name) };
}

/** Convenience: read via the source port, then load+validate. */
export async function loadMetricRegistryFrom(
  source: MetricSourcePort,
  parse: YamlParsePort,
): Promise<ParsedMetricRegistry> {
  return loadMetricRegistry(await source.load(), parse);
}
