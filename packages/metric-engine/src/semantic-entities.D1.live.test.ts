// SPEC:D.1 — Semantic ENTITY models shape/data test (Wave D).
//
// semantic-entities.D1.live.test.ts — validates the 5 thin-composition semantic entity views
// (iceberg.brain_serving.semantic_{customer,order,product,campaign,journey}) that Wave D lays over the
// already-materialized mv_*/gold_* marts. These views are COMPOSITIONS (no recompute); this test asserts
// the load-bearing Wave-D invariants on them:
//
//   D1-1  brand_id is the FIRST column of every semantic entity (tenant key).
//   D1-2  Row-level tenancy is enforced through the ${BRAND_PREDICATE} seam (withTrinoBrand injects
//         `brand_id = ?`) — a scoped read returns ONLY the requested brand's rows (Trino REST has no row
//         policy, AMD-07 D3 — the predicate injection IS the compile-time tenancy) AND the seam refuses
//         to run a query missing the sentinel (fail-closed, never cross-brand).
//   D1-3  semantic_journey exposes ONLY identity_basis='deterministic' rows (§1.4 — probabilistic overlays
//         live in a separate view, never blended into the canonical journey entity).
//   D1-4  semantic_order carries the Wave-C economics (spec CM1/CM2/CM3, AMD-17) as bigint MINOR units +
//         currency_code, plus the journey-trace pointer (brain_id + conversion_at) the Wave-B API keys on.
//   D1-5  semantic_customer's identity_basis is the honest constant 'deterministic' (customer_360 is built
//         from the deterministic identity spine only).
//
// The suite cleanly PENDINGs when Trino is unavailable / the serving views aren't provisioned (never a hard
// failure on a missing engine) — mirrors contribution-margin.live.test.ts. Requires Trino on :8090 with the
// db/trino/views/semantic_*.sql applied (VIEW_GLOB='semantic_*.sql' db/trino/views/run-trino-views.sh).
import { describe, it, expect, beforeAll } from 'vitest';
import { createTrinoPool } from './trino-adapter.js';
import { withTrinoBrand, BRAND_PREDICATE } from './trino-deps.js';
import type { TrinoPool } from './trino-deps.js';

const TRINO_URL =
  process.env['TRINO_URL'] ??
  `http://${process.env['TRINO_HOST'] ?? '127.0.0.1'}:${process.env['TRINO_PORT'] ?? '8090'}`;
const TRINO_USER = process.env['TRINO_USER'] ?? 'brain';

const SEMANTIC_VIEWS = [
  'semantic_customer',
  'semantic_order',
  'semantic_product',
  'semantic_campaign',
  'semantic_journey',
] as const;

let trino: TrinoPool;
let trinoUp = false;

/** Pick a brand_id that actually has rows in `view` (uses the sanctioned unscoped escape hatch — test-only). */
async function anyBrandWithRows(view: string): Promise<string | null> {
  const rows = await withTrinoBrand<Array<{ brand_id: string }>>(
    trino,
    '00000000-0000-0000-0000-000000000000',
    (scope) =>
      scope.runScoped<{ brand_id: string }>(
        `SELECT brand_id FROM iceberg.brain_serving.${view} WHERE ${BRAND_PREDICATE} LIMIT 1`,
      ),
    { __unsafeDisableBrandPredicate: true },
  );
  return rows[0]?.brand_id ?? null;
}

beforeAll(async () => {
  trino = createTrinoPool({ baseUrl: TRINO_URL, user: TRINO_USER });
  try {
    await trino.query('SELECT 1');
    // Confirm the serving views are provisioned (else PENDING rather than fail).
    await trino.query('SELECT count(*) FROM iceberg.brain_serving.semantic_customer');
    trinoUp = true;
  } catch {
    trinoUp = false;
  }
});

