// SPEC:D.2 — tests named after the spec section (D2.compile / D2.tenancy / D2.deterministic).
import { describe, it, expect, beforeAll } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMetricRegistryFrom, type ParsedMetricRegistry } from './loader.js';
import { createFsMetricSource, yamlParse } from './infrastructure/fs-source.js';
import { compileMetric, BRAND_PREDICATE, resolveEntity } from './index.js';

const METRICS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'metrics');
const TOKEN = '${BRAND_PREDICATE}';

function occurrences(hay: string, needle: string): number {
  return hay.split(needle).length - 1;
}

describe('D2 — the compiler', () => {
  let reg: ParsedMetricRegistry;
  beforeAll(async () => {
    reg = await loadMetricRegistryFrom(createFsMetricSource(METRICS_DIR), yamlParse);
  });

  it('D2.tenancy — every compiled view embeds the brand predicate EXACTLY ONCE (compile-time row-level tenancy)', () => {
    for (const m of reg.all) {
      for (const g of compileMetric(m).grains) {
        expect(occurrences(g.viewSql, TOKEN), `${m.name}@${g.grain} view`).toBe(1);
        if (g.baseFallbackSql) {
          expect(occurrences(g.baseFallbackSql, TOKEN), `${m.name}@${g.grain} fallback`).toBe(1);
        }
      }
    }
    expect(BRAND_PREDICATE).toBe(TOKEN);
  });

  it('D2.tenancy.preagg_unscoped — Spark pre-agg refresh has NO brand predicate (batch, brand_id is a grouping key)', () => {
    for (const m of reg.all) {
      for (const g of compileMetric(m).grains) {
        if (g.preagg) {
          expect(occurrences(g.preagg.refreshSql, TOKEN)).toBe(0);
          expect(occurrences(g.preagg.createDdl, TOKEN)).toBe(0);
        }
      }
    }
  });

  it('D2.compile.interactive — interactive metrics emit a pre-agg + a slow fallback for each time grain', () => {
    for (const m of reg.all) {
      if (!m.interactive) continue;
      for (const g of compileMetric(m).grains) {
        if (g.grain === 'all') continue; // grain=all has no pre-agg
        expect(g.preagg, `${m.name}@${g.grain} preagg`).toBeDefined();
        expect(g.baseFallbackSql, `${m.name}@${g.grain} fallback`).toBeDefined();
        expect(g.preagg!.tableName).toBe(`iceberg.brain_serving.preagg_${m.name}_${g.grain}`);
      }
    }
  });

  it('D2.compile.slow_no_preagg — non-interactive metrics never emit a pre-agg', () => {
    for (const m of reg.all) {
      if (m.interactive) continue;
      for (const g of compileMetric(m).grains) {
        expect(g.preagg, `${m.name}@${g.grain}`).toBeUndefined();
      }
    }
  });

  it('D2.deterministic — every deterministic_only metric PROVABLY excludes probabilistic rows (§1.4)', () => {
    for (const m of reg.all) {
      if (m.identity_basis !== 'deterministic_only') continue;
      const binding = resolveEntity(m.entity);
      for (const g of compileMetric(m).grains) {
        if (binding.identityBasisColumn) {
          // physical-basis entity → the predicate is injected into the compiled SQL
          expect(g.viewSql.includes("identity_basis = 'deterministic'") || (g.baseFallbackSql ?? '').includes("identity_basis = 'deterministic'"))
            .toBe(true);
        } else {
          // otherwise the entity MUST be deterministic-by-construction (recorded in entities.ts)
          expect(binding.deterministicByConstruction, `${m.entity} must be deterministicByConstruction`).toBe(true);
        }
      }
    }
  });

  it('D2.compile.deterministic_pure — compiling twice yields byte-identical SQL (governance: reproducible)', () => {
    for (const m of reg.all) {
      const a = compileMetric(m);
      const b = compileMetric(m);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
  });

  it('D2.compile.cross_entity — mer/amer/cac union both entities under ONE brand predicate', () => {
    for (const name of ['mer', 'amer', 'cac']) {
      const m = reg.byName.get(name)!;
      const sql = compileMetric(m).grains[0]!.viewSql;
      expect(sql).toContain('UNION ALL');
      expect(sql).toContain("FILTER (WHERE __src = 'base')");
      expect(sql).toContain("FILTER (WHERE __src = 'cross')");
      expect(occurrences(sql, TOKEN)).toBe(1); // single param bound by the seam
    }
  });
});
