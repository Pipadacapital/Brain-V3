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

  it('D2.tenancy.preagg_unscoped — pre-agg refresh has NO brand predicate (batch, brand_id is a grouping key)', () => {
    for (const m of reg.all) {
      for (const g of compileMetric(m).grains) {
        if (g.preagg) {
          expect(occurrences(g.preagg.refreshSql, TOKEN)).toBe(0);
          expect(occurrences(g.preagg.createDdl, TOKEN)).toBe(0);
          expect(occurrences(g.preagg.duckdbRefreshSql, TOKEN)).toBe(0);
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

  it('AUD-SL-10 — every pre-agg carries an ATOMIC, unscoped DuckDB rebuild the refresh cron can execute', () => {
    for (const m of reg.all) {
      for (const g of compileMetric(m).grains) {
        if (!g.preagg) continue;
        const sql = g.preagg.duckdbRefreshSql;
        // DuckDB-Iceberg has NO CREATE OR REPLACE TABLE over a REST catalog (Phase-0 gate f):
        // the atomic form is CREATE IF NOT EXISTS + ONE DELETE+INSERT TRANSACTION (a single
        // Iceberg replace commit — readers see old rows until COMMIT, never an empty table).
        expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${g.preagg.tableName}`);
        expect(sql).toContain('PARTITIONED BY (bucket(16, brand_id))');
        expect(sql).toContain('BEGIN TRANSACTION;');
        expect(sql).toContain(`DELETE FROM ${g.preagg.tableName};`);
        expect(sql).toContain(`INSERT INTO ${g.preagg.tableName}`);
        expect(sql.trim().endsWith('COMMIT;')).toBe(true);
        // Source is the TWO-PART local entity view (duckdb-serving's local brain_serving schema
        // shadows the catalog namespace); only the physical preagg_* target is three-part.
        expect(sql).toContain('FROM brain_serving.semantic_');
        // Cross-brand batch: NO brand predicate (brand_id is a grouping key; serving reads go
        // through the ${BRAND_PREDICATE}-guarded compiled views, never this table).
        expect(occurrences(sql, TOKEN)).toBe(0);
        // Same source + grouping as the dormant Spark refresh (only the DDL dialect differs).
        expect(sql).toContain('GROUP BY ');
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
