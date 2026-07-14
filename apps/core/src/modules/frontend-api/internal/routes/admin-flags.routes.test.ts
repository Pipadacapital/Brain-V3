// SPEC: 0.5
/**
 * admin-flags.routes.test.ts — §0.5 platform-flags ADMIN surface (GET/PUT /api/v1/admin/flags).
 *
 * Uses the REAL registerAdminFlagsRoutes + the REAL @brain/platform-flags service over an
 * in-memory store, with a stub session preHandler that attaches the auth context (the same
 * shape bffProtectedPreHandler produces). Proves:
 *   1. brand comes from SESSION only — a body brand_id can never flip another brand (D-1),
 *   2. RBAC: analyst/manager → 403; brand_admin/owner → allowed,
 *   3. PUT validates against the typed registry (unknown flag → 400, non-boolean → 400),
 *   4. GET lists every registered flag with per-brand state,
 *   5. no flagService wired → 503 (safe-OFF: absent service = flags all OFF).
 */

import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { createFlagService, type FlagStorePort, ALL_PLATFORM_FLAGS } from '@brain/platform-flags';
import { registerAdminFlagsRoutes } from './admin-flags.routes.js';
import type { BffDeps } from './_shared.js';

const BRAND_A = 'aaaa1111-0000-4000-8000-aaaaaaaaaaaa';
const BRAND_B = 'bbbb2222-0000-4000-8000-bbbbbbbbbbbb';

function makeMemoryStore(): FlagStorePort & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: async (k) => data.get(k) ?? null,
    set: async (k, v) => {
      data.set(k, v);
    },
  };
}

async function buildApp(opts: {
  brandId?: string | null;
  role?: string | null;
  store?: FlagStorePort;
  noService?: boolean;
}): Promise<FastifyInstance> {
  const app = Fastify();
  const flagService = opts.noService
    ? undefined
    : createFlagService({ store: opts.store ?? makeMemoryStore(), localTtlMs: 0 });
  const deps = {
    // Stub session preHandler: attaches the auth context bffProtectedPreHandler would.
    bffProtectedPreHandler: async (request: FastifyRequest) => {
      (request as FastifyRequest & { auth: unknown }).auth = {
        userId: 'u1',
        jti: 'j1',
        brandId: opts.brandId === undefined ? BRAND_A : opts.brandId,
        workspaceId: 'w1',
        role: opts.role === undefined ? 'brand_admin' : opts.role,
      };
    },
    flagService,
  } as unknown as BffDeps;
  registerAdminFlagsRoutes(app, deps);
  await app.ready();
  return app;
}

describe('SPEC 0.5 — GET /api/v1/admin/flags', () => {
  it('lists every registered flag with per-brand state (default OFF)', async () => {
    const app = await buildApp({});
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/flags' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { brand_id: string; flags: Array<{ flag: string; enabled: boolean }> } };
    expect(body.data.brand_id).toBe(BRAND_A);
    expect(body.data.flags.map((f) => f.flag).sort()).toEqual([...ALL_PLATFORM_FLAGS].sort());
    expect(body.data.flags.every((f) => f.enabled === false)).toBe(true); // DEFAULT OFF
    await app.close();
  });

  it('403 for roles below brand_admin', async () => {
    for (const role of ['analyst', 'manager', null]) {
      const app = await buildApp({ role });
      const res = await app.inject({ method: 'GET', url: '/api/v1/admin/flags' });
      expect(res.statusCode).toBe(403);
      await app.close();
    }
  });

  it('400 when the session has no active brand', async () => {
    const app = await buildApp({ brandId: null });
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/flags' });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('503 when the flag service is not wired (safe-OFF)', async () => {
    const app = await buildApp({ noService: true });
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/flags' });
    expect(res.statusCode).toBe(503);
    await app.close();
  });
});

describe('SPEC 0.5 — PUT /api/v1/admin/flags', () => {
  it('sets a registered flag for the SESSION brand and reads it back', async () => {
    const store = makeMemoryStore();
    const app = await buildApp({ store });
    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/flags',
      payload: { flag: 'stitch.v2', enabled: true },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().data).toMatchObject({ brand_id: BRAND_A, flag: 'stitch.v2', enabled: true });
    // Stored under the brand-first key shape.
    expect(store.data.get(`${BRAND_A}:flag:stitch.v2`)).toBe('true');

    const get = await app.inject({ method: 'GET', url: '/api/v1/admin/flags' });
    const flags = (get.json() as { data: { flags: Array<{ flag: string; enabled: boolean }> } }).data.flags;
    expect(flags.find((f) => f.flag === 'stitch.v2')?.enabled).toBe(true);
    await app.close();
  });

  it('brand comes from SESSION only — a body brand_id is ignored (tenant isolation)', async () => {
    const store = makeMemoryStore();
    const app = await buildApp({ store });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/flags',
      payload: { flag: 'pixel.identify', enabled: true, brand_id: BRAND_B }, // hostile extra field
    });
    expect(res.statusCode).toBe(200);
    expect(store.data.has(`${BRAND_A}:flag:pixel.identify`)).toBe(true);
    // Brand B's keyspace untouched.
    for (const key of store.data.keys()) expect(key.startsWith(`${BRAND_B}:`)).toBe(false);
    await app.close();
  });

  it('400 on an unknown flag (registry is the write allowlist)', async () => {
    const app = await buildApp({});
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/flags',
      payload: { flag: 'not.a.flag', enabled: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('UNKNOWN_FLAG');
    await app.close();
  });

  it('400 on a non-boolean enabled', async () => {
    const app = await buildApp({});
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/flags',
      payload: { flag: 'stitch.v2', enabled: 'yes' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('403 for roles below brand_admin', async () => {
    const app = await buildApp({ role: 'analyst' });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/flags',
      payload: { flag: 'stitch.v2', enabled: true },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
