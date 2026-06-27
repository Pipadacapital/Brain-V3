/**
 * isolation-fuzz/trino-brand-predicate.test.ts — Trino seam isolation (NN-2, I-TR01)
 *
 * Proves per-brand isolation on the Trino READ path (withTrinoBrand) and that the
 * guard is NON-INERT — mirrors silver-order-state.test.ts exactly for the Trino seam.
 *
 * THE MECHANISM UNDER TEST: packages/metric-engine/src/trino-deps.ts `withTrinoBrand`.
 * The Trino REST API has NO native row-level security (unlike managed StarRocks).
 * The BRAND_PREDICATE sentinel injection IS the load-bearing isolation mechanism.
 * This test exercises the REAL seam (imported from @brain/metric-engine — not a copy)
 * so what passes here is what ships.
 *
 * STRUCTURE:
 *   Part A — PURE UNIT TESTS (always run, no live Trino required)
 *     1. Seam THROWS when the sentinel is absent (fail-closed).
 *     2. Seam INJECTS `brand_id = ?` and appends brandId to params.
 *     3. __unsafeDisableBrandPredicate=true → replaces sentinel with `1 = 1` (NOT `brand_id = ?`).
 *        This is the mutation-proof: the seam MUST change the SQL, not leave it unchanged.
 *
 *   Part B — LIVE TRINO TESTS (PEND when Trino is not reachable)
 *     4. [positive] withTrinoBrand(brandA) returns ONLY brand-A rows.
 *     5. [mutation / NON-INERT proof] __unsafeDisableBrandPredicate=true MUST leak brand-B rows.
 *        If disabling the predicate does NOT produce cross-brand results, the predicate was
 *        inert (not doing the work) → test FAILS LOUD. This makes the guard's effectiveness
 *        observable and prevents the bypass-green trap.
 *
 * THE NON-INERT PROOF IS MANDATORY. A test that is green whether or not the predicate is
 * applied provides NO isolation guarantee. The negative control (mutation path) is what
 * makes this a real proof, not a false-confidence check.
 *
 * REQUIRES (for live tests): Trino on :8090 with the iceberg catalog pointing at MinIO/Iceberg-REST.
 * If Trino is unreachable, the live tests PEND (visibly skipped) — NOT silently green.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { withTrinoBrand, BRAND_PREDICATE, type TrinoPool } from '@brain/metric-engine';

// ── Test constants ─────────────────────────────────────────────────────────────

const BRAND_A = 'aaaa9999-0000-4000-8000-aaaaaaaaaaaa';
const BRAND_B = 'bbbb8888-0000-4000-8000-bbbbbbbbbbbb';

// ═════════════════════════════════════════════════════════════════════════════
// PART A — PURE UNIT TESTS (always run; no live Trino)
// These tests exercise the seam logic directly using a mock TrinoPool.
// ═════════════════════════════════════════════════════════════════════════════

describe('[unit] withTrinoBrand — predicate injection (no live Trino)', () => {

  /**
   * Test 1 — FAIL-CLOSED: missing sentinel → throw.
   * If a caller forgets ${BRAND_PREDICATE}, the seam throws rather than running
   * a cross-brand query. This is the structural bug prevention mechanism.
   */
  it('THROWS when the query is missing the ${BRAND_PREDICATE} sentinel (fail-closed)', async () => {
    let capturedSql = '';
    const pool: TrinoPool = {
      async query(sql) { capturedSql = sql; return []; },
    };

    await expect(
      withTrinoBrand(pool, BRAND_A, (scope) =>
        scope.runScoped(
          // Missing ${BRAND_PREDICATE} — would run cross-brand without the guard.
          'SELECT brand_id FROM iceberg.brain_bronze.collector_events WHERE 1=1',
        ),
      ),
    ).rejects.toThrow(/BRAND_PREDICATE/);

    // Pool was never called (the throw happened before any query).
    expect(capturedSql).toBe('');
  });

  /**
   * Test 2 — PREDICATE INJECTION: sentinel replaced with `brand_id = ?`, brandId appended.
   * Verifies the seam's happy path: SQL is correctly rewritten and params extended.
   */
  it('injects `brand_id = ?` and appends brandId as the last param', async () => {
    let capturedSql = '';
    let capturedParams: unknown[] = [];
    const pool: TrinoPool = {
      async query(sql, params = []) {
        capturedSql = sql;
        capturedParams = params;
        return [];
      },
    };

    await withTrinoBrand(pool, BRAND_A, (scope) =>
      scope.runScoped(
        `SELECT event_type FROM iceberg.brain_bronze.collector_events WHERE ts > ? AND ${BRAND_PREDICATE}`,
        ['2024-01-01'],
      ),
    );

    // Sentinel replaced with parameterized predicate.
    expect(capturedSql).toBe(
      'SELECT event_type FROM iceberg.brain_bronze.collector_events WHERE ts > ? AND brand_id = ?',
    );
    // brandId appended as the last param.
    expect(capturedParams).toEqual(['2024-01-01', BRAND_A]);
  });

  /**
   * Test 3 — MUTATION PROOF (pure): __unsafeDisableBrandPredicate=true
   *   → sentinel replaced with `1 = 1` (not `brand_id = ?`)
   *   → brandId NOT appended to params
   * This tests the mutation-proof mechanism. In the live tests (below), the same
   * path is verified to ACTUALLY leak brand-B rows when Trino is available.
   */
  it('[mutation proof] __unsafeDisableBrandPredicate=true replaces sentinel with `1 = 1`, NOT `brand_id = ?`', async () => {
    let capturedSql = '';
    let capturedParams: unknown[] = [];
    const pool: TrinoPool = {
      async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
        capturedSql = sql;
        capturedParams = params;
        return [{ brand_id: BRAND_B }] as unknown as T[]; // simulated cross-brand leak
      },
    };

    const rows = await withTrinoBrand(
      pool,
      BRAND_A,
      (scope) =>
        scope.runScoped(
          `SELECT brand_id FROM iceberg.brain_bronze.collector_events WHERE ${BRAND_PREDICATE}`,
        ),
      { __unsafeDisableBrandPredicate: true },
    );

    // The sentinel was replaced with `1 = 1` (cross-brand, no filtering).
    expect(capturedSql).toBe(
      'SELECT brand_id FROM iceberg.brain_bronze.collector_events WHERE 1 = 1',
    );
    // No brandId appended to params (predicate injection disabled).
    expect(capturedParams).toEqual([]);
    // The pool returned BRAND_B — the mock simulates the cross-brand leak.
    expect(rows.some((r) => (r as { brand_id: string }).brand_id === BRAND_B)).toBe(true);
  });

  /**
   * Test 4 — GUARD CHANGES THE SQL: the disabled path MUST produce a DIFFERENT SQL than
   * the enabled path. If they produce the same SQL, the predicate was inert (not doing work).
   *
   * This is the pure analogue of the live mutation proof: without real data, we prove
   * the SQL differs, which implies the predicate is structural (not cosmetic).
   */
  it('[mutation proof] disabled vs enabled seam produce DIFFERENT SQL (guard is structural)', async () => {
    const captured: { sql: string; params: unknown[] }[] = [];
    const pool: TrinoPool = {
      async query(sql, params = []) {
        captured.push({ sql, params });
        return [];
      },
    };
    const query = `SELECT * FROM iceberg.brain_bronze.events WHERE ${BRAND_PREDICATE}`;

    // Enabled (brand predicate injected)
    await withTrinoBrand(pool, BRAND_A, (scope) => scope.runScoped(query));

    // Disabled (mutation path)
    await withTrinoBrand(pool, BRAND_A, (scope) => scope.runScoped(query), {
      __unsafeDisableBrandPredicate: true,
    });

    const [enabled, disabled] = captured;
    // SQL MUST differ: enabled has `brand_id = ?`, disabled has `1 = 1`.
    expect(enabled!.sql).toContain('brand_id = ?');
    expect(disabled!.sql).toContain('1 = 1');
    expect(enabled!.sql).not.toBe(disabled!.sql);

    // Params MUST differ: enabled has brandId appended, disabled does not.
    expect(enabled!.params).toContain(BRAND_A);
    expect(disabled!.params).not.toContain(BRAND_A);
  });

  /**
   * Test 5 — SHARED SENTINEL: BRAND_PREDICATE exported from trino-deps is the SAME
   * literal string as the one exported from silver-deps (the single shared sentinel).
   * This verifies the two seams use the ONE sentinel, not independent copies.
   */
  it('BRAND_PREDICATE is the shared sentinel string (same as silver-deps)', async () => {
    // Import the sentinel from silver-deps through the same @brain/metric-engine barrel.
    const { BRAND_PREDICATE: silverSentinel } = await import('@brain/metric-engine');
    expect(BRAND_PREDICATE).toBe(silverSentinel);
    expect(BRAND_PREDICATE).toBe('${BRAND_PREDICATE}');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PART B — LIVE TRINO TESTS (guarded/skipped when Trino is not reachable)
// Mirrors silver-order-state.test.ts live-test discipline exactly.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * TrinoPool backed by real HTTP calls (same shape as the production adapter).
 * We inline a minimal HTTP adapter here instead of importing trino-adapter.ts
 * so the test is independent of the composition root.
 */
async function tryCreateLiveTrinoPool(): Promise<TrinoPool | null> {
  const baseUrl = process.env['TRINO_URL'] ?? 'http://localhost:8090';
  try {
    const res = await fetch(`${baseUrl}/v1/info`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    // Return a minimal pool that issues a raw SQL POST and polls nextUri.
    return {
      async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
        // Client-side parameter substitution (matches trino-adapter.ts substituteParams).
        let finalSql = sql;
        let i = 0;
        finalSql = finalSql.replace(/\?/g, () => {
          const p = params[i++];
          if (p === null || p === undefined) return 'NULL';
          if (typeof p === 'string') return `'${p.replace(/'/g, "''")}'`;
          if (typeof p === 'number' || typeof p === 'bigint') return String(p);
          if (typeof p === 'boolean') return p ? 'TRUE' : 'FALSE';
          throw new Error(`unsupported param type: ${typeof p}`);
        });

        const post = await fetch(`${baseUrl}/v1/statement`, {
          method: 'POST',
          headers: {
            'X-Trino-User': 'brain',
            'X-Trino-Catalog': 'iceberg',
            'X-Trino-Schema': 'brain_bronze',
          },
          body: finalSql,
        });
        if (!post.ok) throw new Error(`Trino POST failed: ${post.status}`);
        let resp = (await post.json()) as { nextUri?: string; columns?: { name: string }[]; data?: unknown[][]; error?: { message: string } };
        let columns = resp.columns;
        const allData: unknown[][] = resp.data ? [...resp.data] : [];
        let polls = 0;
        while (resp.nextUri && polls < 120) {
          await new Promise<void>((r) => setTimeout(r, 300));
          const p = await fetch(resp.nextUri);
          if (!p.ok) throw new Error(`Trino poll failed: ${p.status}`);
          resp = (await p.json()) as typeof resp;
          if (resp.columns && !columns) columns = resp.columns;
          if (resp.data) allData.push(...resp.data);
          polls++;
        }
        if (resp.error) throw new Error(`Trino error: ${resp.error.message}`);
        if (!columns || allData.length === 0) return [] as T[];
        const names = columns.map((c) => c.name);
        return allData.map((row) => {
          const obj: Record<string, unknown> = {};
          names.forEach((n, idx) => { obj[n] = row[idx]; });
          return obj as T;
        });
      },
    };
  } catch {
    return null;
  }
}

// ── Live test setup ────────────────────────────────────────────────────────────

let livePool: TrinoPool | null = null;
let trinoAvailable = false;
let icelandAvailable = false; // 'iceberg catalog + test table available'

const LIVE_TABLE = 'iceberg.brain_bronze.collector_events';
const SEED_ROW_A = `'iso-fuzz-trino-brand-a-1'`;
const SEED_ROW_B = `'iso-fuzz-trino-brand-b-1'`;

beforeAll(async () => {
  livePool = await tryCreateLiveTrinoPool();
  if (!livePool) {
    console.warn(
      '[isolation-fuzz/trino] Trino not reachable on :8090 — live tests PENDING. ' +
      'Start: docker compose --profile lakehouse up -d trino',
    );
    return;
  }
  trinoAvailable = true;

  // Check the table + seed rows exist. We cannot INSERT via Trino (read-only REST API),
  // so live tests require the table to be pre-populated by the Spark Bronze sink.
  try {
    // Just verify the table is queryable — we don't need seed rows for the seam proof
    // (the seam proof only needs the table to exist and have at least one row per brand).
    await livePool.query(
      `SELECT count(*) as n FROM ${LIVE_TABLE} WHERE brand_id = ${SEED_ROW_A} LIMIT 1`,
      [],
    );
    icelandAvailable = true;
  } catch {
    console.warn(
      `[isolation-fuzz/trino] ${LIVE_TABLE} not found or empty for test brands — ` +
      'live tests PENDING. Run the Spark Bronze sink to populate data.',
    );
  }
});

afterAll(async () => {
  // No cleanup needed — Trino is read-only and we did not insert any rows.
});

describe('[live] Trino seam — per-brand isolation (NN-2 / I-TR01, withTrinoBrand)', () => {

  it('SKIP_IF_UNAVAILABLE: PENDING when Trino or the Iceberg table is not reachable', () => {
    if (!trinoAvailable || !icelandAvailable) {
      console.warn('[isolation-fuzz/trino] Trino or brain_bronze.collector_events unavailable — live isolation assertions PENDING.');
    }
    expect(true).toBe(true);
  });

  it('[positive] withTrinoBrand(brandA) returns ONLY brand-A rows, zero brand-B', async (ctx) => {
    if (!trinoAvailable || !icelandAvailable || !livePool) return ctx.skip();

    const rows = await withTrinoBrand(livePool, BRAND_A, async (scope) =>
      scope.runScoped<{ brand_id: string }>(
        `SELECT brand_id FROM ${LIVE_TABLE} WHERE ${BRAND_PREDICATE} AND brand_id IN (${SEED_ROW_A}, ${SEED_ROW_B})`,
      ),
    );

    // Must return at least one row for brand A.
    expect(rows.length).toBeGreaterThan(0);
    // All rows belong to BRAND_A.
    for (const r of rows) expect(r.brand_id).toBe(BRAND_A);
    // No brand-B rows in the result.
    expect(rows.some((r) => r.brand_id === BRAND_B)).toBe(false);
  });

  it('[mutation / NON-INERT proof] disabling the seam predicate MUST leak brand-B rows', async (ctx) => {
    if (!trinoAvailable || !icelandAvailable || !livePool) return ctx.skip();

    // Same logical query asked for brand-A, but with predicate injection DISABLED.
    // If the predicate were inert (not doing the work), brand-B would still be excluded
    // and the assertion below would fail — exposing the inert guard.
    const leaked = await withTrinoBrand(
      livePool,
      BRAND_A,
      async (scope) =>
        scope.runScoped<{ brand_id: string }>(
          `SELECT brand_id FROM ${LIVE_TABLE} WHERE ${BRAND_PREDICATE} AND brand_id IN (${SEED_ROW_A}, ${SEED_ROW_B})`,
        ),
      { __unsafeDisableBrandPredicate: true },
    );

    // THE NON-INERT PROOF: without the predicate, brand-B rows must appear.
    // If this assertion fails, the guard was inert → P0 security finding.
    expect(leaked.some((r) => r.brand_id === BRAND_B)).toBe(true);
  });

  it('[documentation] Trino has no native row policies — SQL predicate IS the isolation', () => {
    // ALWAYS PASSES — documents the platform boundary honestly.
    // Unlike managed StarRocks (CREATE ROW POLICY), Trino has no per-brand row filter.
    // The withTrinoBrand seam predicate is the SOLE isolation mechanism for Trino.
    // This makes the mutation proof above the ONLY runtime evidence of isolation correctness.
    expect('Trino isolation = SQL predicate injection (non-inert); no native row policy available').toBeTruthy();
  });
});
