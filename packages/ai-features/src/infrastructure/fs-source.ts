// SPEC: E
/**
 * @brain/ai-features — infrastructure adapter: read `features/*.yaml` from disk (FeatureSourcePort).
 *
 * A thin filesystem adapter around the pure loader. node:fs lives here (infrastructure), never in
 * the domain loader/registry modules (hexagonal boundary). Deterministic ordering (sorted by file
 * name) so the assembled registry is reproducible.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FeatureSourcePort, RawFeatureDoc } from '../loader.js';

/** Directory-backed feature source. `dir` defaults to the package's own `features/` folder. */
export function createFsFeatureSource(dir: string): FeatureSourcePort {
  return {
    async load(): Promise<readonly RawFeatureDoc[]> {
      const entries = await readdir(dir);
      const yamlFiles = entries.filter((f) => f.endsWith('.yaml') || f.endsWith('.yml')).sort();
      return Promise.all(
        yamlFiles.map(async (file) => ({
          source: file,
          raw: await readFile(join(dir, file), 'utf8'),
        })),
      );
    },
  };
}
