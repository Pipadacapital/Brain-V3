/**
 * health-server.test.ts — T2-10 liveness/readiness probe semantics.
 *
 * Proves the two probes carry DISTINCT meanings:
 *   - /healthz is liveness: 200 regardless of dependencies (process is up).
 *   - /readyz is readiness: 503 while consumers start, 503 when the DB ping fails, 200 only when
 *     consumers are up AND Postgres answers. A hung DB ping must not hang the probe (bounded).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startHealthServer, type HealthServerHandle } from '../infrastructure/health/HealthServer.js';

const log = { info: () => {}, warn: () => {} };

let handle: HealthServerHandle | null = null;
let port = 0;

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
});

function start(opts: { isReady: () => boolean; pingDb: () => Promise<void> }): void {
  // Ephemeral-ish port per test to avoid collisions in the same run.
  port = 18090 + Math.floor(performance.now() % 800);
  handle = startHealthServer({ port, log, ...opts });
}

async function get(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  // Small retry: listen() is async, the first request may race the bind.
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    } catch {
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  throw new Error('health server never came up');
}

describe('HealthServer (T2-10)', () => {
  it('/healthz is liveness — 200 even when not ready and DB is down', async () => {
    start({ isReady: () => false, pingDb: () => Promise.reject(new Error('db down')) });
    const res = await get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body['status']).toBe('ok');
  });

  it('/readyz is 503 while consumers are still starting (no DB ping attempted)', async () => {
    let pinged = false;
    start({ isReady: () => false, pingDb: async () => { pinged = true; } });
    const res = await get('/readyz');
    expect(res.status).toBe(503);
    expect(res.body['reason']).toBe('consumers_starting');
    expect(pinged).toBe(false); // short-circuits before touching the DB
  });

  it('/readyz is 200 when consumers are up and the DB answers', async () => {
    start({ isReady: () => true, pingDb: () => Promise.resolve() });
    const res = await get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body['status']).toBe('ready');
  });

  it('/readyz is 503 (database_unreachable) when the DB ping fails', async () => {
    start({ isReady: () => true, pingDb: () => Promise.reject(new Error('ECONNREFUSED')) });
    const res = await get('/readyz');
    expect(res.status).toBe(503);
    expect(res.body['reason']).toBe('database_unreachable');
  });

  it('/readyz is 503 when the DB ping hangs (bounded, does not hang the probe)', async () => {
    // pingDb never resolves — the 2s internal timeout must still produce a 503.
    start({ isReady: () => true, pingDb: () => new Promise<void>(() => {}) });
    const res = await get('/readyz');
    expect(res.status).toBe(503);
    expect(res.body['reason']).toBe('database_unreachable');
  }, 10_000);

  it('unknown paths 404', async () => {
    start({ isReady: () => true, pingDb: () => Promise.resolve() });
    const res = await get('/nope');
    expect(res.status).toBe(404);
  });
});
