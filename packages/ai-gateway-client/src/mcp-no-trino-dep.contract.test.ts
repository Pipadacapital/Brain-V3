// SPEC: F.3
/**
 * mcp-no-trino-dep.contract.test.ts — CONTRACT-F: the MCP tool package reaches the serving tier
 * ONLY through certified metric-engine read seams; it declares NO direct engine/SQL client
 * dependency. (Serving is now duckdb-serving, ADR-0014 — the trino entries below stay as the
 * supply-chain ban on reintroducing a raw Trino client.)
 *
 * AMD-20 (BINDING, R1): the literal "MCP server package has no serving-client dependency" is
 * false-by-construction (this package's ONLY dependency is @brain/metric-engine, which contains the
 * duckdb-serving-adapter — so a transitive serving client always exists under the sanctioned
 * architecture). The REAL, invariant-preserving contract is restated here as a DEPENDENCY-GRAPH
 * assertion:
 *
 *   1. @brain/ai-gateway-client (the MCP tool + dispatch package) declares NO DIRECT engine/SQL
 *      client dependency (no trino/presto/pg/mysql/... driver in its own package.json).
 *   2. Its runtime dependency set is EXACTLY the certified-seam allowlist {@brain/metric-engine} —
 *      the ONLY path to the serving tier is transitively through that certified read seam.
 *   3. The registry itself emits no SQL and has zero write tools (asserted in isolation-fuzz/mcp);
 *      this test guards the SUPPLY CHAIN so a raw engine client can never be slipped in directly.
 *
 * If someone adds a direct engine/SQL driver here (bypassing the certified seam), this test FAILS.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, it, expect } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_PATH = join(HERE, '..', 'package.json');

interface PkgJson {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readPkg(): PkgJson {
  return JSON.parse(readFileSync(PKG_PATH, 'utf8')) as PkgJson;
}

/** The certified read-seam allowlist: the ONLY runtime dependency the MCP package may declare. */
const CERTIFIED_SEAM_DEPS = ['@brain/metric-engine'] as const;

/** Direct engine/SQL client package names (incl. retired Trino clients) that MUST NOT appear as a DIRECT dependency here. */
const FORBIDDEN_DIRECT_CLIENTS = [
  'trino',
  'trino-client',
  '@trinodb',
  'presto',
  'presto-client',
  'presto-client-node',
  'pg',
  'pg-native',
  'mysql',
  'mysql2',
  'better-sqlite3',
  'sqlite3',
  'knex',
  'typeorm',
  'sequelize',
] as const;

describe('SPEC:F.3 / AMD-20 — MCP package reaches the serving tier ONLY via the certified metric-engine seam', () => {
  it('is the AI seam package that holds the MCP registry', () => {
    expect(readPkg().name).toBe('@brain/ai-gateway-client');
  });

  it('declares NO direct engine/SQL client dependency (prod or dev)', () => {
    const pkg = readPkg();
    const declared = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ]);
    for (const forbidden of FORBIDDEN_DIRECT_CLIENTS) {
      // Exact package name OR a scoped-namespace prefix match (e.g. @trinodb/*).
      const hit = [...declared].some((d) => d === forbidden || d.startsWith(`${forbidden}/`));
      expect(hit, `MCP package must not directly depend on engine/SQL client "${forbidden}"`).toBe(
        false,
      );
    }
  });

  it('runtime dependency set is EXACTLY the certified-seam allowlist {@brain/metric-engine}', () => {
    const runtimeDeps = Object.keys(readPkg().dependencies ?? {}).sort();
    // The only path to the serving tier is transitively through this one certified read seam.
    expect(runtimeDeps).toEqual([...CERTIFIED_SEAM_DEPS].sort());
  });
});
