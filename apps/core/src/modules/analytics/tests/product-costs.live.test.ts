// SPEC:C.2.4
/**
 * product-costs.live.test.ts — cost-sheet CSV ingest → billing.product_cost_sheet (0126/0143).
 *
 * Two parts (named after the spec section):
 *   C2.4 validation — PURE (no DB): parse + validate reject bad currency / negative cost /
 *     inverted or overlapping validity; accept a GCC 3-decimal (KWD) row with ZERO rounding.
 *   C2.4 round-trip — PG: ingest → list; idempotent re-ingest (no dup); overlap-vs-stored rejected;
 *     update-in-place; tenant isolation (brand B never sees brand A's costs).
 *
 * REQUIRES: Postgres on localhost:5432 with migration 0126 applied. The DB sections SKIP if PG is down.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import {
  parseCostSheetCsv,
  validateProductCostRows,
  ingestProductCosts,
  listProductCosts,
  type ProductCostRow,
} from '../index.js';

const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const BRAND_A = 'c2400a1a-0a1a-0a1a-0a1a-000000000001';
const BRAND_B = 'c2400a1a-0a1a-0a1a-0a1a-000000000002';

let pool: pg.Pool;
let pgUp = false;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
  try {
    await pool.query('SELECT 1');
    // Fail fast if 0126 is missing so a skip vs a real bug is distinguishable.
    const r = await pool.query("SELECT to_regclass('billing.product_cost_sheet') AS t");
    pgUp = r.rows[0]?.t != null;
    if (pgUp) {
      await pool.query('DELETE FROM billing.product_cost_sheet WHERE brand_id = ANY($1)', [[BRAND_A, BRAND_B]]);
    }
  } catch {
    pgUp = false;
  }
});

afterAll(async () => {
  if (pgUp) await pool.query('DELETE FROM billing.product_cost_sheet WHERE brand_id = ANY($1)', [[BRAND_A, BRAND_B]]);
  await pool?.end();
});

// ── C2.4 validation (pure) ───────────────────────────────────────────────────
describe('C2.4 validation', () => {
  it('parses a well-formed CSV (header case-insensitive, optional valid_to)', () => {
    const csv = 'SKU,Cost_Minor,Currency_Code,Valid_From,Valid_To\nSKU-1,12500,INR,2026-01-01,2026-06-01\nSKU-2,999,INR,2026-01-01,';
    const rows = parseCostSheetCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ sku: 'SKU-1', cost_minor: '12500', currency_code: 'INR', valid_from: '2026-01-01', valid_to: '2026-06-01' });
    expect(rows[1]?.valid_to).toBeNull();
  });

  it('rejects a CSV missing a required column', () => {
    expect(() => parseCostSheetCsv('sku,currency_code,valid_from\nX,INR,2026-01-01')).toThrow(/cost_minor/);
  });

  it('rejects bad currency, negative/non-integer cost, and inverted validity', () => {
    const rows: ProductCostRow[] = [
      { sku: 'A', cost_minor: '100', currency_code: 'XX', valid_from: '2026-01-01' }, // bad currency
      { sku: 'B', cost_minor: '-5', currency_code: 'INR', valid_from: '2026-01-01' }, // negative → not digits
      { sku: 'C', cost_minor: '10.5', currency_code: 'INR', valid_from: '2026-01-01' }, // float → banned
      { sku: 'D', cost_minor: '10', currency_code: 'INR', valid_from: '2026-06-01', valid_to: '2026-01-01' }, // inverted
    ];
    const { clean, rejected } = validateProductCostRows(rows);
    expect(clean).toHaveLength(0);
    expect(rejected).toHaveLength(4);
    expect(rejected[0]?.message).toMatch(/invalid currency/);
    expect(rejected[1]?.message).toMatch(/non-negative integer/);
    expect(rejected[2]?.message).toMatch(/non-negative integer/);
    expect(rejected[3]?.message).toMatch(/must be after/);
  });

  it('rejects batch-internal overlapping validity for the same (sku, currency)', () => {
    const rows: ProductCostRow[] = [
      { sku: 'A', cost_minor: '100', currency_code: 'INR', valid_from: '2026-01-01', valid_to: '2026-06-01' },
      { sku: 'A', cost_minor: '120', currency_code: 'INR', valid_from: '2026-03-01', valid_to: '2026-09-01' }, // overlaps
    ];
    const { clean, rejected } = validateProductCostRows(rows);
    expect(clean).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.message).toMatch(/overlapping validity/);
  });

  it('accepts a GCC 3-decimal (KWD) row with zero rounding — value stays already-minor', () => {
    // KWD 1.250 = 1250 minor units (3-decimal). The value passes through untouched.
    const { clean, rejected } = validateProductCostRows([
      { sku: 'KW-1', cost_minor: '1250', currency_code: 'kwd', valid_from: '2026-01-01' },
    ]);
    expect(rejected).toHaveLength(0);
    expect(clean[0]).toMatchObject({ cost_minor: '1250', currency_code: 'KWD' });
  });

  it('accepts adjacent (touching, non-overlapping) validity — [a,b) then [b,c)', () => {
    const { clean, rejected } = validateProductCostRows([
      { sku: 'A', cost_minor: '100', currency_code: 'INR', valid_from: '2026-01-01', valid_to: '2026-06-01' },
      { sku: 'A', cost_minor: '120', currency_code: 'INR', valid_from: '2026-06-01', valid_to: null },
    ]);
    expect(rejected).toHaveLength(0);
    expect(clean).toHaveLength(2);
  });
});

// ── C2.4 round-trip (PG) ─────────────────────────────────────────────────────
describe('C2.4 round-trip', () => {
  it('ingests a CSV, lists open versions, and is byte-for-byte idempotent on replay', async () => {
    if (!pgUp) return; // SKIP: PG/0126 unavailable
    const csv = 'sku,cost_minor,currency_code,valid_from,valid_to\nSKU-1,12500,INR,2026-01-01,\nKW-1,1250,KWD,2026-01-01,';
    const rows = parseCostSheetCsv(csv);

    const first = await ingestProductCosts(BRAND_A, rows, { pool });
    expect(first.inserted).toBe(2);
    expect(first.updated).toBe(0);
    expect(first.rejected).toHaveLength(0);

    const listed = await listProductCosts(BRAND_A, { pool });
    expect(listed).toHaveLength(2);
    const kw = listed.find((r) => r.sku === 'KW-1');
    expect(kw).toMatchObject({ cost_minor: '1250', currency_code: 'KWD', valid_to: null });

    // Replay the identical file → all UPDATE (upsert in place), NO new rows.
    const replay = await ingestProductCosts(BRAND_A, rows, { pool });
    expect(replay.inserted).toBe(0);
    expect(replay.updated).toBe(2);
    const stillTwo = await listProductCosts(BRAND_A, { pool });
    expect(stillTwo).toHaveLength(2);
  });

  it('updates an existing version in place (same valid_from) and rejects an overlapping new version', async () => {
    if (!pgUp) return;
    await pool.query('DELETE FROM billing.product_cost_sheet WHERE brand_id = $1', [BRAND_A]);
    await ingestProductCosts(BRAND_A, [{ sku: 'S', cost_minor: '500', currency_code: 'INR', valid_from: '2026-01-01' }], { pool });

    // Same version key (sku+currency+valid_from) with a corrected cost → UPDATE in place.
    const restated = await ingestProductCosts(BRAND_A, [{ sku: 'S', cost_minor: '650', currency_code: 'INR', valid_from: '2026-01-01' }], { pool });
    expect(restated.updated).toBe(1);
    const after = await listProductCosts(BRAND_A, { pool });
    expect(after.find((r) => r.sku === 'S')?.cost_minor).toBe('650');

    // A different valid_from whose open interval overlaps the stored open version → rejected.
    const clash = await ingestProductCosts(BRAND_A, [{ sku: 'S', cost_minor: '700', currency_code: 'INR', valid_from: '2026-03-01' }], { pool });
    expect(clash.inserted).toBe(0);
    expect(clash.rejected[0]?.message).toMatch(/overlapping validity/);
  });

  it('isolates tenants: brand B never sees brand A costs (RLS)', async () => {
    if (!pgUp) return;
    await pool.query('DELETE FROM billing.product_cost_sheet WHERE brand_id = ANY($1)', [[BRAND_A, BRAND_B]]);
    await ingestProductCosts(BRAND_A, [{ sku: 'ONLY-A', cost_minor: '100', currency_code: 'INR', valid_from: '2026-01-01' }], { pool });
    const bList = await listProductCosts(BRAND_B, { pool });
    expect(bList).toHaveLength(0);
    const aList = await listProductCosts(BRAND_A, { pool });
    expect(aList.map((r) => r.sku)).toContain('ONLY-A');
  });
});
