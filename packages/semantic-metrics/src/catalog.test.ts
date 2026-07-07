// SPEC:D.2 — tests named after the spec section (D2.catalog) — D.4.2 discovery + MCP tool shape.
import { describe, it, expect, beforeAll } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMetricRegistryFrom, type ParsedMetricRegistry } from './loader.js';
import { createFsMetricSource, yamlParse } from './infrastructure/fs-source.js';
import { buildCatalog } from './catalog.js';

const METRICS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'metrics');
const FORBIDDEN = /(sql|write|mutate|insert|update|delete)/i;

describe('D2.catalog — the discovery catalog + MCP tool defs', () => {
  let reg: ParsedMetricRegistry;
  beforeAll(async () => {
    reg = await loadMetricRegistryFrom(createFsMetricSource(METRICS_DIR), yamlParse);
  });

  it('D2.catalog.serves_all — the catalog carries all 22 metrics as valid JSON', () => {
    const cat = buildCatalog(reg.all);
    expect(cat.count).toBe(22);
    expect(cat.metrics).toHaveLength(22);
    // round-trips through JSON (valid, serializable — the GET /v1/semantic/metrics payload)
    expect(() => JSON.parse(JSON.stringify(cat))).not.toThrow();
  });

  it('D2.catalog.views_per_grain — each metric exposes a compiled view for each declared grain', () => {
    for (const e of buildCatalog(reg.all).metrics) {
      for (const g of e.grain) {
        expect(e.views[g], `${e.name}@${g}`).toBe(`iceberg.brain_serving.mv_metric_${e.name}_${g}`);
      }
    }
  });

  it('D2.catalog.mcp_shape — one MCP-shaped tool per metric, read-only, no forbidden verbs', () => {
    for (const e of buildCatalog(reg.all).metrics) {
      const t = e.mcp_tool;
      expect(t.access).toBe('read');
      expect(t.name).toBe(`get_metric_${e.name}`);
      expect(t.name).not.toMatch(FORBIDDEN);
      expect(t.metric).toBe(e.name);
      // brand_id is NEVER a tool input — it comes from the principal.
      expect(Object.keys(t.inputSchema.properties)).not.toContain('brand_id');
      expect(t.inputSchema.required).toContain('grain');
      expect(t.inputSchema.additionalProperties).toBe(false);
      // grain enum is exactly the metric's declared grains.
      expect((t.inputSchema.properties.grain as { enum: string[] }).enum).toEqual([...e.grain]);
    }
  });

  it('D2.catalog.deterministic_exclusion — deterministic_only metrics are provably scoped', () => {
    for (const e of buildCatalog(reg.all).metrics) {
      if (e.identity_basis === 'deterministic_only') {
        expect(['injected_predicate', 'by_construction']).toContain(e.deterministic_exclusion);
      } else {
        expect(e.deterministic_exclusion).toBe('not_applicable');
      }
    }
  });

  it('D2.catalog.preaggs — interactive metrics list Spark pre-agg tables; slow metrics list none', () => {
    for (const e of buildCatalog(reg.all).metrics) {
      if (e.interactive) expect(e.preaggs.length).toBeGreaterThan(0);
      else expect(e.preaggs).toHaveLength(0);
    }
  });
});
