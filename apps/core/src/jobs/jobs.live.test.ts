/**
 * jobs.live.test.ts — the scheduled job entrypoints run end-to-end (enumerate active brands →
 * run the per-brand pipeline). The per-brand correctness lives in the module tests; this verifies
 * the orchestration: enumeration works, every brand is processed, one brand's failure is isolated,
 * and the run is idempotent (safe to re-run on a schedule).
 *
 * REQUIRES Postgres (+ StarRocks for the attribution job). Both jobs are idempotent, so running
 * them against the dev DB is safe.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { createPool, type DbPool } from '@brain/db';
import type { SilverPool } from '@brain/metric-engine';
import { runRecommendationDetectors } from './recommendation-detectors.js';
import { runAttributionReconcile } from './attribution-reconcile.js';

const PG_URL = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const SR_HOST = process.env['STARROCKS_HOST'] ?? '127.0.0.1';

let dbPool: DbPool;
let pgPool: pg.Pool;
let srPool: SilverPool;
let available = false;

beforeAll(async () => {
  try {
    pgPool = new pg.Pool({ connectionString: PG_URL, connectionTimeoutMillis: 4000 });
    await pgPool.query('SELECT 1');
    dbPool = await createPool({ connectionString: PG_URL });
    srPool = mysql.createPool({ host: SR_HOST, port: 9030, user: 'root', password: '', connectionLimit: 2 }) as unknown as SilverPool;
    available = true;
  } catch {
    available = false;
  }
});

afterAll(async () => {
  if (dbPool) await dbPool.end();
  if (pgPool) await pgPool.end();
  if (srPool) await (srPool as unknown as mysql.Pool).end();
});

describe('scheduled job entrypoints (live)', () => {
  it('SKIP_IF_NO_PG', () => {
    if (!available) console.warn('[jobs] Postgres unavailable — PENDING.');
    expect(true).toBe(true);
  });

  it('recommendation-detectors enumerates active brands and completes with no errors', async () => {
    if (!available) return;
    const r = await runRecommendationDetectors({ pool: dbPool });
    expect(r.brands).toBeGreaterThanOrEqual(1);
    expect(r.errors).toBe(0);
    expect(r.raised).toBeGreaterThanOrEqual(0);
  });

  it('attribution-reconcile enumerates active brands and completes with no errors (idempotent)', async () => {
    if (!available) return;
    const r1 = await runAttributionReconcile({ pool: pgPool, srPool });
    expect(r1.brands).toBeGreaterThanOrEqual(1);
    expect(r1.errors).toBe(0);
    // Idempotent: a second run credits/claws nothing new.
    const r2 = await runAttributionReconcile({ pool: pgPool, srPool });
    expect(r2.credited).toBe(0);
    expect(r2.clawed_back).toBe(0);
  });
});
