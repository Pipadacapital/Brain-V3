/**
 * Brain V4 — SERVING load test (k6).
 *
 * Hits the BFF analytics read endpoints (mounted on the core app at :3000, path prefix
 * /api/v1/analytics/* and /api/v1/dashboard/*). Every route is session-protected
 * (bffProtectedPreHandler) and resolves the tenant brand FROM THE SESSION (auth.brandId),
 * never from the request — so this script authenticates by replaying a real session cookie
 * (AUTH_COOKIE env, the `brain_session=...` cookie from a logged-in browser).
 *
 * The read path is ADR-002 sole-read-path: route → analytics query wrapper → metric engine →
 * duckdb-serving-over-Iceberg, fronted by the Redis serving cache (ServingCacheReader.getOrSet keyed by
 * brand/metric/paramsHash/servingVersion). Latency is therefore bimodal:
 *   - cache HIT  → Redis round-trip, target p95 < 500ms
 *   - cache MISS → duckdb-serving scan of the Gold/Silver marts, target p95 < 3s
 * We model this with TWO scenarios so the thresholds are honest and separable:
 *   - `warmup` runs FIRST against a cold cache  → its p95 is the cache-MISS budget (< 3s)
 *   - `steady` runs after warmup against a hot cache → its p95 is the cache-HIT budget (< 500ms)
 *
 * Run:  k6 run -e AUTH_COOKIE="brain_session=..." tools/load-test/serving.js
 * Env:  BASE_URL, AUTH_COOKIE, VUS, DURATION
 * See   tools/load-test/README.md
 */
import http from 'k6/http';
import { check } from 'k6';

const BASE_URL = (__ENV.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const AUTH_COOKIE = __ENV.AUTH_COOKIE || ''; // e.g. "brain_session=<jwt>" (copy from a logged-in browser)
const VUS = Number(__ENV.VUS || 20);
const DURATION = __ENV.DURATION || '3m';

// Realistic dashboard read fan-out. Each entry is a representative analytics endpoint with the
// query params the UI actually sends (defaults mirror the route handlers when params are omitted).
const TODAY = new Date().toISOString().split('T')[0];
const FROM_90 = new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0];
const FROM_30 = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];

const ENDPOINTS = [
  { name: 'executive-metrics', path: `/api/v1/analytics/executive-metrics?from=${FROM_90}&to=${TODAY}` },
  { name: 'kpi-summary', path: `/api/v1/analytics/kpi-summary?as_of=${TODAY}` },
  { name: 'revenue-timeseries', path: `/api/v1/analytics/revenue-timeseries?from=${FROM_90}&to=${TODAY}&grain=day` },
  { name: 'customer-360', path: `/api/v1/dashboard/customer-360` },
  { name: 'cohort-retention', path: `/api/v1/analytics/cohort-retention` },
  { name: 'funnel', path: `/api/v1/analytics/funnel` },
  { name: 'attribution-by-channel', path: `/api/v1/analytics/attribution/by-channel?from=${FROM_30}&to=${TODAY}&model=position_based` },
  { name: 'orders-list', path: `/api/v1/analytics/orders-list?limit=50` },
  { name: 'top-products', path: `/api/v1/analytics/top-products` },
];

export const options = {
  scenarios: {
    // Phase 1 — cold cache. One pass per endpoint per VU populates Redis; latency here is cache-MISS.
    warmup: {
      executor: 'per-vu-iterations',
      vus: Math.min(VUS, 5),
      iterations: ENDPOINTS.length,
      maxDuration: '2m',
      startTime: '0s',
      exec: 'warmup',
      tags: { phase: 'warmup' },
    },
    // Phase 2 — hot cache. Sustained read load; latency here is cache-HIT. Starts after warmup window.
    steady: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: VUS },
        { duration: DURATION, target: VUS },
        { duration: '20s', target: 0 },
      ],
      startTime: '2m', // must be >= warmup maxDuration so the cache is hot
      exec: 'steady',
      tags: { phase: 'steady' },
      gracefulRampDown: '20s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'], // < 1% errors across both phases
    // Cache MISS budget (cold warmup pass against duckdb-serving-over-Iceberg).
    'http_req_duration{phase:warmup}': ['p(95)<3000'],
    // Cache HIT budget (hot steady-state from the Redis serving cache).
    'http_req_duration{phase:steady}': ['p(95)<500'],
    checks: ['rate>0.99'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

function params(endpointName, phase) {
  const headers = { Accept: 'application/json' };
  if (AUTH_COOKIE) headers.Cookie = AUTH_COOKIE;
  return { headers, tags: { endpoint: endpointName, phase }, redirects: 0 };
}

// Assert a healthy BFF read: 200 + the { request_id, data } envelope every route returns. A 401
// means AUTH_COOKIE is missing/expired (fail loud, do not silently pass); 503 means the Silver/serving
// tier is down — both are real failures the threshold should catch.
function hit(ep, phase) {
  const res = http.get(`${BASE_URL}${ep.path}`, params(ep.name, phase));
  check(res, {
    [`${ep.name} 200`]: (r) => r.status === 200,
    [`${ep.name} has data envelope`]: (r) => {
      try {
        const b = JSON.parse(r.body);
        return b && typeof b.request_id === 'string' && 'data' in b;
      } catch (_e) {
        return false;
      }
    },
  });
  return res;
}

export function setup() {
  if (!AUTH_COOKIE) {
    // eslint-disable-next-line no-console
    console.warn(
      'WARNING: AUTH_COOKIE is empty — every request will 401 and brandId resolves to none. ' +
        'Set -e AUTH_COOKIE="brain_session=..." (see README).',
    );
  }
}

// Warmup: each VU walks every endpoint once (cold cache → cache-MISS latency).
export function warmup() {
  for (const ep of ENDPOINTS) hit(ep, 'warmup');
}

// Steady: pick a random endpoint each iteration (hot cache → cache-HIT latency).
export function steady() {
  const ep = ENDPOINTS[Math.floor(Math.random() * ENDPOINTS.length)];
  hit(ep, 'steady');
}

export function handleSummary(data) {
  return {
    stdout:
      '\n  Thresholds: cache-HIT (steady) p95<500ms, cache-MISS (warmup) p95<3s, http_req_failed<1%.\n' +
      '  OUT-OF-BAND: confirm zero duckdb-serving OOM-kill/504 during the run (see README "Operator post-run assertions").\n',
    'load-test-serving-summary.json': JSON.stringify(data, null, 2),
  };
}