describe('SPEC:D.1 — semantic entity views (thin compositions over mv_*/gold_*)', () => {
  it('D1-1/D1-2: every entity has brand_id first + BRAND_PREDICATE seam isolates one brand', async () => {
    if (!trinoUp) {
      console.warn('[D.1] Trino unavailable — PENDING');
      return;
    }
    for (const view of SEMANTIC_VIEWS) {
      const brand = await anyBrandWithRows(view);
      if (!brand) continue; // empty entity on this dataset — nothing to isolate

      // Scoped read via the sanctioned seam: EVERY returned row must be the requested brand.
      const scoped = await withTrinoBrand<Array<Record<string, unknown>>>(trino, brand, (scope) =>
        scope.runScoped(
          `SELECT * FROM iceberg.brain_serving.${view} WHERE ${BRAND_PREDICATE} LIMIT 200`,
        ),
      );
      expect(scoped.length, `${view} should return rows for a brand known to have them`).toBeGreaterThan(0);
      // D1-1: brand_id is the first projected column.
      expect(Object.keys(scoped[0]!)[0], `${view}: brand_id must be first column`).toBe('brand_id');
      // D1-2: isolation — no cross-tenant bleed.
      for (const r of scoped) {
        expect(r['brand_id'], `${view}: scoped read leaked a foreign brand`).toBe(brand);
      }
    }
  });

  it('D1-2: seam is fail-closed — a query missing the ${BRAND_PREDICATE} sentinel is refused', async () => {
    if (!trinoUp) return;
    await expect(
      withTrinoBrand(trino, '00000000-0000-0000-0000-000000000000', (scope) =>
        scope.runScoped('SELECT * FROM iceberg.brain_serving.semantic_customer LIMIT 1'),
      ),
    ).rejects.toThrow(/BRAND_PREDICATE|sentinel/);
  });

  it('D1-3: semantic_journey exposes deterministic-basis rows only (§1.4)', async () => {
    if (!trinoUp) return;
    const brand = await anyBrandWithRows('semantic_journey');
    if (!brand) return;
    const bases = await withTrinoBrand<Array<{ identity_basis: string }>>(trino, brand, (scope) =>
      scope.runScoped<{ identity_basis: string }>(
        `SELECT DISTINCT identity_basis FROM iceberg.brain_serving.semantic_journey WHERE ${BRAND_PREDICATE}`,
      ),
    );
    for (const b of bases) {
      expect(b.identity_basis, 'semantic_journey must be deterministic-only').toBe('deterministic');
    }
  });

  it('D1-4: semantic_order carries Wave-C economics (integer minor + currency) + journey pointer', async () => {
    if (!trinoUp) return;
    const brand = await anyBrandWithRows('semantic_order');
    if (!brand) return;
    const rows = await withTrinoBrand<Array<Record<string, unknown>>>(trino, brand, (scope) =>
      scope.runScoped(
        `SELECT order_id, brain_id, conversion_at, currency_code,
                cm1_minor, cm2_minor, cm3_minor, net_revenue_minor, order_value_minor
           FROM iceberg.brain_serving.semantic_order
          WHERE ${BRAND_PREDICATE} LIMIT 50`,
      ),
    );
    expect(rows.length).toBeGreaterThan(0);
    const r0 = rows[0]!;
    // journey trace pointer: brain_id present on the row (conversion_at may be null pre-recognition).
    expect(Object.keys(r0)).toContain('brain_id');
    expect(Object.keys(r0)).toContain('conversion_at');
    // money-minor columns are integers, never floats, when present.
    for (const col of ['cm1_minor', 'cm2_minor', 'cm3_minor', 'net_revenue_minor', 'order_value_minor']) {
      for (const r of rows) {
        const v = r[col];
        if (v !== null && v !== undefined) {
          expect(Number.isInteger(Number(v)), `${col} must be integer minor units`).toBe(true);
        }
      }
    }
  });

  it('D1-5: semantic_customer.identity_basis is the honest deterministic constant', async () => {
    if (!trinoUp) return;
    const brand = await anyBrandWithRows('semantic_customer');
    if (!brand) return;
    const bases = await withTrinoBrand<Array<{ identity_basis: string }>>(trino, brand, (scope) =>
      scope.runScoped<{ identity_basis: string }>(
        `SELECT DISTINCT identity_basis FROM iceberg.brain_serving.semantic_customer WHERE ${BRAND_PREDICATE}`,
      ),
    );
    for (const b of bases) expect(b.identity_basis).toBe('deterministic');
  });
});
