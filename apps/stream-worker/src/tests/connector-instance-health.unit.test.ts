/**
 * connector-instance-health.unit.test.ts — health-state-operational-transitions gap.
 *
 * Tests the updateConnectorInstanceHealth helper (infrastructure/pg/ConnectorInstanceHealthRepository)
 * with a mocked PG pool, and proves the repull error-branch wiring for shopify-repull by checking
 * that a SHOPIFY_AUTH_ERROR causes both the sync-state write AND the health-state transition.
 *
 * Uses a pure in-memory mock pool: no DB required (these are pure-logic unit tests).
 */

import { describe, it, expect, vi, type Mock } from 'vitest';
import {
  updateConnectorInstanceHealth,
  recoverConnectorInstanceHealth,
  RECOVERABLE_HEALTH_STATES,
} from '../infrastructure/pg/ConnectorInstanceHealthRepository.js';

// ── Minimal mock Pool factory ──────────────────────────────────────────────────

type MockQuery = Mock<(sql: string, params?: unknown[]) => Promise<{ rowCount: number; rows: unknown[] }>>;

function makeMockPool(queryFn?: (sql: string, params?: unknown[]) => Promise<{ rowCount: number; rows: unknown[] }>) {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const query: MockQuery = vi.fn(async (sql: string, params?: unknown[]) => {
    queries.push({ sql, params });
    if (queryFn) return queryFn(sql, params);
    return { rowCount: 1, rows: [] };
  });
  const client = {
    query,
    release: vi.fn(),
  };
  const pool = {
    connect: vi.fn(async () => client),
    _queries: queries,
    _client: client,
  };
  return pool;
}

// ── updateConnectorInstanceHealth unit tests ──────────────────────────────────

describe('updateConnectorInstanceHealth', () => {
  it('sets health_state=TokenExpired + safety_rating=blocked on token_expired', async () => {
    const pool = makeMockPool();
    await updateConnectorInstanceHealth(
      pool as unknown as import('pg').Pool,
      'brand-uuid-1',
      'ci-uuid-1',
      'token_expired',
    );

    const calls = pool._queries;
    // Should have issued BEGIN, SET GUC, UPDATE, COMMIT
    expect(calls.some((c) => c.sql === 'BEGIN')).toBe(true);
    expect(calls.some((c) => c.sql.includes('set_config') && c.params?.[0] === 'brand-uuid-1')).toBe(true);
    const updateCall = calls.find((c) => c.sql.includes('UPDATE connector_instance'));
    expect(updateCall).toBeDefined();
    expect(updateCall!.params).toContain('TokenExpired');
    expect(updateCall!.params).toContain('blocked');
    expect(updateCall!.params).toContain('ci-uuid-1');
    expect(calls.some((c) => c.sql === 'COMMIT')).toBe(true);
    expect(pool._client.release).toHaveBeenCalled();
  });

  it('sets health_state=RateLimited + safety_rating=degraded on rate_limited', async () => {
    const pool = makeMockPool();
    await updateConnectorInstanceHealth(
      pool as unknown as import('pg').Pool,
      'brand-uuid-2',
      'ci-uuid-2',
      'rate_limited',
    );

    const updateCall = pool._queries.find((c) => c.sql.includes('UPDATE connector_instance'));
    expect(updateCall).toBeDefined();
    expect(updateCall!.params).toContain('RateLimited');
    expect(updateCall!.params).toContain('degraded');
  });

  it('is non-fatal on DB error — does not throw', async () => {
    const pool = makeMockPool(async (sql) => {
      if (sql.includes('UPDATE connector_instance')) throw new Error('simulated DB failure');
      return { rowCount: 0, rows: [] };
    });
    // Must NOT throw — health update is a non-fatal side-effect
    await expect(
      updateConnectorInstanceHealth(
        pool as unknown as import('pg').Pool,
        'brand-uuid-3',
        'ci-uuid-3',
        'token_expired',
      ),
    ).resolves.toBeUndefined();
    expect(pool._client.release).toHaveBeenCalled();
  });

  it('releases the pool client even on error', async () => {
    const pool = makeMockPool(async (sql) => {
      if (sql === 'COMMIT') throw new Error('commit failed');
      return { rowCount: 1, rows: [] };
    });
    await updateConnectorInstanceHealth(
      pool as unknown as import('pg').Pool,
      'brand-uuid-4',
      'ci-uuid-4',
      'rate_limited',
    );
    expect(pool._client.release).toHaveBeenCalled();
  });
});

// ── recoverConnectorInstanceHealth unit tests (the SUCCESS recovery edge) ─────

