/**
 * serving-warm.ts — ADR-0019 WS-4 D7: cluster-internal warm-on-write endpoint.
 *
 * The transform tick, at end-of-tick (after the Gold pass + tick-compaction), POSTs
 * `POST /internal/serving/warm` so core PRE-FILLS the app's hot Redis cache keys BEFORE any user
 * arrives — killing the cold-first-hit at its source (the measured 10–27 s slow-cold class).
 *
 * ── WHAT IT DOES ──────────────────────────────────────────────────────────────────────────────
 * Iterates the HOT DATASET ALLOWLIST (the measured slow-cold set) × active brands and calls the
 * EXISTING `servingCache.read` for each dataset's DEFAULT WINDOW — reusing the SAME metricId, the
 * SAME default-window params, and the SAME compute closure (the `analytics/*` reader the route
 * calls). No new SQL, no query duplication: warming primes the IDENTICAL cache key a real request
 * hits (`${brandId}:${metricId}:${paramsHash}:${servingVersion}`), so the first user is warm.
 *
 * The default windows below MIRROR the route handlers verbatim (analytics-core / analytics-marketing /
 * analytics-logistics / tracking routes) so the hashed params — and thus the cache keys — match:
 *   executive_metrics  {fromStr: today-365d, toStr: today}
 *   kpi_summary        {asOfStr: today}
 *   orders_list        {page: 1, pageSize: 20}
 *   revenue_timeseries {fromStr: today-90d, toStr: today, grain: 'day'}
 *   data_health        {}          tracking_health {}
 *   blended_roas       {}          order_status_mix {}   (routeMetric metrics — warmed via the cache
 *                                                          so WS-2 D4's cache-fronting lands warm)
 *
 * ── AUTH (cluster-internal, service-token) ────────────────────────────────────────────────────
 * Mounted OUTSIDE `/api/v1` (not a browser route; no session/CSRF path). A shared service token
 * (SERVING_WARM_TOKEN) is required in the `x-internal-token` header — the transform tick sends it.
 * When no token is CONFIGURED the endpoint is DISABLED (404) so a misconfigured deploy can never
 * expose an unauthenticated warm trigger. Same posture as the tick's fail-open POST: an auth reject
 * simply means the tick logs a non-2xx and moves on (the cache TTL is the net).
 *
 * ── SAFE / FAIL-OPEN ──────────────────────────────────────────────────────────────────────────
 * The whole warm loop is best-effort: a per-(brand, dataset) read failure is counted and skipped —
 * one bad brand never aborts the sweep. The endpoint always returns 200 with a `{warmed, failed}`
 * tally so the tick has evidence without ever seeing a 5xx it would (fail-open) ignore anyway.
 *
 * @see packages/metric-engine/src/serving-cache.ts — servingCache.read (the primed chokepoint)
 * @see db/iceberg/duckdb/run_all.py — _run_serving_warm (the tick-side POST, flag SERVING_WARM_ON_WRITE)
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type pg from 'pg';
import type { SilverPool, ServingCacheReader } from '@brain/metric-engine';
import {
  getExecutiveMetrics,
  getKpiSummary,
  getOrdersList,
  getRevenueTimeseries,
  getDataHealth,
  getTrackingHealth,
  getBlendedRoas,
  getOrderStatusMix,
} from '../../analytics/index.js';

export interface ServingWarmDeps {
  /** The Redis-fronted serving-cache chokepoint (the keys we prime). */
  servingCache?: ServingCacheReader;
  /** Silver serving pool (StarRocks/duckdb-serving seam) — most datasets read it. */
  srPool?: SilverPool;
  /** Raw PG pool — data_health / tracking_health / orders_list read it. */
  rawPool?: pg.Pool;
  /** The cluster-internal service token the caller must present. Absent → endpoint disabled (404). */
  warmToken?: string;
  /** Active-brand enumerator — defaults to `SELECT id FROM list_active_brand_ids()` over rawPool. */
  listActiveBrandIds?: () => Promise<string[]>;
}

/** The measured slow-cold hot dataset allowlist (ADR-0019 WS-4 D7). Order is the warm order. */
export const HOT_WARM_DATASETS = [
  'executive_metrics',
  'kpi_summary',
  'orders_list',
  'revenue_timeseries',
  'data_health',
  'tracking_health',
  'blended_roas',
  'order_status_mix',
] as const;
export type HotWarmDataset = (typeof HOT_WARM_DATASETS)[number];

/** today (UTC, YYYY-MM-DD). */
function today(): string {
  return new Date().toISOString().split('T')[0] as string;
}
/** today minus `days` (UTC, YYYY-MM-DD). */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string;
}

/**
 * Warm ONE (brand, dataset) through servingCache.read — the SAME metricId + default-window params +
 * compute closure the route uses. Returns without a cache read when a required dep is absent (the
 * route would 503 too — nothing to warm). Throws on a compute failure (the caller counts + skips).
 */
