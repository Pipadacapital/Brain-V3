/**
 * isolation-fuzz — 4-layer tenant isolation gate (NN-2)
 *
 * Layers:
 *   (a) Postgres RLS      → pg.test.ts
 *   (b) StarRocks row policy → starrocks.test.ts
 *   (c) Redis brandKey()  → redis.test.ts
 *   (d) MCP scope         → mcp.test.ts
 *
 * Every layer test:
 *   - PASSES when isolation is enforced (brand-A cannot see brand-B data → 0 rows / denied)
 *   - FAILS if the enforcement is removed (negative-control design)
 *
 * Run via: pnpm test:isolation (turbo) or vitest run from this directory.
 *
 * Sprint-0 scope: stub-level for StarRocks (Docker only; managed cluster = Track C live leg)
 * and MCP (stub server; real MCP server = M3). Assertions EXIST and FAIL on enforcement removal.
 *
 * @see db/starrocks/row_policy_template.sql  — StarRocks row policy DDL
 * @see packages/tenant-context              — brandKey() canonical implementation
 * @see INVARIANTS.md I-S01                  — brand isolation invariant
 */
export const ISOLATION_FUZZ_VERSION = '0.1.0';
export const LAYERS = ['postgres-rls', 'starrocks-row-policy', 'redis-brandkey', 'mcp-scope'] as const;
export type IsolationLayer = typeof LAYERS[number];
