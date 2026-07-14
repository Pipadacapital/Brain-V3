// SPEC:D.2
/**
 * @brain/semantic-metrics — infrastructure adapters: fs directory source + YAML parser.
 *
 * node:fs and the `yaml` driver live HERE (infrastructure), never in the domain loader/compiler
 * (hexagonal boundary). Deterministic ordering (sorted by file name) so the assembled registry —
 * and everything the compiler derives from it — is reproducible.
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { buildCatalog, type SemanticMetricsCatalog } from '../catalog.js';
import { loadMetricRegistryFrom, type MetricSourcePort, type ParsedMetricRegistry, type RawMetricDoc, type YamlParsePort } from '../loader.js';

/** The injectable YAML parse PORT, backed by the `yaml` driver. */
export const yamlParse: YamlParsePort = (raw: string, source: string): unknown => {
  try {
    return parseYaml(raw);
  } catch (e) {
    throw new Error(`[semantic-metrics] YAML parse error in ${source}: ${(e as Error).message}`);
  }
};

/** Directory-backed metric source. `dir` defaults to the package's own `metrics/` folder. */
export function createFsMetricSource(dir: string): MetricSourcePort {
  return {
    async load(): Promise<readonly RawMetricDoc[]> {
      const entries = await readdir(dir);
      const yamlFiles = entries.filter((f) => f.endsWith('.yaml') || f.endsWith('.yml')).sort();
      return Promise.all(
        yamlFiles.map(async (file) => ({ source: file, raw: await readFile(join(dir, file), 'utf8') })),
      );
    },
  };
}

/** The package's own `metrics/` directory (resolves the same from src/ and dist/). */
export const PACKAGED_METRICS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'metrics');

/** Load the packaged registry from `<pkg>/metrics/*.yaml` (memoized). */
let _registry: Promise<ParsedMetricRegistry> | null = null;
export function loadPackagedRegistry(): Promise<ParsedMetricRegistry> {
  if (!_registry) _registry = loadMetricRegistryFrom(createFsMetricSource(PACKAGED_METRICS_DIR), yamlParse);
  return _registry;
}

/** Build the packaged discovery catalog (the GET /v1/semantic/metrics payload; memoized). */
let _catalog: Promise<SemanticMetricsCatalog> | null = null;
export function buildPackagedCatalog(): Promise<SemanticMetricsCatalog> {
  if (!_catalog) _catalog = loadPackagedRegistry().then((r) => buildCatalog(r.all));
  return _catalog;
}
