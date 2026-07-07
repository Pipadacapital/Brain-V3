// SPEC: B.3
/**
 * B3 — Wave-B Journey API routes (AMD-14): /v1/customers/:brainId/journey, /v1/journeys/{trace,compare}.
 *
 * Uses the REAL registerJourneyApiRoutes + REAL analytics use-cases + REAL metric-engine seams over
 * fake Trino/zset pools, with a stub session preHandler (the shape bffProtectedPreHandler produces).
 * Proves:
 *   1. tenant from SESSION (auth.brandId) — no brand → honest empty (never a query-param brand),
 *   2. the A.4 cache hot path (source='cache') vs the Trino ledger fallback (source='trino'),
 *   3. X-Journey-Version header = derived journey_version (AMD-11) on the ledger path only,
 *   4. compare's t_minus_conversion_ms anchored on the latest composite touch,
 *   5. validation (bad brainId / missing order_id) → 400; no srPool → 503.
 */
import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type { SilverPool, TouchpointZsetClient } from '@brain/metric-engine';
import { registerJourneyApiRoutes } from './journey-api.routes.js';
import type { BffDeps } from './_shared.js';

const BRAND = 'aaaa1111-0000-4000-8000-aaaaaaaaaaaa';
const BRAIN = 'bbbb2222-0000-4000-8000-bbbbbbbbbbbb';
const BRAIN2 = 'cccc3333-0000-4000-8000-cccccccccccc';

/** Fake Trino serving pool: routes canned rows by SQL fragment. */
function fakeSrPool(handler: (sql: string, params: unknown[]) => Array<Record<string, unknown>>): SilverPool {
  return {
    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
      return handler(sql, params) as T[];
    },
  } as unknown as SilverPool;
}

/** Fake A.4 zset: members newest-first. */
function fakeTpCache(membersNewestFirst: string[]): TouchpointZsetClient {
  return {
    async zcard() {
      return membersNewestFirst.length;
    },
    async zrevrange(_k: string, start: number, stop: number) {
      return membersNewestFirst.slice(start, stop + 1);
    },
  };
}

function ledgerRow(seq: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    touchpoint_id: `tp-${seq}`,
    sequence_number: String(seq),
    occurred_at: `2026-07-01 0${seq}:00:00 UTC`,
    event_category: 'behaviour',
    event_type: 'page.viewed',
    channel: 'referral',
    campaign: null,
    revenue_minor: null,
    currency_code: null,
    is_composite: false,
    identity_confidence: null,
    data_version: 1,
    ...extra,
  };
}

async function buildApp(deps: Partial<BffDeps> & { brandId?: string | null }): Promise<FastifyInstance> {
  const app = Fastify();
  const full = {
    bffProtectedPreHandler: async (request: FastifyRequest) => {
      (request as FastifyRequest & { auth: unknown }).auth = {
        userId: 'u1', jti: 'j1',
        brandId: deps.brandId === undefined ? BRAND : deps.brandId,
        workspaceId: 'w1', role: 'brand_admin',
      };
    },
    srPool: deps.srPool,
    rawPool: deps.rawPool,
    touchpointCacheReader: deps.touchpointCacheReader,
  } as unknown as BffDeps;
  registerJourneyApiRoutes(app, full);
  await app.ready();
  return app;
}