async function warmOne(dataset: HotWarmDataset, brandId: string, deps: ServingWarmDeps): Promise<boolean> {
  const { servingCache, srPool, rawPool } = deps;
  if (!servingCache) return false; // no cache → nothing to prime (safe-off)
  const cached = <T>(metricId: string, params: unknown, compute: () => Promise<T>): Promise<T> =>
    servingCache.read(brandId, metricId, params, compute);

  switch (dataset) {
    case 'executive_metrics': {
      if (!srPool) return false;
      const fromStr = daysAgo(365);
      const toStr = today();
      await cached('executive_metrics', { fromStr, toStr }, () =>
        getExecutiveMetrics(
          brandId,
          { fromDate: new Date(`${fromStr}T00:00:00Z`), toDate: new Date(`${toStr}T00:00:00Z`) },
          { srPool },
        ),
      );
      return true;
    }
    case 'kpi_summary': {
      if (!srPool) return false;
      const asOfStr = today();
      await cached('kpi_summary', { asOfStr }, () =>
        getKpiSummary(brandId, new Date(`${asOfStr}T00:00:00Z`), { srPool }),
      );
      return true;
    }
    case 'orders_list': {
      if (!rawPool) return false;
      const page = 1;
      const pageSize = 20;
      await cached('orders_list', { page, pageSize }, () =>
        getOrdersList(brandId, { page, pageSize }, { pool: rawPool, srPool }),
      );
      return true;
    }
    case 'revenue_timeseries': {
      if (!srPool) return false;
      const fromStr = daysAgo(90);
      const toStr = today();
      await cached('revenue_timeseries', { fromStr, toStr, grain: 'day' }, () =>
        getRevenueTimeseries(
          brandId,
          { fromDate: new Date(`${fromStr}T00:00:00Z`), toDate: new Date(`${toStr}T00:00:00Z`), grain: 'day' },
          { srPool },
        ),
      );
      return true;
    }
    case 'data_health': {
      if (!rawPool) return false;
      await cached('data_health', {}, () => getDataHealth(brandId, { pool: rawPool, srPool }));
      return true;
    }
    case 'tracking_health': {
      if (!rawPool) return false;
      await cached('tracking_health', {}, () => getTrackingHealth(brandId, { pool: rawPool, srPool }));
      return true;
    }
    case 'blended_roas': {
      if (!srPool) return false;
      // Route default window: last 35 days. routeMetric goes via semanticRouter today (uncached); we prime
      // the cache key WS-2 D4 will front, using the legacy read (measurementMartsMigration default OFF).
      const fromStr = daysAgo(35);
      const toStr = today();
      await cached('blended_roas', {}, () =>
        getBlendedRoas(
          brandId,
          { fromDate: new Date(`${fromStr}T00:00:00Z`), toDate: new Date(`${toStr}T00:00:00Z`) },
          { srPool, measurementMartsMigration: false },
        ),
      );
      return true;
    }
    case 'order_status_mix': {
      if (!srPool) return false;
      // Route default window: last 30 days (fromStr T00:00:00 → toStr T23:59:59).
      const fromStr = daysAgo(30);
      const toStr = today();
      await cached('order_status_mix', {}, () =>
        getOrderStatusMix(
          brandId,
          { srPool },
          {
            from: new Date(`${fromStr}T00:00:00Z`),
            to: new Date(`${toStr}T23:59:59Z`),
            fromStr,
            toStr,
            dataSource: 'synthetic',
          },
        ),
      );
      return true;
    }
    default:
      return false;
  }
}

/**
 * Register `POST /internal/serving/warm` — cluster-internal, service-token-gated, OUTSIDE `/api/v1`.
 *
 * Body: `{ brands?: 'all' | string[], datasets?: 'all' | HotWarmDataset[] }` (both default 'all').
 * Iterates the resolved (dataset × brand) grid and warms each through servingCache.read. Always
 * returns 200 `{ warmed, failed, brands, datasets }` — the tick is fail-open and ignores non-2xx.
 */
export function registerServingWarmRoute(app: FastifyInstance, deps: ServingWarmDeps): void {
  const warmToken = (deps.warmToken ?? '').trim();
  const listActiveBrandIds =
    deps.listActiveBrandIds ??
    (async (): Promise<string[]> => {
      if (!deps.rawPool) return [];
      const r = await deps.rawPool.query<{ id: string }>('SELECT id FROM list_active_brand_ids()');
      return r.rows.map((row) => row.id);
    });

  app.post(
    '/internal/serving/warm',
    async (request: FastifyRequest, reply: FastifyReply) => {
      // AUTH: no token configured → endpoint disabled (never an unauthenticated warm trigger).
      if (!warmToken) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'warm endpoint disabled' } });
      }
      const presented = Array.isArray(request.headers['x-internal-token'])
        ? request.headers['x-internal-token'][0]
        : request.headers['x-internal-token'];
      if (!presented || presented !== warmToken) {
        return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'invalid internal token' } });
      }

      const body = (request.body ?? {}) as { brands?: unknown; datasets?: unknown };
      // Datasets: 'all'/absent → the full allowlist; else the subset that is IN the allowlist (ignore junk).
      const datasets: HotWarmDataset[] =
        Array.isArray(body.datasets)
          ? HOT_WARM_DATASETS.filter((d) => (body.datasets as unknown[]).includes(d))
          : [...HOT_WARM_DATASETS];
      // Brands: 'all'/absent → active brands from the DB; else the explicit list (strings only).
      const brands: string[] = Array.isArray(body.brands)
        ? (body.brands as unknown[]).filter((b): b is string => typeof b === 'string')
        : await listActiveBrandIds();

      let warmed = 0;
      let failed = 0;
      for (const brandId of brands) {
        for (const dataset of datasets) {
          try {
            if (await warmOne(dataset, brandId, deps)) warmed += 1;
          } catch (err) {
            // One bad (brand, dataset) never aborts the sweep — count + continue (fail-open at the leaf too).
            failed += 1;
            app.log.warn(
              { brandId, dataset, err: err instanceof Error ? err.message : String(err) },
              '[serving-warm] warm read failed (skipped)',
            );
          }
        }
      }
      return reply.send({ warmed, failed, brands: brands.length, datasets: datasets.length });
    },
  );
}
