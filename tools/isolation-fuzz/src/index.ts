/**
 * isolation-fuzz — tenant isolation gate (NN-2)
 *
 * Layers (Brain V4 — StarRocks removed; serving is duckdb-serving-over-Iceberg, ADR-0014):
 *   (a) Postgres RLS             → pg.test.ts
 *   (b) Redis brandKey()         → redis.test.ts
 *   (c) MCP scope                → mcp.test.ts
 *   (d) Serving brand predicate  → serving-brand-predicate.test.ts  (the serving-engine isolation)
 *   (e) Silver read seam         → silver-order-state.test.ts     (withSilverBrand over duckdb-serving)
 *
 * Every layer test:
 *   - PASSES when isolation is enforced (brand-A cannot see brand-B data → 0 rows / denied)
 *   - FAILS if the enforcement is removed (negative-control / non-inert mutation design)
 *
 * Run via: pnpm test:isolation (turbo) or vitest run from this directory.
 *
 * Sprint-0 scope: MCP is stub-level (stub server; real MCP server = M3). Assertions EXIST
 * and FAIL on enforcement removal.
 *
 * Serving: pure unit tests ALWAYS run (no serving dependency); live tests PEND when
 * duckdb-serving is not reachable (docker compose up -d duckdb-serving). The pure unit tests
 * prove the seam's fail-closed throw and predicate injection logic without a running serving
 * replica. duckdb-serving has NO native row-level security (unlike managed StarRocks), so the
 * ${BRAND_PREDICATE} → `brand_id = ?` injection at the seam is the SOLE load-bearing
 * isolation — proven non-inert by the mutation tests.
 *
 * @see packages/tenant-context              — brandKey() canonical implementation
 * @see INVARIANTS.md I-S01                  — brand isolation invariant
 * @see packages/metric-engine/src/serving-deps.ts — withServingBrand seam (serving isolation)
 */
export const ISOLATION_FUZZ_VERSION = '0.1.0';
export const LAYERS = [
  'postgres-rls',
  'redis-brandkey',
  'mcp-scope',
  'serving-brand-predicate',
] as const;
export type IsolationLayer = typeof LAYERS[number];