describe('B3 (1) GET /v1/customers/:brainId/journey', () => {
  it('serves the A.4 cache hot path (source=cache; matched_via/journey_version null; NO version header)', async () => {
    const tp = fakeTpCache([
      JSON.stringify({ type: 'page.viewed', channel: 'direct', url_path: '/p2', ts: 200, session_id: 's' }),
      JSON.stringify({ type: 'page.viewed', channel: 'direct', url_path: '/p1', ts: 100, session_id: 's' }),
    ]);
    const app = await buildApp({ srPool: fakeSrPool(() => []), touchpointCacheReader: tp });
    const res = await app.inject({ method: 'GET', url: `/v1/customers/${BRAIN}/journey?limit=10` });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.state).toBe('has_data');
    expect(data.source).toBe('cache');
    expect(data.items[0]).toMatchObject({ ts: 200, url_path: '/p2', matched_via: null, journey_version: null });
    expect(res.headers['x-journey-version']).toBeUndefined(); // no derived version on the cache path
    await app.close();
  });

  it('falls back to the Trino ledger when the cache is cold (source=trino) + sets X-Journey-Version', async () => {
    const app = await buildApp({
      srPool: fakeSrPool((sql) => (sql.includes('mv_journey_events_current') ? [ledgerRow(2, { data_version: 3 }), ledgerRow(1)] : [])),
      touchpointCacheReader: fakeTpCache([]), // cold
    });
    const res = await app.inject({ method: 'GET', url: `/v1/customers/${BRAIN}/journey?limit=10` });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.source).toBe('trino');
    expect(data.journey_version).toBe(3); // max data_version (AMD-11)
    expect(res.headers['x-journey-version']).toBe('3');
    await app.close();
  });

  it('no cache client wired → straight to Trino (the §1.11 cold path)', async () => {
    const app = await buildApp({
      srPool: fakeSrPool((sql) => (sql.includes('mv_journey_events_current') ? [ledgerRow(1)] : [])),
    });
    const res = await app.inject({ method: 'GET', url: `/v1/customers/${BRAIN}/journey` });
    expect(res.json().data.source).toBe('trino');
    await app.close();
  });

  it('honest no_data when neither cache nor ledger has rows', async () => {
    const app = await buildApp({ srPool: fakeSrPool(() => []), touchpointCacheReader: fakeTpCache([]) });
    const res = await app.inject({ method: 'GET', url: `/v1/customers/${BRAIN}/journey` });
    expect(res.json().data).toEqual({ state: 'no_data' });
    await app.close();
  });

  it('400 on a non-UUID brainId', async () => {
    const app = await buildApp({ srPool: fakeSrPool(() => []) });
    const res = await app.inject({ method: 'GET', url: `/v1/customers/not-a-uuid/journey` });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('no session brand → honest no_data (tenant from session only)', async () => {
    const app = await buildApp({ brandId: null, srPool: fakeSrPool(() => []) });
    const res = await app.inject({ method: 'GET', url: `/v1/customers/${BRAIN}/journey` });
    expect(res.json().data).toEqual({ state: 'no_data' });
    await app.close();
  });

  it('503 when the serving tier is absent', async () => {
    const app = await buildApp({ srPool: undefined });
    const res = await app.inject({ method: 'GET', url: `/v1/customers/${BRAIN}/journey` });
    expect(res.statusCode).toBe(503);
    await app.close();
  });
});

describe('B3 (2) GET /v1/journeys/trace', () => {
  it('400 when order_id is missing', async () => {
    const app = await buildApp({ srPool: fakeSrPool(() => []) });
    const res = await app.inject({ method: 'GET', url: `/v1/journeys/trace` });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('honest no_data when the order resolves to no stitched journey (no PG pool)', async () => {
    const app = await buildApp({ srPool: fakeSrPool(() => []) }); // no rawPool → order→anon cannot resolve
    const res = await app.inject({ method: 'GET', url: `/v1/journeys/trace?order_id=ord-1` });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ state: 'no_data' });
    await app.close();
  });
});

describe('B3 (3) GET /v1/journeys/compare', () => {
  it('compares two journeys with t_minus_conversion_ms anchored on the latest composite touch', async () => {
    // Both sides read the ledger; the order.placed row (is_composite) is the conversion anchor.
    const app = await buildApp({
      srPool: fakeSrPool((sql, params) => {
        if (!sql.includes('mv_journey_events_current')) return [];
        // params[0] is the brainId (bound first). Give the left brain a converting journey.
        const brainId = params[0];
        if (brainId === BRAIN) {
          return [
            ledgerRow(2, { is_composite: true, event_type: 'order.placed', occurred_at: '2026-07-01 12:00:00 UTC' }),
            ledgerRow(1, { occurred_at: '2026-07-01 09:00:00 UTC' }),
          ];
        }
        return []; // right brain: no journey
      }),
    });
    const res = await app.inject({ method: 'GET', url: `/v1/journeys/compare?left=${BRAIN}&right=${BRAIN2}` });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.left.brain_id).toBe(BRAIN);
    expect(data.left.conversion_at).toBe('2026-07-01 12:00:00 UTC');
    // Chronological (oldest first): the 09:00 touch is 3h (10.8M ms) before the 12:00 conversion.
    expect(data.left.touches[0].t_minus_conversion_ms).toBe(3 * 60 * 60 * 1000);
    expect(data.left.touches[1].t_minus_conversion_ms).toBe(0); // the conversion touch itself
    expect(data.right).toEqual({ brain_id: BRAIN2, conversion_at: null, touches: [] });
    await app.close();
  });

  it('400 when left/right are not customer UUIDs', async () => {
    const app = await buildApp({ srPool: fakeSrPool(() => []) });
    const res = await app.inject({ method: 'GET', url: `/v1/journeys/compare?left=x&right=y` });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
