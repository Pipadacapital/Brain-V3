// SPEC:D.2 — the GOVERNANCE snapshot test (D2.snapshot).
//
// Pins every committed artifact under src/generated/** to a FRESH compile of metrics/*.yaml.
// A metric-definition change that is not recompiled (or a hand-edit of generated SQL) fails here —
// silent drift is impossible (§D.2 governance: YAML-only changes → recompile → this test).
import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMetricRegistryFrom, type ParsedMetricRegistry } from './loader.js';
import { createFsMetricSource, yamlParse } from './infrastructure/fs-source.js';
import { compileMetric } from './compiler.js';
import { buildCatalog } from './catalog.js';
import { emitTypes } from './cli.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const METRICS_DIR = join(HERE, '..', 'metrics');
const GEN = join(HERE, 'generated');

async function read(rel: string): Promise<string> {
  return readFile(join(GEN, rel), 'utf8');
}

describe('D2.snapshot — committed generated/** equals a fresh compile (drift guard)', () => {
  let reg: ParsedMetricRegistry;
  beforeAll(async () => {
    reg = await loadMetricRegistryFrom(createFsMetricSource(METRICS_DIR), yamlParse);
  });

  it('D2.snapshot.views — every compiled view + fallback matches its committed .sql', async () => {
    for (const m of reg.all) {
      for (const g of compileMetric(m).grains) {
        expect(await read(join('views', `${m.name}_${g.grain}.sql`)), `${m.name}_${g.grain}.sql`).toBe(g.viewSql);
        if (g.baseFallbackSql) {
          expect(await read(join('views', `${m.name}_${g.grain}_slow.sql`))).toBe(g.baseFallbackSql);
        }
      }
    }
  });

  it('D2.snapshot.preaggs — every pre-agg DDL+refresh matches its committed .sql', async () => {
    for (const m of reg.all) {
      for (const g of compileMetric(m).grains) {
        if (g.preagg) {
          expect(await read(join('preaggs', `${m.name}_${g.grain}.sql`))).toBe(`${g.preagg.createDdl}\n${g.preagg.refreshSql}`);
        }
      }
    }
  });

  it('D2.snapshot.catalog — committed catalog.json matches a fresh build', async () => {
    const fresh = JSON.stringify(buildCatalog(reg.all), null, 2) + '\n';
    expect(await read('catalog.json')).toBe(fresh);
  });

  it('D2.snapshot.types — committed metric-ids.ts matches a fresh emit', async () => {
    expect(await read('metric-ids.ts')).toBe(emitTypes(reg));
  });
});