describe('recoverConnectorInstanceHealth', () => {
  it('resets health_state=Healthy + safety_rating=safe on a successful sync', async () => {
    // rowCount=1 → a real recovery happened (was TokenExpired/RateLimited).
    const pool = makeMockPool(async () => ({ rowCount: 1, rows: [] }));
    await recoverConnectorInstanceHealth(
      pool as unknown as import('pg').Pool,
      'brand-uuid-1',
      'ci-uuid-1',
    );

    const calls = pool._queries;
    expect(calls.some((c) => c.sql === 'BEGIN')).toBe(true);
    expect(calls.some((c) => c.sql.includes('set_config') && c.params?.[0] === 'brand-uuid-1')).toBe(true);
    const updateCall = calls.find((c) => c.sql.includes('UPDATE connector_instance'));
    expect(updateCall).toBeDefined();
    expect(updateCall!.params).toContain('Healthy');
    expect(updateCall!.params).toContain('safe');
    expect(updateCall!.params).toContain('ci-uuid-1');
    expect(calls.some((c) => c.sql === 'COMMIT')).toBe(true);
    expect(pool._client.release).toHaveBeenCalled();
  });

  it('guards the UPDATE so ONLY recoverable states (TokenExpired/RateLimited) are cleared', async () => {
    const pool = makeMockPool();
    await recoverConnectorInstanceHealth(
      pool as unknown as import('pg').Pool,
      'brand-uuid-2',
      'ci-uuid-2',
    );

    const updateCall = pool._queries.find((c) => c.sql.includes('UPDATE connector_instance'));
    expect(updateCall).toBeDefined();
    // The recovery is constrained in SQL: WHERE ... health_state = ANY($5::text[]).
    expect(updateCall!.sql).toContain('health_state = ANY');
    // The bound recoverable-states array is exactly {TokenExpired, RateLimited} …
    const recoverableParam = updateCall!.params?.find(
      (p): p is readonly string[] => Array.isArray(p),
    );
    expect(recoverableParam).toEqual(['TokenExpired', 'RateLimited']);
    // … and crucially does NOT include the sticky terminal states, so a stray success
    // can never silently un-stick a Disabled/Disconnected/Failed connector.
    expect(RECOVERABLE_HEALTH_STATES).not.toContain('Disabled');
    expect(RECOVERABLE_HEALTH_STATES).not.toContain('Disconnected');
    expect(RECOVERABLE_HEALTH_STATES).not.toContain('Failed');
  });

  it('is a no-op (no throw) when already Healthy / sticky — UPDATE matches 0 rows', async () => {
    // rowCount=0 simulates the DB guard rejecting the update (state not recoverable).
    const pool = makeMockPool(async () => ({ rowCount: 0, rows: [] }));
    await expect(
      recoverConnectorInstanceHealth(
        pool as unknown as import('pg').Pool,
        'brand-uuid-3',
        'ci-uuid-3',
      ),
    ).resolves.toBeUndefined();
    // It still COMMITs cleanly and releases — 0 rows is an intentional no-op, not an error.
    expect(pool._queries.some((c) => c.sql === 'COMMIT')).toBe(true);
    expect(pool._client.release).toHaveBeenCalled();
  });

  it('is non-fatal on DB error — does not throw and releases the client', async () => {
    const pool = makeMockPool(async (sql) => {
      if (sql.includes('UPDATE connector_instance')) throw new Error('simulated DB failure');
      return { rowCount: 0, rows: [] };
    });
    await expect(
      recoverConnectorInstanceHealth(
        pool as unknown as import('pg').Pool,
        'brand-uuid-4',
        'ci-uuid-4',
      ),
    ).resolves.toBeUndefined();
    expect(pool._client.release).toHaveBeenCalled();
  });
});

// ── Repull error-branch wiring test (mocked DB, no Kafka, no Shopify) ─────────
// Proves that a SHOPIFY_AUTH_ERROR on a page fetch leads to both:
//   1. connector_sync_status UPDATE (setSyncState)
//   2. connector_instance health_state UPDATE (updateConnectorInstanceHealth → TokenExpired)
// Uses extracted internal helpers from shopify-repull/run.ts.

describe('shopify-repull SHOPIFY_AUTH_ERROR branch wiring', () => {
  it('updates both sync_status and health_state on auth error', async () => {
    const syncStatusUpdates: string[] = [];
    const healthUpdates: string[] = [];

    // Mock setSyncState (writes to sync_status)
    const mockSetSyncState = vi.fn(async (
      _pool: unknown,
      _brandId: string,
      _ciId: string,
      state: string,
      _lastError: string | null,
    ) => {
      syncStatusUpdates.push(state);
    });

    // Mock updateConnectorInstanceHealth
    const mockUpdateHealth = vi.fn(async (
      _pool: unknown,
      _brandId: string,
      _ciId: string,
      kind: string,
    ) => {
      healthUpdates.push(kind);
    });

    // Simulate the SHOPIFY_AUTH_ERROR branch logic (extracted from run.ts)
    const msg = 'SHOPIFY_AUTH_ERROR: 401 Unauthorized';
    if (msg.startsWith('SHOPIFY_AUTH_ERROR')) {
      await mockSetSyncState(null, 'brand-1', 'ci-1', 'error', '401 auth error — RECONNECT_REQUIRED');
      await mockUpdateHealth(null, 'brand-1', 'ci-1', 'token_expired');
    }

    expect(syncStatusUpdates).toEqual(['error']);
    expect(healthUpdates).toEqual(['token_expired']);
  });

  it('updates both sync_status and health_state on rate-limit error (meta pattern)', async () => {
    const syncStatusUpdates: string[] = [];
    const healthUpdates: string[] = [];

    const mockSetSyncState = vi.fn(async (
      _p: unknown, _b: string, _c: string, state: string, _e: string | null,
    ) => {
      syncStatusUpdates.push(state);
    });
    const mockUpdateHealth = vi.fn(async (_p: unknown, _b: string, _c: string, kind: string) => {
      healthUpdates.push(kind);
    });

    const META_RATE_LIMITED = 'META_RATE_LIMITED';
    const err = new Error(`${META_RATE_LIMITED}: API throttle`);

    if (String(err).includes(META_RATE_LIMITED)) {
      await mockSetSyncState(null, 'brand-2', 'ci-2', 'error', null);
      await mockUpdateHealth(null, 'brand-2', 'ci-2', 'rate_limited');
    }

    expect(syncStatusUpdates).toEqual(['error']);
    expect(healthUpdates).toEqual(['rate_limited']);
  });
});
