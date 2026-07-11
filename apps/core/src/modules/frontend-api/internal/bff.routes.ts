/**
 * BFF (Backend For Frontend) route composition.
 *
 * Responsibilities:
 *  - httpOnly cookie ↔ short-lived access token exchange.
 *  - CSRF protection (double-submit cookie pattern).
 *  - Session revocation preHandler on EVERY protected route (NN-3).
 *  - X-Brand-Id assertion on every brand-scoped request.
 *  - Correlation ID forwarding.
 *  - Proxy routes for connector + pixel endpoints.
 *  - Dashboard aggregate endpoints (MED-BFF-DASH-01):
 *      GET /api/v1/dashboard/brand-summary
 *      GET /api/v1/dashboard/connection-status
 *      GET /api/v1/dashboard/data-status
 *      GET /api/v1/dashboard/onboarding-progress
 *      GET /api/v1/dashboard/realized-revenue  (Track A, ADR-002 sole-read-path)
 *
 * Scope: apps/web calls ONLY the BFF — never calls workspace-access or connector directly.
 * Data sources: Postgres (OLTP) + the Silver tier. Silver (StarRocks) reads go through
 * the metric-engine seam (ADR-002 / I-ST01 sole read path) — the route itself issues NO
 * OLAP SQL directly (it calls the analytics use-case → withSilverBrand). The prior header
 * "ZERO StarRocks calls" reflected the pre-Silver state.
 *
 * STRUCTURE (CQ-1 decomposition): the ~88 route handlers are split into cohesive per-feature
 * Fastify route-PLUGIN files under ./routes/. This function owns the shared scaffolding (the
 * CSRF token endpoint, the session-validation preHandlers, the foundation-signal gatherer),
 * builds the shared BffDeps bundle, and composes the plugins — so the public registration
 * entrypoint + every route path/method/response/auth/brand-scope is byte-identical.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
// Public surface of workspace-access — imported via its barrel, NEVER its internals (I-E05).
import {
  validateSessionPreHandler,
  type AuthService,
  type OnboardingService,
  type RateLimiter,
} from '../../workspace-access/index.js';
import type { DbPool, QueryContext } from '@brain/db';
import { jtiFromJwt, csrfTokenForSession } from './csrf.js';
import type { Pool as PgPool } from 'pg';
import { getDataHealth, freshnessFromIngest, type FoundationSignals } from '../../analytics/index.js';
import { getMetricTrust } from '../../data-quality/index.js';
import { CONNECTOR_CATALOG } from '../../connector/catalog/registry.js';
import type { IdentityReader, ContactPiiVaultService } from '../../identity/index.js';
import type { SilverPool, ServingCacheReader, TouchpointZsetClient, SemanticServingRouter } from '@brain/metric-engine';

import {
  type BffDeps,
  type CookieReply,
  COOKIE_NAME,
  CSRF_COOKIE_NAME,
  ACCESS_TOKEN_EXPIRY_SECS,
} from './routes/_shared.js';
import { registerAuthSessionRoutes } from './routes/auth-session.routes.js';
import { registerDashboardRoutes } from './routes/dashboard.routes.js';
import { registerIdentityRoutes } from './routes/identity.routes.js';
import { registerAskRoutes } from './routes/ask.routes.js';
import { registerBillingRoutes } from './routes/billing.routes.js';
import { registerDecisionsRoutes } from './routes/decisions.routes.js';
// SPEC: G (AMD-21) — NEW gold_recommendations-backed 501 stub; separate from the grandfathered decisions surface.
import { registerRecommendationsGeneratedRoutes } from './routes/recommendations-generated.routes.js';
// SPEC: E — AI Feature Layer online-serving 501 stub (behind features.online_serving).
import { registerFeaturesRoutes } from './routes/features.routes.js';
// SPEC: D.2 — semantic metric catalog discovery (GET /api/v1/semantic/metrics + per-metric).
import { registerSemanticMetricsRoutes } from './routes/semantic-metrics.routes.js';
import { registerAttributionRoutes } from './routes/attribution.routes.js';
import { registerAnalyticsCoreRoutes } from './routes/analytics-core.routes.js';
import { registerAnalyticsMarketingRoutes } from './routes/analytics-marketing.routes.js';
import { registerAnalyticsLogisticsRoutes } from './routes/analytics-logistics.routes.js';
import { registerAnalyticsJourneyRoutes } from './routes/analytics-journey.routes.js';
import { registerJourneyApiRoutes } from './routes/journey-api.routes.js'; // SPEC: B.3 (AMD-14)
import { registerTrackingRoutes } from './routes/tracking.routes.js';
import { registerConsentRoutes } from './routes/consent.routes.js';
import { registerFeedbackRoutes } from './routes/feedback.routes.js';
import { registerSegmentsRoutes } from './routes/segments.routes.js';
import { registerAdminFlagsRoutes } from './routes/admin-flags.routes.js';
import type { FlagService } from '@brain/platform-flags';
import type { IdentityEventPublisher } from '../../../infrastructure/events/IdentityEventPublisher.js';
import type { ErasureEventPublisher } from '../../../infrastructure/events/ErasureEventPublisher.js';

export function registerBffRoutes(
  fastify: FastifyInstance,
  authService: AuthService,
  pool?: DbPool,
  cookieSecret = '',
  rateLimiter?: RateLimiter,
  rawPool?: PgPool,
  onboardingService?: OnboardingService,
  srPool?: SilverPool,
  vaultService?: ContactPiiVaultService,
  /** MEDALLION REALIGNMENT (Epic 3 / ADR-0004): the identity SoR read/admin port (DIP — concrete Neo4jIdentityReader injected by main.ts). */
  identityReader?: IdentityReader,
  /** Per-brand salt resolver (brandSaltSource) for Customer-360 search hashing. Trailing-optional. */
  getCoreSaltHex?: (brandId: string) => Promise<string>,
  /** Brain V4 serving cache (Redis-fronted hot serving reads over the Trino seam). Trailing-optional. */
  servingCache?: ServingCacheReader,
  /** SPEC: 0.5 — per-brand feature flags (Redis-backed, DEFAULT OFF, fail-closed). Trailing-optional. */
  flagService?: FlagService,
  /** SPEC: A.2.4 (WA-19, AMD-08) — identity-lane producer for the admin unmerge. Trailing-optional. */
  identityEventPublisher?: IdentityEventPublisher,
  /** SPEC: B.3 / A.4 — the Redis touchpoint-cache read client (shared ioredis). Trailing-optional. */
  touchpointCacheReader?: TouchpointZsetClient,
  /** SPEC: D.3 — semantic-serving flag switch (compiled-view migration; DEFAULT OFF). Trailing-optional. */
  semanticRouter?: SemanticServingRouter,
  /** AUD-OPS-036 — RTBF erasure-trigger bridge (identity erase route). Trailing-optional. */
  erasureEventPublisher?: ErasureEventPublisher,
): void {
  const sessionPreHandler = validateSessionPreHandler(authService);

  // ── Foundation-signal gatherer (P1/P2) ──────────────────────────────────────
  // Shared by the data-foundation-health + entitlements routes: composes the existing health
  // reads (pixel, ANY connected storefront connector, ingest freshness, DQ trust) into the
  // FoundationSignals both verdicts derive from. Storefront detection is catalog-driven
  // (connector-GENERAL — Shopify is one storefront app of many). Callers guard pool/rawPool first.
  const STOREFRONT_PROVIDERS = CONNECTOR_CATALOG.filter((c) => c.category === 'storefront').map((c) => c.id);
  // All 7-state health values that mean data is NOT flowing reliably (ADR-CM-5).
  // RateLimited added: a rate-limited connector cannot serve data and must not be reported healthy.
  // NOTE: 'Delayed' is NOT included — data is still flowing, just behind schedule.
  const UNHEALTHY_CONNECTOR_STATES = new Set(['Failed', 'Disconnected', 'TokenExpired', 'RateLimited', 'Disabled']);
  const gatherFoundationSignalsUncached = async (
    brandId: string,
    requestId: string,
  ): Promise<FoundationSignals> => {
    const ctx: QueryContext = { brandId, correlationId: requestId };
    let pixelInstalled = false;
    let commerceConnected = false;
    let commerceHealthy = false;
    const client = await pool!.connect();
    try {
      const [pixelRes, commerceRes] = await Promise.all([
        client.query<{ installed: boolean }>(
          ctx,
          `SELECT EXISTS(SELECT 1 FROM pixel_installation WHERE brand_id = $1 AND installed_at IS NOT NULL) AS installed`,
          [brandId],
        ),
        // ANY connected storefront connector (prefer a connected one) — connector-general.
        client.query<{ status: string; health_state: string | null }>(
          ctx,
          `SELECT status, health_state FROM connector_instance
            WHERE brand_id = $1 AND provider = ANY($2::text[])
            ORDER BY (status = 'connected') DESC, created_at DESC LIMIT 1`,
          [brandId, STOREFRONT_PROVIDERS],
        ),
      ]);
      pixelInstalled = pixelRes.rows[0]?.installed === true;
      const commerce = commerceRes.rows[0];
      commerceConnected = commerce?.status === 'connected';
      // Fail-closed: if health_state is NULL (should not happen post-0021 — column is NOT NULL — but
      // defensively treat an absent/null health as 'Failed' so the gate does not pass silently).
      // TokenExpired and RateLimited are in UNHEALTHY_CONNECTOR_STATES above, so a connector whose
      // repull runner just transitioned its health_state will correctly report !commerceHealthy here.
      commerceHealthy = commerceConnected && !UNHEALTHY_CONNECTOR_STATES.has(commerce?.health_state ?? 'Failed');
    } finally {
      client.release();
    }
    // PERF: getDataHealth (Trino Bronze + PG sync) and getMetricTrust (PG DQ) are independent —
    // run them concurrently instead of back-to-back. Each opens its own pooled connection.
    const [dataHealth, trust] = await Promise.all([
      getDataHealth(brandId, { pool: rawPool!, srPool }),
      getMetricTrust(brandId, { pool: rawPool! }),
    ]);
    const hasData = dataHealth.state === 'has_data';
    return {
      pixelInstalled,
      commerceConnected,
      commerceHealthy,
      initialSyncStarted: hasData ? dataHealth.syncState !== null : false,
      firstEventReceived: hasData,
      freshness: freshnessFromIngest(hasData ? dataHealth.lastIngestAt : null, Date.now()),
      dqTier: trust.tier,
    };
  };

  // PERF: the foundation signals are Trino-heavy (~several seconds cold) and are read by BOTH
  // the entitlements and data-foundation-health routes on every dashboard load. Cache them per
  // brand through the serving cache so the two routes (and repeat loads within the TTL) share a
  // SINGLE compute instead of each re-running the same reads. Params are empty — signals are
  // purely per-brand. Safe-OFF: no cache wired → compute directly. Per-brand invalidation on new
  // data is handled by the same AnalyticsCacheInvalidateConsumer that fronts the metric reads.
  const gatherFoundationSignals = async (
    brandId: string,
    requestId: string,
  ): Promise<FoundationSignals> => {
    const compute = (): Promise<FoundationSignals> =>
      gatherFoundationSignalsUncached(brandId, requestId);
    return servingCache
      ? servingCache.read(brandId, 'foundation_signals', {}, compute)
      : compute();
  };

  // ── CSRF token endpoint ────────────────────────────────────────────────────
  // GET /api/v1/bff/csrf — issues a session-bound CSRF token (SEC-0009-M02). When
  // the request carries a session, the token is HMAC(cookieSecret, jti) — bound to
  // that session and invalidated when it rotates/revokes. Pre-session callers get a
  // random token (only used on CSRF-exempt routes).
  fastify.get('/api/v1/bff/csrf', async (request: FastifyRequest, reply: FastifyReply) => {
    const reqCookies = (request as unknown as { cookies: Record<string, string | undefined> }).cookies;
    const jti = jtiFromJwt(reqCookies?.[COOKIE_NAME]);
    const csrfToken = jti && cookieSecret ? csrfTokenForSession(jti, cookieSecret) : randomUUID();
    (reply as CookieReply).setCookie(CSRF_COOKIE_NAME, csrfToken, {
      httpOnly: false, // CSRF cookie must be readable by JS
      secure: process.env['NODE_ENV'] === 'production',
      sameSite: 'strict',
      path: '/',
      maxAge: ACCESS_TOKEN_EXPIRY_SECS, // SEC-0009-L02: match session lifetime
    });
    return reply.send({ csrf_token: csrfToken });
  });

  // ── BFF session validation preHandler (NN-3) ──────────────────────────────
  /**
   * All BFF protected routes run this preHandler FIRST:
   * 1. Reads the httpOnly cookie (set by /api/v1/bff/session).
   * 2. Validates CSRF token (double-submit pattern).
   * 3. Validates the session via validateSessionPreHandler (NN-3).
   * 4. Attaches request.auth for downstream handlers.
   */
  async function bffProtectedPreHandler(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const requestId = randomUUID();

    // Step 1: Read httpOnly session cookie.
    // request.cookies is added by @fastify/cookie at runtime; we cast via unknown
    // because NodeNext module isolation prevents automatic type augmentation here.
    const reqCookies = (request as unknown as { cookies: Record<string, string | undefined> }).cookies;
    const sessionToken = reqCookies[COOKIE_NAME];
    if (!sessionToken) {
      return reply.code(401).send({
        request_id: requestId,
        error: { code: 'UNAUTHORIZED', message: 'No session cookie.' },
      });
    }

    // MA-14 / B-8: The authoritative CSRF check (jti-bound double-submit, SEC-0009-M02)
    // runs in the app-wide onRequest hook in main.ts. The weaker plain-equality check
    // that was here has been REMOVED to eliminate the duplicate and the weaker variant.
    // The app-wide hook enforces HMAC(cookieSecret, jti) binding, not just cookie===header.

    // Step 3: Set Authorization header for the downstream session preHandler.
    // The cookie contains the access token directly (in M1 BFF, cookie = access token).
    request.headers.authorization = `Bearer ${sessionToken}`;

    // Step 4: Delegate to the standard session validation (NN-3).
    return sessionPreHandler(request, reply);
  }

  // ── Compose the shared deps bundle handed to every route plugin ────────────
  const deps: BffDeps = {
    authService,
    pool,
    cookieSecret,
    rateLimiter,
    rawPool,
    onboardingService,
    srPool,
    servingCache,
    touchpointCacheReader,
    semanticRouter,
    flagService,
    vaultService,
    identityReader,
    identityEventPublisher,
    erasureEventPublisher,
    getCoreSaltHex,
    sessionPreHandler,
    bffProtectedPreHandler,
    gatherFoundationSignals,
  };

  // ── Protected BFF proxy routes ─────────────────────────────────────────────
  // These routes require bffProtectedPreHandler (NN-3 + CSRF + cookie).
  // They proxy to the internal service implementations.
  // Brand assertion: if X-Brand-Id is present, it must match auth.brandId (or null).
  fastify.addHook('preHandler', async (request: FastifyRequest) => {
    if (!request.routeOptions?.url?.startsWith('/api/v1/bff/')) return;
    // Already handled by per-route preHandlers above.
  });

  // ── Register the per-feature route plugins (each registers only its own routes) ──
  registerAuthSessionRoutes(fastify, deps);
  registerDashboardRoutes(fastify, deps);
  registerIdentityRoutes(fastify, deps);
  registerAskRoutes(fastify, deps);
  registerBillingRoutes(fastify, deps);
  registerDecisionsRoutes(fastify, deps);
  // SPEC: G (AMD-21) — additive; the shipped /api/v1/recommendations surface above is untouched.
  registerRecommendationsGeneratedRoutes(fastify, deps);
  // SPEC: E — GET /api/v1/features/:entity_type/:entity_id → 501 behind features.online_serving.
  registerFeaturesRoutes(fastify, deps);
  registerSemanticMetricsRoutes(fastify, deps); // SPEC: D.2 — GET /api/v1/semantic/metrics
  registerAttributionRoutes(fastify, deps);
  registerAnalyticsCoreRoutes(fastify, deps);
  registerAnalyticsMarketingRoutes(fastify, deps);
  registerAnalyticsLogisticsRoutes(fastify, deps);
  registerAnalyticsJourneyRoutes(fastify, deps);
  registerJourneyApiRoutes(fastify, deps); // SPEC: B.3 (AMD-14) — /api/v1/customers/:brainId/journey, /api/v1/journeys/{trace,compare}
  registerTrackingRoutes(fastify, deps);
  registerConsentRoutes(fastify, deps);
  registerFeedbackRoutes(fastify, deps);
  registerSegmentsRoutes(fastify, deps);
  registerAdminFlagsRoutes(fastify, deps); // SPEC: 0.5 — GET/PUT /api/v1/admin/flags
}
