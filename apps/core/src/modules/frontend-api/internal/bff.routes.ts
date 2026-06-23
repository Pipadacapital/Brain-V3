/**
 * BFF (Backend For Frontend) routes.
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
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';

// @fastify/cookie v11 module augmentation is not automatically applied in
// NodeNext module resolution when the package has no `exports` field.
// We define local helpers to type the cookie-augmented reply/request without
// relying on side-effect augmentation propagation.
type CookieOptions = {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'strict' | 'lax' | 'none' | boolean;
  path?: string;
  maxAge?: number;
  domain?: string;
  expires?: Date;
};
type CookieReply = FastifyReply & {
  setCookie(name: string, value: string, options?: CookieOptions): CookieReply;
  clearCookie(name: string, options?: CookieOptions): CookieReply;
};
// Public surface of workspace-access — imported via its barrel, NEVER its internals (I-E05).
import {
  AuthError,
  OnboardingError,
  validateSessionPreHandler,
  MembershipRepository,
  OrganizationRepository,
  loginFailKeySync,
  loginIpKey,
  registerIpKey,
  type AuthService,
  type OnboardingService,
  type AuthenticatedRequest,
  type OnboardingStatus,
  type RateLimiter,
} from '../../workspace-access/index.js';
import type { DbPool, QueryContext } from '@brain/db';
import { ProvisionOnboardingRequestSchema } from '@brain/contracts';
// BFF read-contract enforcement (feat-shared-bff-read-contracts): annotate each covered
// use-case result with its `@brain/contracts` z.infer type so core FAILS tsc if its DTO drifts
// from the shared schema — compile-time guard, ZERO payload change (02-architecture.md §5).
import type {
  RevenueSnapshot as ContractRevenueSnapshot,
  KpiSummary as ContractKpiSummary,
  AttributionByChannel as ContractAttributionByChannel,
  AttributionReconciliation as ContractAttributionReconciliation,
  ChannelRoas as ContractChannelRoas,
  JourneyFirstTouchMix as ContractJourneyFirstTouchMix,
  ShipmentOutcomes as ContractShipmentOutcomes,
  BehaviorOverview as ContractBehaviorOverview,
  FunnelAnalytics as ContractFunnelAnalytics,
  AbandonedCart as ContractAbandonedCart,
  Engagement as ContractEngagement,
  JourneyTimeline as ContractJourneyTimeline,
  JourneyStitchRate as ContractJourneyStitchRate,
  OrderStatusMix as ContractOrderStatusMix,
  TopProducts as ContractTopProducts,
  OrdersList as ContractOrdersList,
  ContributionMargin as ContractContributionMargin,
  CostInputsList as ContractCostInputsList,
  OrderDetail as ContractOrderDetail,
  DataQualitySummary as ContractDataQualitySummary,
  AskBrainResult as ContractAskBrainResult,
  Customer360 as ContractCustomer360,
  CustomerList as ContractCustomerList,
  VaultCoverage as ContractVaultCoverage,
  ErasureResult as ContractErasureResult,
  MergeReviewList as ContractMergeReviewList,
  MergeResolveResult as ContractMergeResolveResult,
  UnmergeResult as ContractUnmergeResult,
  BillingPeriods as ContractBillingPeriods,
  SealPeriodResult as ContractSealPeriodResult,
  InspectableBill as ContractInspectableBill,
  Invoice as ContractInvoice,
  IssueInvoiceResult as ContractIssueInvoiceResult,
  IssueCreditNoteResult as ContractIssueCreditNoteResult,
  Recommendations as ContractRecommendations,
  GenerateRecommendationsResult as ContractGenerateRecommendationsResult,
  RecommendationAction as ContractRecommendationAction,
  AttributionReconcileResult as ContractAttributionReconcileResult,
  FoundationHealth as ContractFoundationHealth,
  Entitlements as ContractEntitlements,
  ModelList as ContractModelList,
  Model as ContractModel,
  CustomerScoreResult as ContractCustomerScoreResult,
} from '@brain/contracts';
import { jtiFromJwt, csrfTokenForSession } from './csrf.js';
import type { Pool as PgPool } from 'pg';
import { getRevenueMetrics, getRevenueTimeseries, getKpiSummary, getRecognitionBreakdown, getRecentActivity, getOrdersTimeseries, getOrderStats, getDataHealth, getSettlementSummary, getTrackingHealth, getRecentEvents, getAdSpendTimeseries, getBlendedRoas, getCodRtoRates, getCustomerBaseSummary, getCodMix, getCheckoutFunnel, getRtoRiskDistribution, getOrderStatusMix, getTopProducts, getOrdersList, getOrderDetail, getContributionMargin, listCostInputs, upsertCostInput, getJourneyFirstTouchMix, getJourneyStitchRate, getJourneyTimeline, getShipmentOutcomes, getBehaviorOverview, getFunnelAnalytics, getAbandonedCart, getEngagement, getConsentCoverage, getConsentSuppressionSummary, getConsentGateActivity, getConsentWindowConfig, getAttributionByChannel, getAttributionReconciliation, getChannelRoas, getCampaignRoas, getExecutiveMetrics, getCohortRetention, getInsightsBriefing, getCapiFeedbackSummary, getCapiFeedbackEvents, getCapiFeedbackDeletions } from '../../analytics/index.js';
import { getDataQualitySummary, getMetricTrust } from '../../data-quality/index.js';
import { computeFoundationHealth, freshnessFromIngest, computeEntitlements, type FoundationSignals } from '../../analytics/index.js';
import { CONNECTOR_CATALOG } from '../../connector/catalog/registry.js';
import {
  getCustomer360,
  listCustomers,
  eraseCustomer,
  listMergeReviews,
  resolveMergeReview,
  unmergeCustomer,
} from '../../identity/index.js';
import {
  getBillingPeriods,
  sealBillingPeriod,
  getInspectableBill,
  issueInvoice,
  issueCreditNote,
  getInvoice,
} from '../../billing/index.js';
import {
  getRecommendations,
  generateRecommendations,
  materializeInsightsAsRecommendations,
  recordRecommendationAction,
  isRecommendationAction,
  RecommendationNotFoundError,
  InvalidRecommendationActionError,
} from '../../recommendation/index.js';
import {
  listModels,
  promoteModel,
  serveCustomerScore,
  isModelStage,
  ModelNotFoundError,
  InvalidModelStageError,
} from '../../ml/index.js';
import { reconcileAttribution } from '../../attribution/index.js';
import type { ContactPiiVaultService } from '../../identity/index.js';
import { askBrain } from '../../ai/index.js';
import { ResolverClient } from '@brain/ai-gateway-client';
import type { AttributionModelId } from '@brain/metric-engine';
import type { AdPlatform } from '@brain/metric-engine';
import type { TimeGrain } from '@brain/metric-engine';
import type { SilverPool } from '@brain/metric-engine';

// Phase 8 — the NLQ resolver gateway client (litellm @ LITELLM_BASE_URL, latest Claude).
// Constructed once and reused; the raw question is passed in-memory only (never persisted/logged).
const askResolverClient = new ResolverClient();

const COOKIE_NAME = 'brain_session';
const CSRF_COOKIE_NAME = 'brain_csrf';
const CSRF_HEADER_NAME = 'x-csrf-token';
const ACCESS_TOKEN_EXPIRY_SECS = 60 * 60; // 1 hour — matches the session cookie maxAge

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
  const gatherFoundationSignals = async (
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
    const dataHealth = await getDataHealth(brandId, { pool: rawPool!, srPool });
    const trust = await getMetricTrust(brandId, { pool: rawPool! });
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

  // ── POST /api/v1/bff/session — exchange credentials for session cookie ────
  // QA-03: Rate limited per-(email+IP) and per-IP (same limits as /auth/login — AC-3).
  fastify.post('/api/v1/bff/session', async (request: FastifyRequest, reply: FastifyReply) => {
    const requestId = randomUUID();
    const correlationId = (request.headers['x-correlation-id'] as string) ?? requestId;
    const { email, password } = request.body as { email?: string; password?: string };

    if (!email || !password) {
      return reply.code(400).send({
        request_id: requestId,
        error: { code: 'MISSING_CREDENTIALS', message: 'email and password required.' },
      });
    }

    // AC-3 / QA-03: Rate-limit pattern mirrors auth.routes.ts exactly (SEC-AOF-N1 fix):
    //   Entry  — increment per-IP cap (loginIpKey) only; block if over limit.
    //   Catch  — increment per-(email+IP) failure counter (loginFailKey) on failure.
    //   Success— reset BOTH loginFailKey and loginIpKey (clear the window on good auth).
    // loginFailKey is NOT touched at entry so each failed attempt counts exactly once.
    if (rateLimiter) {
      const ip = request.ip ?? '0.0.0.0';
      const ipRl = await rateLimiter.check(loginIpKey(ip), 20, 900);
      if (!ipRl.allowed) {
        return reply.code(429).send({
          request_id: requestId,
          error: { code: 'RATE_LIMITED', message: 'Too many login attempts. Please try again later.' },
        }).header('Retry-After', String(ipRl.retryAfter));
      }
    }

    try {
      const result = await authService.login(
        email,
        password,
        request.ip ?? null,
        request.headers['user-agent'] ?? null,
        correlationId,
      );

      // Reset BOTH failure counter and per-IP counter on successful login (mirrors auth.routes.ts:183-184).
      if (rateLimiter) {
        const ip = request.ip ?? '0.0.0.0';
        void rateLimiter.reset(loginFailKeySync(email, ip));
        void rateLimiter.reset(loginIpKey(ip));
      }

      // Set the httpOnly cookie with the access token.
      (reply as CookieReply).setCookie(COOKIE_NAME, result.accessToken, {
        httpOnly: true,
        secure: process.env['NODE_ENV'] === 'production',
        sameSite: 'strict',
        path: '/',
        maxAge: result.expiresIn,
      });

      // AC-5 / B-5: Surface onboarding_status enum instead of needs_onboarding boolean.
      // null → user has no workspace yet (just registered, no org membership).
      const onboardingStatus: OnboardingStatus | null = result.context.onboardingStatus;
      // QA-07: auth sub-object uses snake_case (contract §6: brand_id, workspace_id).
      return reply.send({
        request_id: requestId,
        user: {
          id: result.user.id,
          email: result.user.email,
          email_verified: result.user.emailVerifiedAt !== null,
        },
        expires_in: result.expiresIn,
        onboarding_status: onboardingStatus,
        auth: {
          brand_id: result.context.brandId,
          workspace_id: result.context.workspaceId,
          role: result.context.role,
        },
      });
    } catch {
      // Increment per-(email+IP) failure counter on failed login (mirrors auth.routes.ts catch).
      if (rateLimiter) {
        const ip = request.ip ?? '0.0.0.0';
        const emailIpRl = await rateLimiter.check(loginFailKeySync(email, ip), 5, 900);
        if (!emailIpRl.allowed) {
          return reply.code(429).send({
            request_id: requestId,
            error: { code: 'RATE_LIMITED', message: 'Too many failed login attempts. Please try again later.' },
          }).header('Retry-After', String(emailIpRl.retryAfter));
        }
      }
      return reply.code(401).send({
        request_id: requestId,
        error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' },
      });
    }
  });

  // ── POST /api/v1/bff/register — register + auto-login (feat-onboarding-ux D1) ──
  // Registers a user via AuthService.registerAndStartSession and, for a genuinely-new
  // user, sets the brain_session httpOnly cookie EXACTLY as /api/v1/bff/session does —
  // so the user lands authenticated (EMPTY_CONTEXT) and goes straight to the wizard.
  //
  // SECURITY:
  //  - No bypass: the session is minted via the SAME issueSession() primitive as login.
  //  - The session cookie is set ONLY for created=true. An email collision returns the
  //    same JSON body minus the Set-Cookie (httpOnly Set-Cookie is cross-origin-unreadable
  //    → no enumeration oracle in the visible body, NN-5).
  //  - CSRF-exempt (added to the exempt list in main.ts — establishes the session, no
  //    prior CSRF token can exist). IP rate-limited (registerIpKey, same as /auth/register).
  fastify.post('/api/v1/bff/register', async (request: FastifyRequest, reply: FastifyReply) => {
    const requestId = randomUUID();
    const correlationId = (request.headers['x-correlation-id'] as string) ?? requestId;
    const { email, password } = request.body as { email?: string; password?: string };

    if (!email || !password) {
      return reply.code(400).send({
        request_id: requestId,
        error: { code: 'MISSING_CREDENTIALS', message: 'email and password required.' },
      });
    }

    // AC-3: rate limit by IP (10/hour — same as /api/v1/auth/register).
    if (rateLimiter) {
      const ip = request.ip ?? '0.0.0.0';
      const rl = await rateLimiter.check(registerIpKey(ip), 10, 3600);
      if (!rl.allowed) {
        return reply.code(429).send({
          request_id: requestId,
          error: { code: 'RATE_LIMITED', message: 'Too many registration attempts. Please try again later.' },
        }).header('Retry-After', String(rl.retryAfter));
      }
    }

    try {
      const result = await authService.registerAndStartSession(
        email,
        password,
        request.ip ?? null,
        request.headers['user-agent'] ?? null,
        correlationId,
      );

      // Set the httpOnly session cookie ONLY for a freshly-created user (auto-login).
      if (result.created && result.accessToken && result.expiresIn) {
        (reply as CookieReply).setCookie(COOKIE_NAME, result.accessToken, {
          httpOnly: true,
          secure: process.env['NODE_ENV'] === 'production',
          sameSite: 'strict',
          path: '/',
          maxAge: result.expiresIn,
        });
      }

      // Body is byte-identical between created/existing (NN-5) — the only difference is
      // the presence of Set-Cookie (unreadable cross-origin). onboarding_status is null
      // for a just-registered user (no membership yet) → the wizard.
      return reply.code(201).send({
        request_id: requestId,
        user: {
          id: result.user.id,
          email: result.user.email,
          email_verified: result.user.emailVerifiedAt !== null,
        },
        onboarding_status: result.context.onboardingStatus,
        auth: {
          brand_id: result.context.brandId,
          workspace_id: result.context.workspaceId,
          role: result.context.role,
        },
        ...(result.invitePending ? { code: 'INVITE_PENDING' as const } : {}),
      });
    } catch (err) {
      if (err instanceof AuthError) {
        return reply.code(err.statusCode).send({
          request_id: requestId,
          error: { code: err.code, message: err.message },
        });
      }
      throw err;
    }
  });

  // ── POST /api/v1/bff/onboarding/provision — merged workspace+brand (D3) ────────
  // Provisions workspace + first brand transactionally (server-side slug, website→pixel
  // preserved). Idempotent: a Back→resubmit returns the existing org/brand (200), never
  // a duplicate. After this, the web calls set-org to re-mint the cookie with context.
  // CSRF enforced by the app-wide onRequest hook (session cookie present → mutation).
  fastify.post(
    '/api/v1/bff/onboarding/provision',
    { preHandler: [sessionPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const correlationId = (request.headers['x-correlation-id'] as string) ?? requestId;
      const auth = (request as AuthenticatedRequest).auth;

      if (!onboardingService) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Onboarding service not available.' },
        });
      }

      const parsed = ProvisionOnboardingRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(422).send({
          request_id: requestId,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Validation failed',
            fields: parsed.error.errors.map((e) => ({ field: e.path.join('.'), message: e.message })),
          },
        });
      }

      try {
        const result = await onboardingService.provisionWorkspaceAndBrand(
          {
            workspaceName: parsed.data.workspace_name,
            brandDisplayName: parsed.data.brand_display_name,
            domain: parsed.data.domain ?? null,
            currencyCode: parsed.data.currency_code,
            timezone: parsed.data.timezone,
            revenueDefinition: parsed.data.revenue_definition,
            ownerUserId: auth.userId,
          },
          correlationId,
        );
        // 201 for a fresh provision, 200 for the idempotent existing-member return.
        return reply.code(result.created ? 201 : 200).send({
          request_id: requestId,
          organization_id: result.organizationId,
          brand_id: result.brandId,
          onboarding_status: result.onboardingStatus,
          created: result.created,
        });
      } catch (err) {
        if (err instanceof OnboardingError) {
          return reply.code(err.statusCode).send({
            request_id: requestId,
            error: { code: err.code, message: err.message },
          });
        }
        throw err;
      }
    },
  );

  // ── POST /api/v1/bff/session/refresh — re-mint cookie with current brand/role ──
  // Called after onboarding (workspace + brand creation) so the SAME session picks
  // up the newly-resolved brand_id/role without forcing a re-login. Authenticated
  // via the session cookie (bridged to Bearer by the app-wide onRequest hook);
  // reuses the existing jti, so revocation state is preserved (NN-3).
  fastify.post(
    '/api/v1/bff/session/refresh',
    { preHandler: [sessionPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const correlationId = (request.headers['x-correlation-id'] as string) ?? requestId;
      const auth = (request as AuthenticatedRequest).auth;

      const result = await authService.refreshSession(auth.userId, auth.jti, correlationId);

      (reply as CookieReply).setCookie(COOKIE_NAME, result.accessToken, {
        httpOnly: true,
        secure: process.env['NODE_ENV'] === 'production',
        sameSite: 'strict',
        path: '/',
        maxAge: result.expiresIn,
      });

      // QA-07: auth sub-object uses snake_case (contract §6: brand_id, workspace_id).
      return reply.send({
        request_id: requestId,
        onboarding_status: result.context.onboardingStatus,
        auth: {
          brand_id: result.context.brandId,
          workspace_id: result.context.workspaceId,
          role: result.context.role,
        },
      });
    },
  );

  // ── DELETE /api/v1/bff/session — logout + clear cookie ────────────────────
  fastify.delete(
    '/api/v1/bff/session',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const correlationId = (request.headers['x-correlation-id'] as string) ?? requestId;
      const auth = (request as AuthenticatedRequest).auth;

      // AC-2: ?scope=all revokes all sessions for this user (e.g. "logout everywhere").
      const scopeAll = (request.query as { scope?: string }).scope === 'all';
      await authService.logout(auth.jti, auth.userId, correlationId, scopeAll);

      // Clear the session cookie.
      (reply as CookieReply).clearCookie(COOKIE_NAME, { path: '/' });
      (reply as CookieReply).clearCookie(CSRF_COOKIE_NAME, { path: '/' });

      return reply.send({ request_id: requestId, ok: true });
    },
  );

  // ── POST /api/v1/bff/session/set-org — switch active workspace in cookie ──────
  // AC-8 / B-7: After onboarding creates the first org, the front-end calls this
  // endpoint with the new organization_id (§6 contract field name). The service
  // verifies the user is a member of that org (SEC-AOF-H1 → 403 if not), then
  // re-resolves brand/role context and re-mints the cookie with onboarding_status.
  // CSRF IS enforced by the app-wide onRequest hook in main.ts (SEC-0009-M02).
  // Do NOT add this path to the CSRF-exempt list.
  fastify.post(
    '/api/v1/bff/session/set-org',
    { preHandler: [sessionPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const correlationId = (request.headers['x-correlation-id'] as string) ?? requestId;
      const auth = (request as AuthenticatedRequest).auth;
      // QA-02: contract §6 field name is organization_id (not workspace_id).
      const body = request.body as { organization_id?: string };

      if (!body?.organization_id) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'MISSING_ORGANIZATION_ID', message: 'organization_id is required.' },
        });
      }

      if (!pool) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available.' },
        });
      }

      // SEC-AOF-H1: Explicit membership check BEFORE refreshSession.
      // resolveActiveContext falls back to findActiveByUser when membership is missing,
      // which would silently return the user's own org instead of 403.
      // We must fail-closed here: non-member → 403 (architecture plan AC-8 §B-7).
      const memberClient = await pool.connect();
      try {
        const memberRepo = new MembershipRepository(memberClient);
        const membership = await memberRepo.findByUserAndOrg(
          auth.userId,
          body.organization_id,
          null,
          { correlationId, userId: auth.userId, workspaceId: body.organization_id },
        );
        if (!membership) {
          return reply.code(403).send({
            request_id: requestId,
            error: { code: 'FORBIDDEN', message: 'Not a member of the requested organization.' },
          });
        }
      } finally {
        memberClient.release();
      }

      // refreshSession re-resolves brand/role context for the verified org.
      const result = await authService.refreshSession(
        auth.userId,
        auth.jti,
        correlationId,
        body.organization_id,
      );

      (reply as CookieReply).setCookie(COOKIE_NAME, result.accessToken, {
        httpOnly: true,
        secure: process.env['NODE_ENV'] === 'production',
        sameSite: 'strict',
        path: '/',
        maxAge: result.expiresIn,
      });

      // QA-07: auth sub-object uses snake_case (contract §6: brand_id, workspace_id).
      return reply.send({
        request_id: requestId,
        onboarding_status: result.context.onboardingStatus,
        auth: {
          brand_id: result.context.brandId,
          workspace_id: result.context.workspaceId,
          role: result.context.role,
        },
      });
    },
  );

  // ── POST /api/v1/bff/session/set-brand — switch active brand in cookie ──────
  // AC-1 / feat-multi-brand: re-mints the session JWT with verified brand-level context.
  // SEC: session revocation DB check required — do NOT use JWT-only verification (MA-05).
  // CSRF enforced by the app-wide onRequest hook (not exempt — same as set-org).
  // workspace_id is sourced from auth.workspaceId (JWT) ONLY — never the body (MA-02).
  // TOCTOU note: remove+set-brand executing within the same millisecond leaves a sub-ms
  // window where a removed user re-mints before the revocation check catches up; acceptable
  // for M1 — noted for future brand-scoped session audit.
  fastify.post(
    '/api/v1/bff/session/set-brand',
    // SEC: session revocation DB check required — do NOT use JWT-only verification (MA-05)
    { preHandler: [sessionPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const correlationId = (request.headers['x-correlation-id'] as string) ?? requestId;
      const auth = (request as AuthenticatedRequest).auth;
      const body = request.body as { brand_id?: string };

      // SEC: workspaceId must come from JWT, not body — prevents cross-org membership spoofing (MA-02).
      if (!auth.workspaceId) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'MISSING_WORKSPACE', message: 'No workspace context in session. Call set-org first.' },
        });
      }

      if (!body?.brand_id) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'MISSING_BRAND_ID', message: 'brand_id is required.' },
        });
      }

      if (!pool) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available.' },
        });
      }

      try {
        // MA-01 CRITICAL: calls mintSessionToken directly via switchBrandContext — NEVER
        // refreshSession/resolveActiveContext (their findActiveByUser fallback substitutes
        // the wrong brand, causing a context-substitution defect).
        const result = await authService.switchBrandContext(
          auth.userId,
          auth.jti,
          auth.brandId,         // fromBrandId (outgoing context, audit only)
          auth.workspaceId,     // from JWT ONLY — never body (MA-02)
          body.brand_id,
          correlationId,
        );

        // Set the re-minted session cookie (copy of set-org cookie block, bff.routes.ts:335-341).
        (reply as CookieReply).setCookie(COOKIE_NAME, result.accessToken, {
          httpOnly: true,
          secure: process.env['NODE_ENV'] === 'production',
          sameSite: 'strict',
          path: '/',
          maxAge: result.expiresIn,
        });

        return reply.send({
          request_id: requestId,
          auth: {
            brand_id: result.context.brandId,
            workspace_id: result.context.workspaceId,
            role: result.context.role,
          },
        });
      } catch (err) {
        if (err instanceof AuthError) {
          return reply.code(err.statusCode).send({
            request_id: requestId,
            error: { code: err.code, message: err.message },
          });
        }
        throw err;
      }
    },
  );

  // ── POST /api/v1/bff/session/onboarding/advance — advance wizard step ────────
  // QA-01 / AC-5 §B-5: Steps 3 ("Skip For Now") and 4 ("Done") call this.
  // Body: { to: 'integration_selected' | 'complete' }
  // Forward-only guard: the SQL WHERE clause enforces onboarding_step < $newStep.
  // Returns the new onboarding_status so the frontend can route immediately.
  // CSRF enforced by the app-wide onRequest hook (session cookie present → mutation → checked).
  fastify.post(
    '/api/v1/bff/session/onboarding/advance',
    { preHandler: [sessionPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const correlationId = (request.headers['x-correlation-id'] as string) ?? requestId;
      const auth = (request as AuthenticatedRequest).auth;
      const body = request.body as { to?: string };

      const ALLOWED_TARGETS: Record<string, { status: string; step: number }> = {
        integration_selected: { status: 'integration_selected', step: 3 },
        complete: { status: 'complete', step: 4 },
      };

      const target = body?.to ? ALLOWED_TARGETS[body.to] : undefined;
      if (!target) {
        return reply.code(400).send({
          request_id: requestId,
          error: {
            code: 'INVALID_TARGET',
            message: `'to' must be one of: ${Object.keys(ALLOWED_TARGETS).join(', ')}.`,
          },
        });
      }

      if (!auth.workspaceId) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'MISSING_WORKSPACE', message: 'No workspace context in session. Call set-org first.' },
        });
      }

      if (!pool) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available.' },
        });
      }

      const ctx: QueryContext = { correlationId, userId: auth.userId, workspaceId: auth.workspaceId };
      const client = await pool.connect();
      try {
        const orgRepo = new OrganizationRepository(client);
        // M1: onboarding_status tracks first-brand onboarding only; multi-brand onboarding is post-M1.
        // Forward-only: advanceOnboardingStatus uses WHERE onboarding_step < $newStep — idempotent.
        await orgRepo.advanceOnboardingStatus(
          auth.workspaceId,
          target.status as import('../../workspace-access/internal/domain/organization/entities.js').OnboardingStatus,
          target.step,
          ctx,
        );

        // Read back the current status so we return the authoritative value.
        const org = await orgRepo.findById(auth.workspaceId, ctx);
        return reply.send({
          request_id: requestId,
          onboarding_status: org?.onboardingStatus ?? target.status,
        });
      } finally {
        client.release();
      }
    },
  );

  // ── GET /api/v1/bff/me — current user via cookie ──────────────────────────
  fastify.get(
    '/api/v1/bff/me',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const correlationId = (request.headers['x-correlation-id'] as string) ?? requestId;
      const auth = (request as AuthenticatedRequest).auth;

      const user = await authService.getCurrentUser(auth.userId, correlationId);
      if (!user) {
        return reply.code(401).send({
          request_id: requestId,
          error: { code: 'UNAUTHORIZED', message: 'User not found.' },
        });
      }

      // feat-onboarding-ux (Deliverable 5): surface onboarding_status so the web's
      // forward-only OnboardingGate can route on the authoritative server status.
      // resolveActiveContext does the membership→org read already used by login/set-org.
      const context = await authService.resolveActiveContext(
        auth.userId,
        correlationId,
        auth.workspaceId ?? undefined,
      );

      return reply.send({
        request_id: requestId,
        user: {
          id: user.id,
          email: user.email,
          email_verified: user.emailVerifiedAt !== null,
          status: user.status,
        },
        onboarding_status: context.onboardingStatus,
        auth: {
          brand_id: auth.brandId,
          workspace_id: auth.workspaceId,
          role: auth.role,
        },
      });
    },
  );

  // ── Protected BFF proxy routes ─────────────────────────────────────────────
  // These routes require bffProtectedPreHandler (NN-3 + CSRF + cookie).
  // They proxy to the internal service implementations.
  // Brand assertion: if X-Brand-Id is present, it must match auth.brandId (or null).

  fastify.addHook('preHandler', async (request: FastifyRequest) => {
    if (!request.routeOptions?.url?.startsWith('/api/v1/bff/')) return;
    // Already handled by per-route preHandlers above.
  });

  // ── Dashboard BFF endpoints (MED-BFF-DASH-01) ─────────────────────────────
  // All reads are Postgres-only (ZERO StarRocks/OLAP — ADR-002).
  // Honest empty: if no data exists yet, returns structured empty state — never 404.
  // All routes protected by bffProtectedPreHandler (validateSession + NN-3 + CSRF).

  /**
   * GET /v1/dashboard/brand-summary
   * Returns brand/org/membership counts for the current workspace.
   */
  fastify.get(
    '/api/v1/dashboard/brand-summary',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;

      if (!auth.workspaceId) {
        // No workspace context yet — honest empty
        return reply.send({
          request_id: requestId,
          data: {
            org_name: null,
            active_brand_id: null,
            brand_count: 0,
            member_count: 0,
            brands: [],
          },
        });
      }

      if (!pool) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' },
        });
      }

      // userId is REQUIRED: the brand list is gated by the brand_self_read RLS policy, whose
      // membership subquery filters `app_user_id = app.current_user_id`. Without the user GUC the
      // subquery matches nothing and the switcher shows ZERO brands (the org membership_self_read
      // path needs it too). Set all of workspace + user (+ brand for the member count) here.
      const ctx: QueryContext = {
        workspaceId: auth.workspaceId,
        userId: auth.userId,
        correlationId: requestId,
      };
      const client = await pool.connect();
      try {
        // brand-summary queries: org + brand list (all member brands for the switcher) + brand-scoped member count.
        const [orgResult, brandResult, memberResult] = await Promise.all([
          client.query<{ id: string; name: string }>(
            ctx,
            `SELECT id, name FROM organization WHERE id = $1`,
            [auth.workspaceId],
          ),
          // brand_self_read (0013) ensures brain_app sees only member brands in the active org.
          // brand list drives the switcher — all member brands within the workspace, newest first.
          client.query<{ id: string; display_name: string; domain: string | null; status: string }>(
            ctx,
            `SELECT id, display_name, domain, status FROM brand WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 20`,
            [auth.workspaceId],
          ),
          // MA-06/SD-2: member count is per-active-brand, not org-level.
          // Guard: if auth.brandId is null (no active brand), count returns 0 (honest empty).
          auth.brandId
            ? client.query<{ count: string }>(
                ctx,
                // COUNT DISTINCT users scoped to the ACTIVE brand.
                // A single owner holds two membership rows (org-level + brand-level),
                // so COUNT(*) double-counts them — DISTINCT eliminates duplicates.
                `SELECT COUNT(DISTINCT app_user_id)::text AS count FROM membership WHERE organization_id = $1 AND brand_id = $2`,
                [auth.workspaceId, auth.brandId],
              )
            : Promise.resolve({ rows: [{ count: '0' }] as { count: string }[] }),
        ]);

        const org = orgResult.rows[0];
        return reply.send({
          request_id: requestId,
          data: {
            org_name: org?.name ?? null,
            // MA-06: active_brand_id = auth.brandId so the client can identify the active brand
            // by ID (not array index). Frontend resolves: brands.find(b => b.id === active_brand_id).
            active_brand_id: auth.brandId ?? null,
            brand_count: brandResult.rows.length,
            member_count: parseInt(memberResult.rows[0]?.count ?? '0', 10),
            brands: brandResult.rows.map((b) => ({
              id: b.id,
              display_name: b.display_name,
              domain: b.domain,
              status: b.status,
            })),
          },
        });
      } finally {
        client.release();
      }
    },
  );

  /**
   * GET /v1/dashboard/connection-status
   * Returns connector_sync_status for the current brand.
   */
  fastify.get(
    '/api/v1/dashboard/connection-status',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;

      if (!auth.brandId) {
        return reply.send({
          request_id: requestId,
          data: {
            shopify: { connected: false, status: 'not_connected', syncState: null, lastSyncAt: null },
            razorpay: { connected: false, status: 'not_connected', syncState: null, lastSyncAt: null },
            meta: { coming_soon: true },
            google: { coming_soon: true },
          },
        });
      }

      if (!pool) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' },
        });
      }

      const ctx: QueryContext = { brandId: auth.brandId, correlationId: requestId };
      const client = await pool.connect();
      try {
        // Latest instance per provider (shopify + razorpay), each LEFT JOINed to its sync status.
        // Parallel reads — no sequential scan. RLS scopes brand_id via the QueryContext.
        const connRow = `SELECT ci.status, ci.shop_domain, ci.id AS connector_instance_id,
                  cs.state AS sync_state, cs.last_sync_at, cs.last_error
           FROM connector_instance ci
           LEFT JOIN connector_sync_status cs ON cs.connector_instance_id = ci.id AND cs.brand_id = ci.brand_id
           WHERE ci.brand_id = $1 AND ci.provider = $2
           ORDER BY ci.created_at DESC
           LIMIT 1`;
        type ConnRow = {
          status: string;
          shop_domain: string;
          connector_instance_id: string;
          sync_state: string | null;
          last_sync_at: Date | null;
          last_error: string | null;
        };
        const [shopifyResult, razorpayResult] = await Promise.all([
          client.query<ConnRow>(ctx, connRow, [auth.brandId, 'shopify']),
          client.query<ConnRow>(ctx, connRow, [auth.brandId, 'razorpay']),
        ]);

        // 'disconnected' instance rows persist for audit but present as not-connected.
        const mapConn = (row: ConnRow | undefined) =>
          row && row.status !== 'disconnected'
            ? {
                connected: row.status === 'connected',
                status: row.status,
                shop_domain: row.shop_domain || null,
                connector_instance_id: row.connector_instance_id,
                syncState: row.sync_state,
                lastSyncAt: row.last_sync_at?.toISOString() ?? null,
                lastError: row.last_error,
              }
            : { connected: false, status: 'not_connected', syncState: null, lastSyncAt: null };

        return reply.send({
          request_id: requestId,
          data: {
            shopify: mapConn(shopifyResult.rows[0]),
            razorpay: mapConn(razorpayResult.rows[0]),
            meta: { coming_soon: true },
            google: { coming_soon: true },
          },
        });
      } finally {
        client.release();
      }
    },
  );

  /**
   * GET /v1/dashboard/data-foundation-health — the readiness verdict (P1).
   * Aggregates the existing health signals (pixel installed, commerce connected + healthy, sync
   * started, events flowing & fresh, DQ trust tier) into ONE deterministic, fail-closed verdict +
   * a guided next step. This is the spine's gate: "everything depends on the data foundation."
   */
  fastify.get(
    '/api/v1/dashboard/data-foundation-health',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;
      if (!pool || !rawPool) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' },
        });
      }
      // No active brand → the foundation hasn't started; return the honest 'blocked' verdict.
      if (!auth.brandId) {
        const blocked = computeFoundationHealth({
          pixelInstalled: false,
          commerceConnected: false,
          commerceHealthy: false,
          initialSyncStarted: false,
          firstEventReceived: false,
          freshness: 'unknown',
          dqTier: 'untrusted',
        });
        const data: ContractFoundationHealth = {
          tier: blocked.tier,
          ready: blocked.ready,
          steps: blocked.steps,
          gaps: blocked.gaps,
          next_action: blocked.nextAction,
          headline: blocked.headline,
        };
        return reply.send({ request_id: requestId, data });
      }

      const signals = await gatherFoundationSignals(auth.brandId, requestId);
      const health = computeFoundationHealth(signals);

      const result: ContractFoundationHealth = {
        tier: health.tier,
        ready: health.ready,
        steps: health.steps,
        gaps: health.gaps,
        next_action: health.nextAction,
        headline: health.headline,
      };
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /v1/entitlements — readiness-driven progressive unlock (P2).
   * What the active brand can access given its data foundation: gated centers + connector-category
   * eligibility. Connector-GENERAL (keyed on category, not per-app). The nav + marketplace consume
   * this so gating is server-driven, never hardcoded in the client. No brand → everything locked.
   */
  fastify.get(
    '/api/v1/entitlements',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;
      if (!pool || !rawPool) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' },
        });
      }
      const signals: FoundationSignals = auth.brandId
        ? await gatherFoundationSignals(auth.brandId, requestId)
        : {
            pixelInstalled: false,
            commerceConnected: false,
            commerceHealthy: false,
            initialSyncStarted: false,
            firstEventReceived: false,
            freshness: 'unknown',
            dqTier: 'untrusted',
          };
      const tier = computeFoundationHealth(signals).tier;
      const ent = computeEntitlements({ tier, signals });
      const result: ContractEntitlements = {
        centers: ent.centers.map((e) => ({
          key: e.key,
          eligible: e.eligible,
          reason: e.reason,
          unlock_hint: e.unlockHint,
        })),
        connector_categories: ent.connectorCategories.map((e) => ({
          key: e.key,
          eligible: e.eligible,
          reason: e.reason,
          unlock_hint: e.unlockHint,
        })),
      };
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /v1/dashboard/data-status
   * Returns pixel_installation + pixel_status for the current brand.
   */
  fastify.get(
    '/api/v1/dashboard/data-status',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;

      if (!auth.brandId) {
        return reply.send({
          request_id: requestId,
          data: {
            pixel: { installed: false, state: 'not_installed', verifiedAt: null },
          },
        });
      }

      if (!pool) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' },
        });
      }

      const ctx: QueryContext = { brandId: auth.brandId, correlationId: requestId };
      const client = await pool.connect();
      try {
        const result = await client.query<{
          installation_id: string;
          install_token: string;
          target_host: string;
          installed_at: Date | null;
          state: string | null;
          verified_at: Date | null;
          last_error: string | null;
        }>(
          ctx,
          `SELECT pi.id AS installation_id, pi.install_token, pi.target_host, pi.installed_at,
                  ps.state, ps.verified_at, ps.last_error
           FROM pixel_installation pi
           LEFT JOIN pixel_status ps ON ps.pixel_installation_id = pi.id AND ps.brand_id = pi.brand_id
           WHERE pi.brand_id = $1
           ORDER BY pi.created_at DESC
           LIMIT 1`,
          [auth.brandId],
        );

        const row = result.rows[0];
        return reply.send({
          request_id: requestId,
          data: {
            pixel: row
              ? {
                  installed: row.installed_at !== null,
                  installation_id: row.installation_id,
                  install_token: row.install_token,
                  target_host: row.target_host,
                  installedAt: row.installed_at?.toISOString() ?? null,
                  state: row.state ?? 'waiting_for_data',
                  verifiedAt: row.verified_at?.toISOString() ?? null,
                  lastError: row.last_error,
                }
              : { installed: false, state: 'not_installed', verifiedAt: null },
          },
        });
      } finally {
        client.release();
      }
    },
  );

  /**
   * GET /v1/dashboard/onboarding-progress
   * Returns deterministic onboarding step completion from control-plane state.
   * Derived entirely from Postgres tables — no external API calls.
   *
   * Steps (M1):
   *   1. email_verified   — app_user.email_verified_at IS NOT NULL
   *   2. workspace_created — membership row exists (brand_id IS NULL)
   *   3. brand_created    — at least one brand row for the workspace
   *   4. shopify_connected — connector_instance.status = 'connected'
   *   5. pixel_installed  — pixel_installation.installed_at IS NOT NULL
   */
  fastify.get(
    '/api/v1/dashboard/onboarding-progress',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;

      if (!pool) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' },
        });
      }

      const ctx: QueryContext = {
        userId: auth.userId,
        workspaceId: auth.workspaceId ?? undefined,
        brandId: auth.brandId ?? undefined,
        correlationId: requestId,
      };
      const client = await pool.connect();
      try {
        // All queries run in parallel — no sequential scan.
        const [userResult, workspaceResult, brandResult, connectorResult, pixelResult] =
          await Promise.all([
            // Step 1: email verified
            client.query<{ email_verified_at: Date | null }>(
              ctx,
              `SELECT email_verified_at FROM app_user WHERE id = $1`,
              [auth.userId],
            ),
            // Step 2: workspace created (org-level membership)
            auth.workspaceId
              ? client.query<{ count: string }>(
                  ctx,
                  `SELECT COUNT(*)::text AS count FROM membership WHERE organization_id = $1 AND brand_id IS NULL AND app_user_id = $2`,
                  [auth.workspaceId, auth.userId],
                )
              : Promise.resolve({ rows: [{ count: '0' }] }),
            // Step 3: brand created
            auth.workspaceId
              ? client.query<{ count: string }>(
                  ctx,
                  `SELECT COUNT(*)::text AS count FROM brand WHERE organization_id = $1`,
                  [auth.workspaceId],
                )
              : Promise.resolve({ rows: [{ count: '0' }] }),
            // Step 4: Shopify connected
            auth.brandId
              ? client.query<{ count: string }>(
                  ctx,
                  `SELECT COUNT(*)::text AS count FROM connector_instance WHERE brand_id = $1 AND provider = 'shopify' AND status = 'connected'`,
                  [auth.brandId],
                )
              : Promise.resolve({ rows: [{ count: '0' }] }),
            // Step 5: pixel installed
            auth.brandId
              ? client.query<{ count: string }>(
                  ctx,
                  `SELECT COUNT(*)::text AS count FROM pixel_installation WHERE brand_id = $1 AND installed_at IS NOT NULL`,
                  [auth.brandId],
                )
              : Promise.resolve({ rows: [{ count: '0' }] }),
          ]);

        const steps = [
          {
            key: 'email_verified',
            label: 'Verify your email',
            completed: userResult.rows[0]?.email_verified_at !== null &&
              userResult.rows[0]?.email_verified_at !== undefined,
          },
          {
            key: 'workspace_created',
            label: 'Create your workspace',
            completed: parseInt(workspaceResult.rows[0]?.count ?? '0', 10) > 0,
          },
          {
            key: 'brand_created',
            label: 'Add your first brand',
            completed: parseInt(brandResult.rows[0]?.count ?? '0', 10) > 0,
          },
          {
            key: 'shopify_connected',
            label: 'Connect Shopify',
            completed: parseInt(connectorResult.rows[0]?.count ?? '0', 10) > 0,
          },
          {
            key: 'pixel_installed',
            label: 'Install the Brain pixel',
            completed: parseInt(pixelResult.rows[0]?.count ?? '0', 10) > 0,
          },
        ];

        const completedCount = steps.filter((s) => s.completed).length;

        return reply.send({
          request_id: requestId,
          data: {
            steps,
            completed_count: completedCount,
            total_count: steps.length,
            all_complete: completedCount === steps.length,
          },
        });
      } finally {
        client.release();
      }
    },
  );

  /**
   * GET /api/v1/dashboard/realized-revenue?as_of=<YYYY-MM-DD>
   *
   * Returns realized + provisional revenue for the active brand via the metric engine.
   *
   * ADR-002 SOLE READ PATH: this route calls getRevenueMetrics (analytics module)
   * which calls computeRealizedRevenue / computeProvisionalRevenue from @brain/metric-engine.
   * NO ad-hoc SUM(amount_minor) here — the ONLY SQL in this path is the EXISTS check
   * (inside the analytics use-case) and the named seam calls in the engine.
   *
   * Honest-empty-state (D-2): state='no_data' when no finalized rows exist.
   * NEVER returns a bare 0 without the state discriminant.
   *
   * as_of validation (D-9): schema-validated via Fastify JSON schema; invalid/garbage
   * returns 400 INVALID_DATE before the handler runs.
   *
   * Pool (D §3.1, F-SEC-02): uses rawPool (pg.Pool) — NOT the DbPool wrapper —
   * so withBrandTxn can set the GUC transaction-locally without double-GUC.
   *
   * Brand from session (D-1): brand_id comes from auth.brandId, NEVER from request body.
   */
  fastify.get(
    '/api/v1/dashboard/realized-revenue',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            as_of: {
              type: 'string',
              pattern: '^\\d{4}-\\d{2}-\\d{2}$',
            },
          },
          additionalProperties: false,
        },
      },
      // Fastify schema validation errors return 400; we override the reply to match
      // the INVALID_DATE contract (D-9).
      attachValidation: true,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();

      // D-9: as_of schema validation — Fastify sets validationError on the request
      // when attachValidation:true and the schema fails.
      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_DATE', message: 'as_of must be YYYY-MM-DD.' },
        });
      }

      const auth = (request as AuthenticatedRequest).auth;

      // Honest-empty: no active brand yet → no_data (matches BFF pattern at bff.routes.ts:569)
      if (!auth.brandId) {
        const today = new Date().toISOString().split('T')[0] as string;
        return reply.send({
          request_id: requestId,
          data: {
            state: 'no_data',
            as_of: today,
            realized: null,
            provisional: null,
          },
        });
      }

      // Pool guard: the dashboard snapshot now reads the lakehouse gold ledger (PHASE G follow-up),
      // so the Silver/Gold pool is required (billing still reads PG; this is the dashboard path).
      if (!srPool) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier not available' },
        });
      }

      // as_of: use provided value or default to today (server-side, never client-trusted — Open-Q1)
      const query = request.query as { as_of?: string };
      const asOfStr = query.as_of ?? (new Date().toISOString().split('T')[0] as string);
      const asOf = new Date(`${asOfStr}T00:00:00Z`);

      // Call the analytics use-case — the SOLE read path (ADR-002, D-3)
      const snapshot: ContractRevenueSnapshot = await getRevenueMetrics(auth.brandId, asOf, { srPool });

      return reply.send({
        request_id: requestId,
        data: snapshot,
      });
    },
  );

  // ── GET /api/v1/identity/customers — customer BROWSE (discover front-door) ────
  /**
   * GET /api/v1/identity/customers?lifecycle=&search=&limit=&offset=
   *
   * Paginated, filterable list of the active brand's customers (the front-door into Customer 360 /
   * merge / unmerge / erase, all of which require a brain_id you otherwise have no way to discover).
   *
   * PII discipline (I-S02): returns counts + lifecycle/consent only — NO raw PII, not even hashed
   * identifier values. `search` is hashed server-side with the per-brand salt (raw term never stored,
   * never logged, never reaches Postgres). Brand from session (D-1): scope is auth.brandId, never the
   * request. Reads via the identity module → @brain/db DbPool (RLS-enforced under brain_app).
   */
  fastify.get(
    '/api/v1/identity/customers',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            lifecycle: { type: 'string', enum: ['anonymous', 'active', 'merged', 'split', 'erased'] },
            search: { type: 'string', maxLength: 320 },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
            offset: { type: 'integer', minimum: 0 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;
      const q = request.query as { lifecycle?: string; search?: string; limit?: number; offset?: number };

      const limit = q.limit ?? 25;
      const offset = q.offset ?? 0;
      const empty: ContractCustomerList = {
        items: [],
        total: 0,
        limit,
        offset,
        searched: Boolean(q.search && q.search.trim().length > 0),
      };

      // Honest empty: no active brand → no scope to browse.
      if (!auth.brandId || !pool) {
        return reply.send({ request_id: requestId, data: empty });
      }

      const result: ContractCustomerList = await listCustomers(
        auth.brandId,
        { lifecycle: q.lifecycle ?? null, search: q.search ?? null, limit, offset },
        requestId,
        { pool },
      );
      return reply.send({ request_id: requestId, data: result });
    },
  );

  // ── GET /api/v1/identity/customer — Customer 360 read (P0-C, slice 1) ─────────
  /**
   * GET /api/v1/identity/customer?brain_id=<uuid>
   *
   * Returns the resolved customer profile (lifecycle + consent), its linked identifiers
   * (HASHED prefix only — never raw PII, I-S02), and merge history, for the active brand.
   *
   * Brand from session (D-1): brand_id comes from auth.brandId, NEVER from the request.
   * Reads via the identity module → @brain/db DbPool (RLS-enforced under brain_app).
   */
  fastify.get(
    '/api/v1/identity/customer',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            brain_id: {
              type: 'string',
              pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
            },
          },
          required: ['brain_id'],
          additionalProperties: false,
        },
        attachValidation: true,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();

      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_BRAIN_ID', message: 'brain_id must be a UUID.' },
        });
      }

      const auth = (request as AuthenticatedRequest).auth;
      const { brain_id } = request.query as { brain_id: string };

      // Honest empty: no active brand → not_found (no brand to scope the lookup to).
      if (!auth.brandId) {
        return reply.send({
          request_id: requestId,
          data: { state: 'not_found', brain_id },
        });
      }

      if (!pool) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' },
        });
      }

      const result: ContractCustomer360 = await getCustomer360(auth.brandId, brain_id, requestId, {
        pool,
      });

      return reply.send({ request_id: requestId, data: result });
    },
  );

  // ── GET /api/v1/identity/vault-coverage — PII vault coverage (P0-C, slice 2) ──
  /**
   * GET /api/v1/identity/vault-coverage
   *
   * Returns counts-only coverage of the encrypted contact_pii vault for the active brand
   * (resolved vs vaulted customers, email/phone counts). NEVER returns raw PII. The vault
   * read uses the elevated send_service path inside the identity vault service.
   */
  fastify.get(
    '/api/v1/identity/vault-coverage',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;

      const empty: ContractVaultCoverage = {
        resolved_customers: 0,
        vaulted_customers: 0,
        coverage_pct: 0,
        email_count: 0,
        phone_count: 0,
      };

      if (!auth.brandId || !vaultService) {
        return reply.send({ request_id: requestId, data: empty });
      }

      const coverage: ContractVaultCoverage = await vaultService.getCoverage(auth.brandId);
      return reply.send({ request_id: requestId, data: coverage });
    },
  );

  // ── POST /api/v1/identity/customer/erase — DPDP right-to-deletion (P0-C) ──────
  /**
   * POST /api/v1/identity/customer/erase  body: { brain_id: <uuid> }
   *
   * Erases ONE customer for the active brand: hard-deletes the contact_pii vault rows,
   * tombstones identity_link, marks the customer 'erased', audits the action. State-changing
   * → CSRF-enforced via bffProtectedPreHandler. Brand from session (D-1) — a brain_id from
   * another brand erases nothing (the SECURITY DEFINER fn is scoped to brand_id + brain_id).
   */
  fastify.post(
    '/api/v1/identity/customer/erase',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        body: {
          type: 'object',
          properties: {
            brain_id: {
              type: 'string',
              pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
            },
          },
          required: ['brain_id'],
          additionalProperties: false,
        },
        attachValidation: true,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();

      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_BRAIN_ID', message: 'brain_id must be a UUID.' },
        });
      }

      const auth = (request as AuthenticatedRequest).auth;
      const { brain_id } = request.body as { brain_id: string };

      if (!auth.brandId) {
        return reply.code(409).send({
          request_id: requestId,
          error: { code: 'NO_ACTIVE_BRAND', message: 'Select a brand first.' },
        });
      }
      if (!rawPool) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' },
        });
      }

      const result: ContractErasureResult = await eraseCustomer(auth.brandId, brain_id, rawPool);
      return reply.send({ request_id: requestId, data: result });
    },
  );

  // ── GET /api/v1/identity/merge-reviews — pending merge candidates (P0-C) ──────
  fastify.get(
    '/api/v1/identity/merge-reviews',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;
      const empty: ContractMergeReviewList = { reviews: [] };
      if (!auth.brandId || !pool) {
        return reply.send({ request_id: requestId, data: empty });
      }
      const data: ContractMergeReviewList = await listMergeReviews(auth.brandId, requestId, { pool });
      return reply.send({ request_id: requestId, data });
    },
  );

  // ── POST /api/v1/identity/merge-reviews/resolve — approve/reject a merge (P0-C) ─
  fastify.post(
    '/api/v1/identity/merge-reviews/resolve',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        body: {
          type: 'object',
          properties: {
            review_id: {
              type: 'string',
              pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
            },
            decision: { type: 'string', enum: ['merge', 'reject'] },
          },
          required: ['review_id', 'decision'],
          additionalProperties: false,
        },
        attachValidation: true,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_INPUT', message: 'review_id (uuid) + decision (merge|reject) required.' },
        });
      }
      const auth = (request as AuthenticatedRequest).auth;
      const { review_id, decision } = request.body as { review_id: string; decision: 'merge' | 'reject' };
      if (!auth.brandId || !rawPool) {
        return reply.code(409).send({
          request_id: requestId,
          error: { code: 'NO_ACTIVE_BRAND', message: 'Select a brand first.' },
        });
      }
      const result: ContractMergeResolveResult = await resolveMergeReview(auth.brandId, review_id, decision, rawPool);
      return reply.send({ request_id: requestId, data: result });
    },
  );

  // ── POST /api/v1/identity/customer/unmerge — split a merged customer (P0-C) ───
  fastify.post(
    '/api/v1/identity/customer/unmerge',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        body: {
          type: 'object',
          properties: {
            brain_id: {
              type: 'string',
              pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
            },
          },
          required: ['brain_id'],
          additionalProperties: false,
        },
        attachValidation: true,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_BRAIN_ID', message: 'brain_id must be a UUID.' },
        });
      }
      const auth = (request as AuthenticatedRequest).auth;
      const { brain_id } = request.body as { brain_id: string };
      if (!auth.brandId || !rawPool) {
        return reply.code(409).send({
          request_id: requestId,
          error: { code: 'NO_ACTIVE_BRAND', message: 'Select a brand first.' },
        });
      }
      const result: ContractUnmergeResult = await unmergeCustomer(auth.brandId, brain_id, rawPool);
      return reply.send({ request_id: requestId, data: result });
    },
  );

  // ── POST /api/v1/ask — Decision-Intelligence "Ask Brain" (Phase 8, D7) ────
  /**
   * POST /api/v1/ask  body: { question: string, as_of?: YYYY-MM-DD }
   *
   * THE HONEST AI SEAM. Resolves an NL question to a certified metric_binding (the model
   * SELECTS over the registry enum — it NEVER emits SQL and NEVER produces a number, I-S08 /
   * METRICS.md §5), computes the number over the metric-engine SOLE read path (I-ST01),
   * attaches the frozen confidence/tier (Phase 7), persists reproducible provenance (the
   * REDACTED question only — the raw question is NEVER persisted or logged, D4), and returns
   * the AskBrainResult DTO. Off-domain → an honest refusal (no fabricated number).
   *
   * This route issues NO SQL and makes NO model call directly — it calls askBrain (same
   * discipline as every other BFF route). Brand from session (D-1): auth.brandId, never body.
   * Money is bigint-minor string + currency (never float).
   */
  fastify.post(
    '/api/v1/ask',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        body: {
          type: 'object',
          required: ['question'],
          additionalProperties: false,
          properties: {
            question: { type: 'string', minLength: 1, maxLength: 2000 },
            as_of: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          },
        },
      },
      attachValidation: true,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();

      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_REQUEST', message: 'question is required (1–2000 chars); as_of must be YYYY-MM-DD.' },
        });
      }

      const auth = (request as AuthenticatedRequest).auth;

      // Honest-empty: no active brand yet → an honest refusal (no certified data to bind to).
      if (!auth.brandId) {
        return reply.send({
          request_id: requestId,
          data: { kind: 'refusal', reason: 'no certified metric answers this — connect data first' },
        });
      }

      if (!rawPool || !srPool) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' },
        });
      }

      const body = request.body as { question: string; as_of?: string };
      // as_of is server-bounded (never client-trusted for the value, but accepted for the frame).
      const asOf = body.as_of ?? (new Date().toISOString().split('T')[0] as string);

      // The raw question is passed IN-MEMORY only; askBrain persists/logs only the redacted form.
      const result: ContractAskBrainResult = await askBrain(auth.brandId, body.question, asOf, {
        engine: { pool: rawPool },
        srPool,
        resolver: askResolverClient,
      });

      return reply.send({ request_id: requestId, data: result });
    },
  );

  // ── Billing endpoints (P1 — realized-GMV meter) ───────────────────────────
  // Brain charges %-of-realized-GMV. The bill is computed from a SEALED, immutable
  // gmv_meter_snapshot per period (reproducible from the ledger), NOT recomputed live.
  // Brand from session (D-1): auth.brandId, NEVER from request body. Money is bigint-minor string.

  /**
   * GET /api/v1/billing/periods
   *
   * Returns the active brand's sealed billing periods (the bill basis) — honest discriminated
   * union: state:'no_data' when no period has ever been sealed, else state:'has_data'.
   * Reads gmv_meter_snapshot via the RLS-enforced pool (brain_app + brand GUC).
   */
  fastify.get(
    '/api/v1/billing/periods',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;

      // Honest-empty: no active brand → nothing to meter yet.
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data' } });
      }
      if (!pool) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' },
        });
      }

      const result: ContractBillingPeriods = await getBillingPeriods(auth.brandId, requestId, {
        pool,
      });
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * POST /api/v1/billing/periods/seal  body: { period: 'YYYY-MM' }
   *
   * Meters the active brand's realized GMV for the period (via realized_gmv_as_of — the SOLE
   * as-of path, D-3) and SEALS it into the immutable gmv_meter_snapshot. Idempotent: re-sealing
   * a sealed period is a no-op (`sealed:false`) and the original figure stands — a sealed bill
   * basis can never silently change (0040 append-only-by-GRANT). Brand from session (D-1).
   */
  fastify.post(
    '/api/v1/billing/periods/seal',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        body: {
          type: 'object',
          required: ['period'],
          additionalProperties: false,
          properties: { period: { type: 'string', pattern: '^\\d{4}-\\d{2}$' } },
        },
        attachValidation: true,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();

      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_PERIOD', message: "period must be 'YYYY-MM'." },
        });
      }

      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.code(409).send({
          request_id: requestId,
          error: { code: 'NO_ACTIVE_BRAND', message: 'Select a brand before metering billing.' },
        });
      }
      if (!pool) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' },
        });
      }

      const { period } = request.body as { period: string };
      const result: ContractSealPeriodResult = await sealBillingPeriod(
        auth.brandId,
        period,
        requestId,
        { pool },
      );
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/billing/bill?period=YYYY-MM
   *
   * The inspectable bill for a sealed period: fee = sealed realized-GMV basis × rate, itemized
   * down to the per-event_type composition that reconciles to the basis (drift surfaced honestly).
   * state:'not_sealed' when the period has no seal yet. Brand from session (D-1).
   */
  fastify.get(
    '/api/v1/billing/bill',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          required: ['period'],
          additionalProperties: false,
          properties: { period: { type: 'string', pattern: '^\\d{4}-\\d{2}$' } },
        },
        attachValidation: true,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();

      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_PERIOD', message: "period must be 'YYYY-MM'." },
        });
      }

      const auth = (request as AuthenticatedRequest).auth;
      const { period } = request.query as { period: string };

      // Honest: no active brand → nothing sealed to bill.
      if (!auth.brandId) {
        return reply.send({
          request_id: requestId,
          data: { state: 'not_sealed', billing_period: period },
        });
      }
      if (!pool) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' },
        });
      }

      const result: ContractInspectableBill = await getInspectableBill(
        auth.brandId,
        period,
        requestId,
        { pool },
      );
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/billing/invoice?period=YYYY-MM
   *
   * The issued GST invoice for a period (immutable): number, GST breakdown, line items.
   * state:'not_issued' when the period has no invoice yet. Brand from session (D-1).
   */
  fastify.get(
    '/api/v1/billing/invoice',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          required: ['period'],
          additionalProperties: false,
          properties: { period: { type: 'string', pattern: '^\\d{4}-\\d{2}$' } },
        },
        attachValidation: true,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();

      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_PERIOD', message: "period must be 'YYYY-MM'." },
        });
      }

      const auth = (request as AuthenticatedRequest).auth;
      const { period } = request.query as { period: string };

      if (!auth.brandId) {
        return reply.send({
          request_id: requestId,
          data: { state: 'not_issued', billing_period: period },
        });
      }
      if (!pool) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' },
        });
      }

      const result: ContractInvoice = await getInvoice(auth.brandId, period, requestId, { pool });
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * POST /api/v1/billing/invoice/issue  body: { period: 'YYYY-MM' }
   *
   * Issues the GST invoice for a sealed period — allocates a gapless invoice_number and writes
   * the immutable invoice + line + tax_ledger atomically. Idempotent: issued:false when an
   * invoice already exists (no number consumed). Brand from session (D-1).
   */
  fastify.post(
    '/api/v1/billing/invoice/issue',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        body: {
          type: 'object',
          required: ['period'],
          additionalProperties: false,
          properties: { period: { type: 'string', pattern: '^\\d{4}-\\d{2}$' } },
        },
        attachValidation: true,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();

      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_PERIOD', message: "period must be 'YYYY-MM'." },
        });
      }

      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.code(409).send({
          request_id: requestId,
          error: { code: 'NO_ACTIVE_BRAND', message: 'Select a brand before issuing an invoice.' },
        });
      }
      if (!pool) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' },
        });
      }

      const { period } = request.body as { period: string };
      const result: ContractIssueInvoiceResult = await issueInvoice(
        auth.brandId,
        period,
        requestId,
        { pool },
      );
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * POST /api/v1/billing/invoice/credit-note  body: { period, reason, taxable_minor? }
   *
   * Issues an immutable credit note against the period's issued invoice — gapless-numbered, with
   * reversing GST. Full reversal by default, or a partial taxable amount. Capped at the invoice
   * total (rejected when over-credited). Brand from session (D-1).
   */
  fastify.post(
    '/api/v1/billing/invoice/credit-note',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        body: {
          type: 'object',
          required: ['period', 'reason'],
          additionalProperties: false,
          properties: {
            period: { type: 'string', pattern: '^\\d{4}-\\d{2}$' },
            reason: { type: 'string', minLength: 1, maxLength: 500 },
            taxable_minor: { type: 'string', pattern: '^\\d+$' },
          },
        },
        attachValidation: true,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();

      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_INPUT', message: "period must be 'YYYY-MM' and reason is required." },
        });
      }

      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.code(409).send({
          request_id: requestId,
          error: { code: 'NO_ACTIVE_BRAND', message: 'Select a brand before issuing a credit note.' },
        });
      }
      if (!pool) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' },
        });
      }

      const { period, reason, taxable_minor } = request.body as {
        period: string;
        reason: string;
        taxable_minor?: string;
      };
      const result: ContractIssueCreditNoteResult = await issueCreditNote(
        auth.brandId,
        period,
        reason,
        requestId,
        { pool },
        taxable_minor != null ? { taxableMinor: BigInt(taxable_minor) } : undefined,
      );
      return reply.send({ request_id: requestId, data: result });
    },
  );

  // ── Recommendation endpoints (P1 — deterministic decision engine, doc 09) ──
  // Recommend-only: detectors emit ranked risk/opportunity actions with confidence + evidence,
  // recorded in the append-only decision_log. Brand from session (D-1), never the request.

  /**
   * GET /api/v1/recommendations — the active brand's OPEN recommendations (the Morning Brief).
   * Honest union: state:'no_data' when none, else state:'has_data' ranked by priority.
   */
  fastify.get(
    '/api/v1/recommendations',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;

      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data' } });
      }
      if (!pool) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' },
        });
      }

      // "Confidence before decisions" (P0): resolve the brand's CURRENT trust gate and pass it so
      // getRecommendations caps each rec's surfaced confidence + holds high-risk recs below Trusted.
      // Fail-closed to 'untrusted' when the engine pool is unavailable (no trust proof → hold).
      const trust = rawPool
        ? await getMetricTrust(auth.brandId, { pool: rawPool })
        : { tier: 'untrusted' as const, gate: { blocksHighRiskRecommendation: true } };
      const result: ContractRecommendations = await getRecommendations(auth.brandId, requestId, {
        pool,
        gate: {
          tier: trust.tier,
          blocksHighRiskRecommendation: trust.gate.blocksHighRiskRecommendation,
        },
      });
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * POST /api/v1/recommendations/refresh — run the detectors for the active brand, reconciling
   * the open set (raise/refresh/expire) and appending to the decision_log. Returns the counts.
   */
  fastify.post(
    '/api/v1/recommendations/refresh',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;

      if (!auth.brandId) {
        return reply.code(409).send({
          request_id: requestId,
          error: { code: 'NO_ACTIVE_BRAND', message: 'Select a brand before running detectors.' },
        });
      }
      if (!pool) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' },
        });
      }

      const result: ContractGenerateRecommendationsResult = await generateRecommendations(
        auth.brandId,
        requestId,
        { pool },
      );
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * POST /api/v1/recommendations/:id/action — record a human action on a recommendation (M7).
   *
   * The human decision-feedback loop: served / accepted / dismissed / snoozed / reopened, appended
   * to the immutable action ledger. 'dismissed'/'reopened' also move the rec's lifecycle status.
   * actor = the authenticated user (auth.userId). Brand from session (D-1), never the request.
   */
  fastify.post(
    '/api/v1/recommendations/:id/action',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;

      if (!auth.brandId) {
        return reply.code(409).send({
          request_id: requestId,
          error: { code: 'NO_ACTIVE_BRAND', message: 'Select a brand before acting on a recommendation.' },
        });
      }
      if (!pool) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' },
        });
      }

      const { id: recommendationId } = request.params as { id: string };
      const body = (request.body ?? {}) as { action?: string; reason?: string };

      if (!isRecommendationAction(body.action)) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_ACTION', message: 'Unknown or missing recommendation action.' },
        });
      }

      try {
        const result: ContractRecommendationAction = await recordRecommendationAction(
          {
            brandId: auth.brandId,
            recommendationId,
            action: body.action,
            actor: auth.userId,
            reason: body.reason ?? null,
          },
          requestId,
          { pool },
        );
        return reply.send({ request_id: requestId, data: result });
      } catch (err) {
        if (err instanceof RecommendationNotFoundError) {
          return reply.code(404).send({
            request_id: requestId,
            error: { code: 'RECOMMENDATION_NOT_FOUND', message: 'Recommendation not found.' },
          });
        }
        if (err instanceof InvalidRecommendationActionError) {
          return reply.code(400).send({
            request_id: requestId,
            error: { code: 'INVALID_ACTION', message: 'Unknown recommendation action.' },
          });
        }
        throw err;
      }
    },
  );

  /**
   * GET /api/v1/ml/models — the active brand's model registry (DB-AUDIT C5 ML platform).
   *
   * Lists ml.model_registry rows (RLS-scoped, ordered name then newest-first). Brand from session (D-1).
   */
  fastify.get(
    '/api/v1/ml/models',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.code(409).send({
          request_id: requestId,
          error: { code: 'NO_ACTIVE_BRAND', message: 'Select a brand to view its models.' },
        });
      }
      if (!pool) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' },
        });
      }
      const models = await listModels(auth.brandId, requestId, { pool });
      const result: ContractModelList = { models: models as ContractModel[] };
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * POST /api/v1/ml/models/:id/promote — gated stage transition (DB-AUDIT C5 ML platform).
   *
   * Promoting to 'production' archives the prior production model of the same (brand,name) in ONE txn
   * (the partial-unique invariant). Needs the raw pg pool for the explicit atomic transaction. Brand
   * from session (D-1), never the request.
   */
  fastify.post(
    '/api/v1/ml/models/:id/promote',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.code(409).send({
          request_id: requestId,
          error: { code: 'NO_ACTIVE_BRAND', message: 'Select a brand before promoting a model.' },
        });
      }
      if (!rawPool) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' },
        });
      }
      const { id: modelId } = request.params as { id: string };
      const body = (request.body ?? {}) as { stage?: string };
      if (!isModelStage(body.stage)) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_STAGE', message: 'Unknown or missing model stage.' },
        });
      }
      try {
        const model = await promoteModel(auth.brandId, { modelId, toStage: body.stage }, requestId, {
          rawPool,
        });
        const result: ContractModel = model as ContractModel;
        return reply.send({ request_id: requestId, data: result });
      } catch (err) {
        if (err instanceof ModelNotFoundError) {
          return reply.code(404).send({
            request_id: requestId,
            error: { code: 'MODEL_NOT_FOUND', message: 'Model not found.' },
          });
        }
        if (err instanceof InvalidModelStageError) {
          return reply.code(400).send({
            request_id: requestId,
            error: { code: 'INVALID_STAGE', message: 'Unknown model stage.' },
          });
        }
        throw err;
      }
    },
  );

  /**
   * GET /api/v1/ml/customer-score?brain_id=… — serve a customer's RFM/churn score (DB-AUDIT C5).
   *
   * Reads the deterministic Gold score (metric-engine seam — needs srPool), resolves the production
   * model, logs an append-only ml.prediction_log row, returns {model, score}. Honest no_data when the
   * customer has no Gold score row. Brand from session (D-1); brain_id is a query param.
   */
  fastify.get(
    '/api/v1/ml/customer-score',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.code(409).send({
          request_id: requestId,
          error: { code: 'NO_ACTIVE_BRAND', message: 'Select a brand to serve a score.' },
        });
      }
      const brainId = (request.query as { brain_id?: string })?.brain_id;
      if (!brainId) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'MISSING_BRAIN_ID', message: 'brain_id query parameter is required.' },
        });
      }
      if (!pool || !srPool) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (StarRocks) not available' },
        });
      }
      const result: ContractCustomerScoreResult = await serveCustomerScore(
        auth.brandId,
        brainId,
        requestId,
        { pool, srPool },
      );
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * POST /api/v1/attribution/reconcile — drive the attribution write pipeline (Phase 5).
   *
   * Idempotently populates attribution_credit_ledger from the realized ledger + Silver touches
   * (credit on finalized orders, clawback on reversals). A system/batch trigger; the attribution
   * analytics reads flip not_computed→has_data once a brand is reconciled. Brand from session (D-1).
   */
  fastify.post(
    '/api/v1/attribution/reconcile',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;

      if (!auth.brandId) {
        return reply.code(409).send({
          request_id: requestId,
          error: { code: 'NO_ACTIVE_BRAND', message: 'Select a brand before reconciling attribution.' },
        });
      }
      if (!rawPool || !srPool) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Ledger or Silver tier not available' },
        });
      }

      const result: ContractAttributionReconcileResult = await reconcileAttribution(
        auth.brandId,
        requestId,
        { pool: rawPool, srPool },
      );
      return reply.send({ request_id: requestId, data: result });
    },
  );

  // ── Analytics endpoints (Phase 1) ─────────────────────────────────────────
  // ADR-002 sole-read-path: all routes call analytics query wrappers which call the metric engine.
  // Brand from session (D-1): auth.brandId, NEVER from request body.
  // Honest-empty: state:'no_data' when brand has no ledger rows.

  /**
   * GET /api/v1/analytics/revenue-timeseries?from=YYYY-MM-DD&to=YYYY-MM-DD&grain=day|week
   * Returns per-bucket realized + provisional revenue for charting.
   */
  fastify.get(
    '/api/v1/analytics/revenue-timeseries',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            to:   { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            grain: { type: 'string', enum: ['day', 'week'] },
          },
          additionalProperties: false,
        },
      },
      attachValidation: true,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_PARAMS', message: 'from and to must be YYYY-MM-DD; grain must be day or week.' },
        });
      }

      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data', from: null, to: null, grain: 'day', buckets: [] } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (StarRocks) not available' } });
      }

      const query = request.query as { from?: string; to?: string; grain?: string };
      const today = new Date().toISOString().split('T')[0] as string;
      const toStr = query.to ?? today;
      // Default: last 90 days
      const defaultFrom = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string;
      const fromStr = query.from ?? defaultFrom;
      const grain: TimeGrain = (query.grain === 'week' ? 'week' : 'day') as TimeGrain;

      // Epic 1: revenue timeseries now reads the lakehouse (gold_revenue_ledger), not the PG ledger.
      const result = await getRevenueTimeseries(
        auth.brandId,
        { fromDate: new Date(`${fromStr}T00:00:00Z`), toDate: new Date(`${toStr}T00:00:00Z`), grain },
        { srPool },
      );

      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/kpi-summary?as_of=YYYY-MM-DD
   * Returns brand KPI snapshot: realized, provisional, orders, AOV, RTO rate.
   */
  fastify.get(
    '/api/v1/analytics/kpi-summary',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            as_of: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          },
          additionalProperties: false,
        },
      },
      attachValidation: true,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_DATE', message: 'as_of must be YYYY-MM-DD.' },
        });
      }

      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        const today = new Date().toISOString().split('T')[0] as string;
        return reply.send({ request_id: requestId, data: { state: 'no_data', as_of: today } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (StarRocks) not available' } });
      }

      const query = request.query as { as_of?: string };
      const asOfStr = query.as_of ?? (new Date().toISOString().split('T')[0] as string);
      const asOf = new Date(`${asOfStr}T00:00:00Z`);

      // Epic 1: KPI summary now reads the lakehouse (gold_revenue_ledger), not the PG ledger.
      const result: ContractKpiSummary = await getKpiSummary(auth.brandId, asOf, { srPool });

      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/executive-metrics?from=&to=
   * H9 — the executive HEADLINE tiles (AOV, LTV, repeat_rate, CAC, ROAS) served from the Gold marts
   * THROUGH the metric registry (gold_executive_metrics + gold_customer_360 + gold_cac + blended ROAS).
   * Honest no_data when the brand has no Gold rows; ratios are null (never 0/∞) when the denominator is 0.
   */
  fastify.get(
    '/api/v1/analytics/executive-metrics',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          },
          additionalProperties: false,
        },
      },
      attachValidation: true,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({ request_id: requestId, error: { code: 'INVALID_PARAMS', message: 'from and to must be YYYY-MM-DD.' } });
      }
      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data' } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (StarRocks) not available' } });
      }
      const query = request.query as { from?: string; to?: string };
      const today = new Date().toISOString().split('T')[0] as string;
      const toStr = query.to ?? today;
      const fromStr = query.from ?? (new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string);

      const result = await getExecutiveMetrics(
        auth.brandId,
        { fromDate: new Date(`${fromStr}T00:00:00Z`), toDate: new Date(`${toStr}T00:00:00Z`) },
        { srPool },
      );
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/cohort-retention
   * H9/H11 — acquisition-cohort curve (size, lifetime orders/value, orders-per-customer) over the
   * order spine, from gold_cohorts via the metric registry. Honest no_data on zero cohorts.
   */
  fastify.get(
    '/api/v1/analytics/cohort-retention',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data' } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (StarRocks) not available' } });
      }
      const result = await getCohortRetention(auth.brandId, { srPool });
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/insights/briefing
   * Insight + Opportunity Engine + AI Copilot daily briefing — deterministic insights (revenue swing,
   * RTO leakage, churn LTV-at-risk, VIP concentration, CAC trend) over the Gold marts via the
   * metric-engine. Numbers come from the marts, never from a model. Honest no_data on zero realized rows.
   */
  fastify.get(
    '/api/v1/insights/briefing',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data' } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (StarRocks) not available' } });
      }
      const result = await getInsightsBriefing(auth.brandId, { srPool });
      // Converge insights into the audited decision loop: persist each as a recommendation (idempotent
      // read-through) so Accept/Dismiss/Snooze write to the recommendation_action ledger and outcomes
      // are measurable (RGUD). Merge the recommendation_id/status back onto each insight for the UI.
      if (result.state === 'has_data' && pool) {
        try {
          const materialized = await materializeInsightsAsRecommendations(
            auth.brandId,
            result.insights,
            requestId,
            { pool },
          );
          const byId = new Map(materialized.map((m) => [m.insightId, m]));
          result.insights = result.insights.map((i) => {
            const m = byId.get(i.id);
            return { ...i, recommendation_id: m?.recommendationId ?? null, status: m?.status ?? null };
          });
        } catch (err) {
          // Non-fatal: the briefing still renders read-only if the recommendation bridge fails.
          request.log.error({ err }, '[insights] materialize-as-recommendations failed; serving read-only');
        }
      }
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/recognition-breakdown?as_of=YYYY-MM-DD
   * Returns recognition state distribution: provisional/settling/finalized counts + amounts.
   */
  fastify.get(
    '/api/v1/analytics/recognition-breakdown',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            as_of: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          },
          additionalProperties: false,
        },
      },
      attachValidation: true,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_DATE', message: 'as_of must be YYYY-MM-DD.' },
        });
      }

      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        const today = new Date().toISOString().split('T')[0] as string;
        return reply.send({ request_id: requestId, data: { state: 'no_data', as_of: today } });
      }
      if (!rawPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' } });
      }

      const query = request.query as { as_of?: string };
      const asOfStr = query.as_of ?? (new Date().toISOString().split('T')[0] as string);
      const asOf = new Date(`${asOfStr}T00:00:00Z`);

      const result = await getRecognitionBreakdown(auth.brandId, asOf, { pool: rawPool });

      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/recent-activity?limit=20
   * Returns the latest N ledger rows for the brand (bounded read, not a metric — D-2 allowed).
   */
  fastify.get(
    '/api/v1/analytics/recent-activity',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'string', pattern: '^\\d+$' },
          },
          additionalProperties: false,
        },
      },
      attachValidation: true,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();

      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { rows: [] } });
      }
      if (!rawPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' } });
      }

      const query = request.query as { limit?: string };
      const limit = query.limit ? Math.min(parseInt(query.limit, 10), 50) : 20;

      const result = await getRecentActivity(auth.brandId, limit, { pool: rawPool });

      return reply.send({ request_id: requestId, data: result });
    },
  );

  // ── Analytics endpoints (Phase 2) ─────────────────────────────────────────
  // ADR-002 sole-read-path: orders routes call analytics wrappers → metric engine.
  // Brand from session (D-1): auth.brandId, NEVER from request body.
  // Honest-empty: state:'no_data' when brand has no ledger / bronze rows.

  /**
   * GET /api/v1/analytics/orders-timeseries?from=YYYY-MM-DD&to=YYYY-MM-DD&grain=day|week
   * Returns per-bucket order count + RTO count + realized revenue for charting.
   */
  fastify.get(
    '/api/v1/analytics/orders-timeseries',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            to:   { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            grain: { type: 'string', enum: ['day', 'week'] },
          },
          additionalProperties: false,
        },
      },
      attachValidation: true,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_PARAMS', message: 'from and to must be YYYY-MM-DD; grain must be day or week.' },
        });
      }

      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data', from: null, to: null, grain: 'day', buckets: [] } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (StarRocks) not available' } });
      }

      const query = request.query as { from?: string; to?: string; grain?: string };
      const today = new Date().toISOString().split('T')[0] as string;
      const toStr = query.to ?? today;
      // Default: last 90 days
      const defaultFrom = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string;
      const fromStr = query.from ?? defaultFrom;
      const grain: TimeGrain = (query.grain === 'week' ? 'week' : 'day') as TimeGrain;

      // Epic 1: orders timeseries now reads the lakehouse (gold_revenue_ledger), not the PG ledger.
      const result = await getOrdersTimeseries(
        auth.brandId,
        { fromDate: new Date(`${fromStr}T00:00:00Z`), toDate: new Date(`${toStr}T00:00:00Z`), grain },
        { srPool },
      );

      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/order-stats?as_of=YYYY-MM-DD
   * Returns per-currency order stats: order count, AOV, RTO rate.
   */
  fastify.get(
    '/api/v1/analytics/order-stats',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            as_of: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          },
          additionalProperties: false,
        },
      },
      attachValidation: true,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_DATE', message: 'as_of must be YYYY-MM-DD.' },
        });
      }

      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        const today = new Date().toISOString().split('T')[0] as string;
        return reply.send({ request_id: requestId, data: { state: 'no_data', as_of: today } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (StarRocks) not available' } });
      }

      const query = request.query as { as_of?: string };
      const asOfStr = query.as_of ?? (new Date().toISOString().split('T')[0] as string);
      const asOf = new Date(`${asOfStr}T00:00:00Z`);

      // Epic 1: order stats now read the lakehouse (gold_revenue_ledger), not the PG ledger.
      const result = await getOrderStats(auth.brandId, asOf, { srPool });

      return reply.send({ request_id: requestId, data: result });
    },
  );

  // ── Ad-connectors (Slice 1 Track 3) — spend + blended ROAS ────────────────────
  // ADR-002 sole-read-path: routes call analytics wrappers → metric engine (ad_spend_as_of
  // / realized_gmv_as_of seams). Brand from session (D-1), NEVER the body. Honest no_data.

  /**
   * GET /api/v1/analytics/ad-spend-timeseries?from=YYYY-MM-DD&to=YYYY-MM-DD&grain=day|week&platform=meta|google_ads
   * Returns per-bucket ad spend grouped by (platform, currency_code).
   */
  fastify.get(
    '/api/v1/analytics/ad-spend-timeseries',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            to:   { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            grain: { type: 'string', enum: ['day', 'week'] },
            platform: { type: 'string', enum: ['meta', 'google_ads'] },
          },
          additionalProperties: false,
        },
      },
      attachValidation: true,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_PARAMS', message: 'from/to must be YYYY-MM-DD; grain day|week; platform meta|google_ads.' },
        });
      }

      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data', from: null, to: null, grain: 'day', platform: null } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (StarRocks) not available' } });
      }

      const query = request.query as { from?: string; to?: string; grain?: string; platform?: string };
      const today = new Date().toISOString().split('T')[0] as string;
      const toStr = query.to ?? today;
      // Default window: last 35 days (covers the Google trailing-restatement window; ADR-AD-3).
      const defaultFrom = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string;
      const fromStr = query.from ?? defaultFrom;
      const grain: TimeGrain = (query.grain === 'week' ? 'week' : 'day') as TimeGrain;
      const platform = (query.platform === 'meta' || query.platform === 'google_ads')
        ? (query.platform as AdPlatform)
        : undefined;

      const result = await getAdSpendTimeseries(
        auth.brandId,
        { fromDate: new Date(`${fromStr}T00:00:00Z`), toDate: new Date(`${toStr}T00:00:00Z`), grain, platform },
        { srPool },
      );

      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/blended-roas?from=YYYY-MM-DD&to=YYYY-MM-DD
   * Returns per-currency blended ROAS (realized ÷ spend), same-currency only,
   * honest (roas_ratio=null where spend=0).
   */
  fastify.get(
    '/api/v1/analytics/blended-roas',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            to:   { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          },
          additionalProperties: false,
        },
      },
      attachValidation: true,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_PARAMS', message: 'from and to must be YYYY-MM-DD.' },
        });
      }

      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        const today = new Date().toISOString().split('T')[0] as string;
        return reply.send({ request_id: requestId, data: { state: 'no_data', from: today, to: today } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (StarRocks) not available' } });
      }

      const query = request.query as { from?: string; to?: string };
      const today = new Date().toISOString().split('T')[0] as string;
      const toStr = query.to ?? today;
      const defaultFrom = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string;
      const fromStr = query.from ?? defaultFrom;

      const result = await getBlendedRoas(
        auth.brandId,
        { fromDate: new Date(`${fromStr}T00:00:00Z`), toDate: new Date(`${toStr}T00:00:00Z`) },
        { srPool },
      );

      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/data-health
   * Returns ingestion + connector-sync health (bounded read — D-2 allowed).
   */
  fastify.get(
    '/api/v1/analytics/data-health',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();

      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data' } });
      }
      if (!rawPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' } });
      }

      const result = await getDataHealth(auth.brandId, { pool: rawPool, srPool });

      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/data-quality/summary  (Phase 7 — Data Quality surface)
   *
   * Returns the brand's Data Quality summary: per-category × per-target latest grade,
   * freshness-SLA status, dq_grade coverage, cost/effective confidence, and the gate
   * decision (trust tier / billing-cap / MMM inclusion / block-high-risk). All grades are
   * computed metric OUTPUTS on the sole metric-engine path (I-ST01) — the UI reads ONLY
   * this route, never dq_check_result.
   *
   * Brand from session (D-1): auth.brandId, NEVER request body.
   * Honest no_data (D-2): state='no_data' when the brand has no graded rows (or 0035 not
   *   yet migrated — fail-closed in the query).
   * RLS / F-SEC-02: the query reads inside withBrandTxn (GUC set per-transaction).
   */
  fastify.get(
    '/api/v1/data-quality/summary',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();

      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data' } });
      }
      if (!rawPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' } });
      }

      const result: ContractDataQualitySummary = await getDataQualitySummary(auth.brandId, { pool: rawPool });

      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/settlements?as_of=YYYY-MM-DD  (Razorpay Track C)
   *
   * Returns the brand's settlement (net-of-fees) summary computed from the
   * realized_revenue_ledger settlement event_types (migration 0027):
   *   { state, gross_minor, net_minor, fees: [{ type, amount_minor }], currency_code }
   *
   * ADR-002 SOLE READ PATH: calls getSettlementSummary → computeSettlementSummary
   * (metric engine). NO ad-hoc SUM(amount_minor) in this route or the analytics module.
   *
   * Brand from session (D-1): auth.brandId, NEVER request body.
   * Honest no_data (D-2): state='no_data' when the brand has no settlement rows.
   * RLS / F-SEC-02: the engine reads inside withBrandTxn (GUC set per-transaction).
   * Pool: rawPool (pg.Pool), not the DbPool wrapper (no double-GUC).
   */
  fastify.get(
    '/api/v1/analytics/settlements',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            as_of: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          },
          additionalProperties: false,
        },
      },
      attachValidation: true,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_DATE', message: 'as_of must be YYYY-MM-DD.' },
        });
      }

      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        const today = new Date().toISOString().split('T')[0] as string;
        return reply.send({ request_id: requestId, data: { state: 'no_data', as_of: today } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (StarRocks) not available' } });
      }

      const query = request.query as { as_of?: string };
      const asOfStr = query.as_of ?? (new Date().toISOString().split('T')[0] as string);
      const asOf = new Date(`${asOfStr}T00:00:00Z`);

      const result = await getSettlementSummary(auth.brandId, asOf, { srPool });

      return reply.send({ request_id: requestId, data: result });
    },
  );

  // ── CoD / RTO endpoints (GoKwik + Shopflo Track C) ────────────────────────
  // Three reads for the CoD/RTO analytics surface, all via the metric-engine sole
  // read-path (ADR-002 — NO ad-hoc SUM/COUNT here). Brand from session (D-1, never
  // body). Honest no_data (D-2). RLS/F-SEC-02: engine reads inside withBrandTxn.
  // data_source ('synthetic'|'live') is passed through for the Synthetic (dev) badge.

  /**
   * GET /api/v1/analytics/cod-rto-rates
   * RTO% by pincode cohort from gokwik.awb_status.v1 terminal Bronze rows.
   * Synthetic source in dev → data_source='synthetic' (UI badge). No numeric RTO score.
   */
  fastify.get(
    '/api/v1/analytics/cod-rto-rates',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data' } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (StarRocks) not available' } });
      }
      const result = await getCodRtoRates(auth.brandId, { srPool });
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/dashboard/customer-360
   * Customer-360 summary (customer count + lifetime value/orders + top customers) from the
   * gold_customer_360 Gold mart via the metric-engine Silver/Gold seam (ADR-002 / I-ST01). Honest
   * no_data when the brand has no customers. Brand from session (D-1).
   */
  fastify.get(
    '/api/v1/dashboard/customer-360',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data' } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (StarRocks) not available' } });
      }
      const result = await getCustomerBaseSummary(auth.brandId, { srPool });
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/cod-mix
   * CoD CM2 + CoD-vs-prepaid mix from realized_revenue_ledger cod_* event_types.
   * Money = bigint minor-unit strings (signed; net may be negative — honest).
   */
  fastify.get(
    '/api/v1/analytics/cod-mix',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data' } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (StarRocks) not available' } });
      }
      const result = await getCodMix(auth.brandId, { srPool });
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/checkout-funnel
   * Abandoned-checkout funnel from the silver_checkout_signal Silver mart (signal_type=
   * 'checkout_abandoned'). REAL Shopflo self-serve webhook (NOT synthetic). PII hashed at boundary.
   */
  fastify.get(
    '/api/v1/analytics/checkout-funnel',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data' } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (StarRocks) not available' } });
      }
      const result = await getCheckoutFunnel(auth.brandId, { srPool });
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/rto-risk-distribution
   * Per-order RTO-risk distribution from the silver_checkout_signal Silver mart (signal_type=
   * 'rto_predict'; latest prediction per order, last 30d). Categorical risk_flag buckets — VERBATIM,
   * never a fabricated score. Honest no_data (D-2). data_source='synthetic' drives the UI Synthetic
   * badge (GoKwik read API is a documented follow-up; real shape, synthetic source in dev).
   */
  fastify.get(
    '/api/v1/analytics/rto-risk-distribution',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data' } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (StarRocks) not available' } });
      }
      const result = await getRtoRiskDistribution(auth.brandId, { srPool });
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/order-status-mix?from=YYYY-MM-DD&to=YYYY-MM-DD
   * The FIRST Silver-tier read: order-status mix (counts + share + realized value by
   * lifecycle_state) over a window, from silver.order_state. Goes through the
   * metric-engine Silver seam (withSilverBrand) — the route issues NO OLAP SQL itself
   * (ADR-002 / I-ST01 sole read path). Brand from session (D-1, NEVER body). Honest
   * no_data (D-2). Money = bigint minor-unit strings (I-S07). data_source='synthetic'
   * in dev (the underlying ledger cod_* rows are synthetic — real shape, synthetic source).
   */
  fastify.get(
    '/api/v1/analytics/order-status-mix',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            to:   { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          },
          additionalProperties: false,
        },
      },
      attachValidation: true,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_PARAMS', message: 'from/to must be YYYY-MM-DD.' },
        });
      }

      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data' } });
      }
      // Silver reads require the StarRocks pool; absent → honest 503 (never a fake zero).
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (StarRocks) not available' } });
      }

      const query = request.query as { from?: string; to?: string };
      const today = new Date().toISOString().split('T')[0] as string;
      const toStr = query.to ?? today;
      // Default window: last 30 days.
      const defaultFrom = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string;
      const fromStr = query.from ?? defaultFrom;

      const result: ContractOrderStatusMix = await getOrderStatusMix(
        auth.brandId,
        { srPool },
        {
          from: new Date(`${fromStr}T00:00:00Z`),
          to: new Date(`${toStr}T23:59:59Z`),
          fromStr,
          toStr,
          // Dev: the order ledger's cod_* rows folded into Silver are synthetic (real shape).
          dataSource: 'synthetic',
        },
      );

      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/top-products?from=YYYY-MM-DD&to=YYYY-MM-DD&limit=N
   * Per-SKU rollup (units / line GMV / order count) over the Silver order-line mart
   * (silver.order_line), via the metric-engine seam (withSilverBrand, I-ST01). The route
   * issues NO OLAP SQL itself. Brand from session (D-1). Honest no_data (D-2). Money = bigint
   * minor-unit strings (I-S07). data_source='synthetic' in dev.
   */
  fastify.get(
    '/api/v1/analytics/top-products',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            from:  { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            to:    { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            limit: { type: 'integer', minimum: 1, maximum: 50 },
          },
          additionalProperties: false,
        },
      },
      attachValidation: true,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_PARAMS', message: 'from/to must be YYYY-MM-DD, limit 1–50.' },
        });
      }

      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data' } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (StarRocks) not available' } });
      }

      const query = request.query as { from?: string; to?: string; limit?: number };
      const today = new Date().toISOString().split('T')[0] as string;
      const toStr = query.to ?? today;
      const defaultFrom = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string;
      const fromStr = query.from ?? defaultFrom;

      const result: ContractTopProducts = await getTopProducts(
        auth.brandId,
        { srPool },
        {
          from: new Date(`${fromStr}T00:00:00Z`),
          to: new Date(`${toStr}T23:59:59Z`),
          fromStr,
          toStr,
          limit: query.limit ?? 10,
          dataSource: 'synthetic',
        },
      );

      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/contribution-margin?as_of=YYYY-MM-DD
   * CM1/CM2 + cost_confidence over the brand's revenue/cost/spend (feat-cm2-cost-inputs). Brand from
   * session (D-1). Honest no_data (D-2). Money = bigint minor-unit strings (I-S07). PHASE G: mixed-tier
   * read — cost config via rawPool (PG, RLS), realized + spend via srPool (lakehouse). No manual SUM
   * (F-SEC-02 / ADR-002).
   */
  fastify.get(
    '/api/v1/analytics/contribution-margin',
    {
      preHandler: [bffProtectedPreHandler],
      schema: { querystring: { type: 'object', properties: { as_of: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } }, additionalProperties: false } },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;
      const today = new Date().toISOString().split('T')[0] as string;
      const asOfStr = (request.query as { as_of?: string }).as_of ?? today;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data', as_of: asOfStr } });
      }
      if (!rawPool || !srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'read pool or Silver tier not available' } });
      }
      const result: ContractContributionMargin = await getContributionMargin(auth.brandId, new Date(`${asOfStr}T23:59:59Z`), { pool: rawPool, srPool });
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/costs — the brand's currently-active cost inputs (feat-cm2-cost-inputs).
   * POST /api/v1/costs — upsert one cost input (COGS/shipping/fee rate or fixed amount).
   * Brand from session (D-1). cost_input is RLS-scoped config.
   */
  fastify.get(
    '/api/v1/costs',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) return reply.send({ request_id: requestId, data: { cost_inputs: [] } });
      if (!rawPool) return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'read pool not available' } });
      const cost_inputs = await listCostInputs(auth.brandId, { pool: rawPool });
      const result: ContractCostInputsList = { cost_inputs };
      return reply.send({ request_id: requestId, data: result });
    },
  );

  fastify.post(
    '/api/v1/costs',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        body: {
          type: 'object',
          required: ['scope', 'cost_type', 'currency_code'],
          properties: {
            scope: { type: 'string', enum: ['global', 'sku', 'category'] },
            scope_ref: { type: 'string', maxLength: 256 },
            cost_type: { type: 'string', enum: ['cogs', 'shipping', 'packaging', 'payment_fee', 'marketplace_fee'] },
            amount_minor: { type: 'string', pattern: '^\\d+$' },
            pct_bps: { type: 'integer', minimum: 0, maximum: 100000 },
            currency_code: { type: 'string', minLength: 3, maxLength: 3 },
            cost_confidence: { type: 'string', enum: ['Trusted', 'Estimated', 'Insufficient'] },
          },
          additionalProperties: false,
        },
        attachValidation: true,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({ request_id: requestId, error: { code: 'INVALID_PARAMS', message: 'Invalid cost input.' } });
      }
      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) return reply.code(403).send({ request_id: requestId, error: { code: 'NO_BRAND', message: 'No active brand' } });
      if (!rawPool) return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'read pool not available' } });
      const b = request.body as Parameters<typeof upsertCostInput>[1];
      try {
        const out = await upsertCostInput(auth.brandId, b, { pool: rawPool });
        return reply.send({ request_id: requestId, data: out });
      } catch (err) {
        return reply.code(400).send({ request_id: requestId, error: { code: 'INVALID_PARAMS', message: String((err as Error).message) } });
      }
    },
  );

  /**
   * GET /api/v1/analytics/orders-list?page=N&page_size=M
   * A paginated list of orders (latest state per order) from Bronze (feat-shopify-order-depth);
   * each row links to order-detail. Brand from session (D-1, NEVER body). Honest no_data (D-2).
   * Money = bigint minor-unit strings (I-S07). Reads Bronze via rawPool (no manual WHERE — F-SEC-02).
   */
  fastify.get(
    '/api/v1/analytics/orders-list',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            page:      { type: 'integer', minimum: 1 },
            page_size: { type: 'integer', minimum: 1, maximum: 100 },
          },
          additionalProperties: false,
        },
      },
      attachValidation: true,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_PARAMS', message: 'page ≥ 1, page_size 1–100.' },
        });
      }

      const query = request.query as { page?: number; page_size?: number };
      const page = query.page ?? 1;
      const pageSize = query.page_size ?? 20;
      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data', page, page_size: pageSize, total: '0' } });
      }
      if (!rawPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Bronze read pool not available' } });
      }

      const result: ContractOrdersList = await getOrdersList(auth.brandId, { page, pageSize }, { pool: rawPool, srPool });
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/order-detail?order_id=<id>
   * A single order's economic breakdown (line items / tax / shipping / discounts / refunds), read
   * from Bronze — the captured composition of the order (feat-shopify-order-depth). Brand from
   * session (D-1, NEVER body). Honest not_found (D-2). Money = bigint minor-unit strings (I-S07).
   * Reads Bronze via rawPool under withBrandTxn (RLS-scoped; no manual WHERE — F-SEC-02).
   */
  fastify.get(
    '/api/v1/analytics/order-detail',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          properties: { order_id: { type: 'string', minLength: 1, maxLength: 256 } },
          required: ['order_id'],
          additionalProperties: false,
        },
      },
      attachValidation: true,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_PARAMS', message: 'order_id is required.' },
        });
      }

      const orderId = (request.query as { order_id: string }).order_id;
      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'not_found', order_id: orderId } });
      }
      if (!rawPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Bronze read pool not available' } });
      }

      const result: ContractOrderDetail = await getOrderDetail(auth.brandId, orderId, { pool: rawPool, srPool });
      return reply.send({ request_id: requestId, data: result });
    },
  );

  // ── Journey endpoints (Phase 4 — feat-journey-touchpoint) ─────────────────
  // Silver reads over silver.touchpoint through the metric-engine seam (withSilverBrand,
  // I-ST01 sole reader). The route issues NO OLAP SQL itself (ADR-002). Brand from session
  // (D-1, NEVER body). Honest no_data (D-2). data_source='synthetic' in dev (journey demo
  // is enriched with clearly-labelled synthetic fixtures; real page.viewed events are thin).

  /**
   * GET /api/v1/analytics/journey/first-touch-mix?from=YYYY-MM-DD&to=YYYY-MM-DD
   * First-touch channel mix (distinct journeys + integer-basis-point share by channel)
   * over a window, from silver.touchpoint.
   */
  fastify.get(
    '/api/v1/analytics/journey/first-touch-mix',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            to:   { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          },
          additionalProperties: false,
        },
      },
      attachValidation: true,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_PARAMS', message: 'from/to must be YYYY-MM-DD.' },
        });
      }

      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data' } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (StarRocks) not available' } });
      }

      const query = request.query as { from?: string; to?: string };
      const today = new Date().toISOString().split('T')[0] as string;
      const toStr = query.to ?? today;
      const defaultFrom = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string;
      const fromStr = query.from ?? defaultFrom;

      const result: ContractJourneyFirstTouchMix = await getJourneyFirstTouchMix(
        auth.brandId,
        { srPool },
        {
          from: new Date(`${fromStr}T00:00:00Z`),
          to: new Date(`${toStr}T23:59:59Z`),
          fromStr,
          toStr,
          // Dev: journey demo is enriched with clearly-labelled synthetic fixtures.
          dataSource: 'synthetic',
        },
      );

      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/logistics/shipment-outcomes?from=YYYY-MM-DD&to=YYYY-MM-DD
   * Shipment outcome breakdown (delivered/RTO/other/in-transit + RTO% overall, by courier,
   * by pincode) over a window, from the multi-source silver_shipment mart (GoKwik AWB +
   * Shiprocket). Slice 2.
   */
  fastify.get(
    '/api/v1/analytics/logistics/shipment-outcomes',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            to:   { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          },
          additionalProperties: false,
        },
      },
      attachValidation: true,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_PARAMS', message: 'from/to must be YYYY-MM-DD.' },
        });
      }

      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data' } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (StarRocks) not available' } });
      }

      const query = request.query as { from?: string; to?: string };
      const today = new Date().toISOString().split('T')[0] as string;
      const toStr = query.to ?? today;
      const defaultFrom = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string;
      const fromStr = query.from ?? defaultFrom;

      const result: ContractShipmentOutcomes = await getShipmentOutcomes(
        auth.brandId,
        { srPool },
        {
          from: new Date(`${fromStr}T00:00:00Z`),
          to: new Date(`${toStr}T23:59:59Z`),
          fromStr,
          toStr,
          // Dev: shipment lifecycle is fixture-sourced (real shape, synthetic source).
          dataSource: 'synthetic',
        },
      );

      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/behavior/overview?from=YYYY-MM-DD&to=YYYY-MM-DD
   * Storefront behavior — sessions/journeys/touches + page-type mix + top viewed products + top
   * searches, from silver_touchpoint (pixel auto-instrumentation).
   */
  fastify.get(
    '/api/v1/analytics/behavior/overview',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            to:   { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          },
          additionalProperties: false,
        },
      },
      attachValidation: true,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_PARAMS', message: 'from/to must be YYYY-MM-DD.' },
        });
      }

      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data' } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (StarRocks) not available' } });
      }

      const query = request.query as { from?: string; to?: string };
      const today = new Date().toISOString().split('T')[0] as string;
      const toStr = query.to ?? today;
      const defaultFrom = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string;
      const fromStr = query.from ?? defaultFrom;

      const result: ContractBehaviorOverview = await getBehaviorOverview(
        auth.brandId,
        { srPool },
        {
          from: new Date(`${fromStr}T00:00:00Z`),
          to: new Date(`${toStr}T23:59:59Z`),
          fromStr,
          toStr,
          // Dev: pixel events are real but thin; surface 'live' (no synthetic enrichment here).
          dataSource: 'live',
        },
      );

      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/funnel?from=YYYY-MM-DD&to=YYYY-MM-DD
   * Storefront conversion funnel — sessions → product views → cart adds → purchases, from
   * silver_touchpoint (Phase H pixel). Distinct-session reach per stage + conversion %.
   */
  fastify.get(
    '/api/v1/analytics/funnel',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            to:   { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          },
          additionalProperties: false,
        },
      },
      attachValidation: true,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_PARAMS', message: 'from/to must be YYYY-MM-DD.' },
        });
      }

      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data' } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (StarRocks) not available' } });
      }

      const query = request.query as { from?: string; to?: string };
      const today = new Date().toISOString().split('T')[0] as string;
      const toStr = query.to ?? today;
      const defaultFrom = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string;
      const fromStr = query.from ?? defaultFrom;

      const result: ContractFunnelAnalytics = await getFunnelAnalytics(
        auth.brandId,
        { srPool },
        {
          from: new Date(`${fromStr}T00:00:00Z`),
          to: new Date(`${toStr}T23:59:59Z`),
          fromStr,
          toStr,
          dataSource: 'live',
        },
      );

      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/abandoned-cart?from=YYYY-MM-DD&to=YYYY-MM-DD
   * Cart-recovery rollup — of sessions that added to cart, how many converted (stitched to an order)
   * vs abandoned, from silver_touchpoint (Phase H pixel).
   */
  fastify.get(
    '/api/v1/analytics/abandoned-cart',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            to:   { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          },
          additionalProperties: false,
        },
      },
      attachValidation: true,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_PARAMS', message: 'from/to must be YYYY-MM-DD.' },
        });
      }

      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data' } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (StarRocks) not available' } });
      }

      const query = request.query as { from?: string; to?: string };
      const today = new Date().toISOString().split('T')[0] as string;
      const toStr = query.to ?? today;
      const defaultFrom = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string;
      const fromStr = query.from ?? defaultFrom;

      const result: ContractAbandonedCart = await getAbandonedCart(
        auth.brandId,
        { srPool },
        {
          from: new Date(`${fromStr}T00:00:00Z`),
          to: new Date(`${toStr}T23:59:59Z`),
          fromStr,
          toStr,
          dataSource: 'live',
        },
      );

      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/engagement?from=YYYY-MM-DD&to=YYYY-MM-DD
   * Engagement depth — engaged (multi-touch) vs bounce sessions + avg touches per session, from
   * silver_touchpoint (Phase H pixel).
   */
  fastify.get(
    '/api/v1/analytics/engagement',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            to:   { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          },
          additionalProperties: false,
        },
      },
      attachValidation: true,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_PARAMS', message: 'from/to must be YYYY-MM-DD.' },
        });
      }

      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data' } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (StarRocks) not available' } });
      }

      const query = request.query as { from?: string; to?: string };
      const today = new Date().toISOString().split('T')[0] as string;
      const toStr = query.to ?? today;
      const defaultFrom = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string;
      const fromStr = query.from ?? defaultFrom;

      const result: ContractEngagement = await getEngagement(
        auth.brandId,
        { srPool },
        {
          from: new Date(`${fromStr}T00:00:00Z`),
          to: new Date(`${toStr}T23:59:59Z`),
          fromStr,
          toStr,
          dataSource: 'live',
        },
      );

      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/journey/stitch-rate?from=YYYY-MM-DD&to=YYYY-MM-DD
   * Deterministic cart-stitch hit-rate (stitched ÷ total distinct anon journeys) over a
   * window. Stitch is read BACK from the order (D-5), never inferred.
   */
  fastify.get(
    '/api/v1/analytics/journey/stitch-rate',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            to:   { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          },
          additionalProperties: false,
        },
      },
      attachValidation: true,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_PARAMS', message: 'from/to must be YYYY-MM-DD.' },
        });
      }

      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data' } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (StarRocks) not available' } });
      }

      const query = request.query as { from?: string; to?: string };
      const today = new Date().toISOString().split('T')[0] as string;
      const toStr = query.to ?? today;
      const defaultFrom = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string;
      const fromStr = query.from ?? defaultFrom;

      const result: ContractJourneyStitchRate = await getJourneyStitchRate(
        auth.brandId,
        { srPool },
        {
          from: new Date(`${fromStr}T00:00:00Z`),
          to: new Date(`${toStr}T23:59:59Z`),
          fromStr,
          toStr,
          dataSource: 'synthetic',
        },
      );

      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/journey/timeline?orderId=...  (or ?anonId=...)
   * The ordered touchpoint timeline for ONE journey — resolved by order_id (via the
   * deterministic stitch map, D-5) or directly by brain_anon_id. A read projection.
   */
  fastify.get(
    '/api/v1/analytics/journey/timeline',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            orderId: { type: 'string', minLength: 1, maxLength: 256 },
            anonId:  { type: 'string', minLength: 1, maxLength: 256 },
          },
          additionalProperties: false,
        },
      },
      attachValidation: true,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_PARAMS', message: 'orderId or anonId required.' },
        });
      }

      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data' } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (StarRocks) not available' } });
      }

      const query = request.query as { orderId?: string; anonId?: string };
      if (!query.orderId && !query.anonId) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_PARAMS', message: 'orderId or anonId required.' },
        });
      }

      const selector = query.orderId
        ? { orderId: query.orderId }
        : { brainAnonId: query.anonId as string };

      const result: ContractJourneyTimeline = await getJourneyTimeline(
        auth.brandId,
        { srPool },
        { selector, dataSource: 'synthetic' },
      );

      return reply.send({ request_id: requestId, data: result });
    },
  );

  // ── Attribution endpoints (Phase 5 — feat-attribution-ledger) ─────────────
  // Reads over attribution_credit_ledger (Postgres Gold, 0032) through the metric-engine
  // named seams (ADR-002 / I-ST01 — the BFF issues NO ad-hoc SUM). Brand from session
  // (D-1, NEVER body). Honest no_data. data_source='synthetic' in dev (journey data is thin
  // → attribution is mostly synthetic; the badge is honest).

  const ATTRIBUTION_MODELS = new Set<string>(['first_touch', 'last_touch', 'linear', 'position_based', 'data_driven']);
  function parseModel(raw: string | undefined): AttributionModelId {
    return ATTRIBUTION_MODELS.has(raw ?? '') ? (raw as AttributionModelId) : 'position_based';
  }
  const attributionQuerySchema = {
    type: 'object',
    properties: {
      from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      model: { type: 'string', enum: ['first_touch', 'last_touch', 'linear', 'position_based', 'data_driven'] },
    },
    additionalProperties: false,
  } as const;

  /**
   * GET /api/v1/analytics/attribution/by-channel?from=&to=&model=
   * Attributed revenue by channel + the unattributed residual + the reconciliation rate
   * for a model + window, from attribution_credit_ledger.
   */
  fastify.get(
    '/api/v1/analytics/attribution/by-channel',
    { preHandler: [bffProtectedPreHandler], schema: { querystring: attributionQuerySchema }, attachValidation: true },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({ request_id: requestId, error: { code: 'INVALID_PARAMS', message: 'from/to must be YYYY-MM-DD; model must be a valid model id.' } });
      }
      const auth = (request as AuthenticatedRequest).auth;
      const query = request.query as { from?: string; to?: string; model?: string };
      const model = parseModel(query.model);
      if (!auth.brandId) {
        const today = new Date().toISOString().split('T')[0] as string;
        return reply.send({ request_id: requestId, data: { state: 'no_data', from: today, to: today, model } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (StarRocks) not available' } });
      }
      const today = new Date().toISOString().split('T')[0] as string;
      const toStr = query.to ?? today;
      const fromStr = query.from ?? (new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string);

      const result: ContractAttributionByChannel = await getAttributionByChannel(
        auth.brandId,
        {
          model,
          fromDate: new Date(`${fromStr}T00:00:00Z`),
          toDate: new Date(`${toStr}T00:00:00Z`),
          fromStr,
          toStr,
          dataSource: 'synthetic',
        },
        { srPool },
      );
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/attribution/reconciliation?from=&to=&model=
   * The reconciliation rate + the always-rendered unattributed residual.
   */
  fastify.get(
    '/api/v1/analytics/attribution/reconciliation',
    { preHandler: [bffProtectedPreHandler], schema: { querystring: attributionQuerySchema }, attachValidation: true },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({ request_id: requestId, error: { code: 'INVALID_PARAMS', message: 'from/to must be YYYY-MM-DD; model must be a valid model id.' } });
      }
      const auth = (request as AuthenticatedRequest).auth;
      const query = request.query as { from?: string; to?: string; model?: string };
      const model = parseModel(query.model);
      if (!auth.brandId) {
        const today = new Date().toISOString().split('T')[0] as string;
        return reply.send({ request_id: requestId, data: { state: 'no_data', from: today, to: today, model } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (StarRocks) not available' } });
      }
      const today = new Date().toISOString().split('T')[0] as string;
      const toStr = query.to ?? today;
      const fromStr = query.from ?? (new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string);

      const result: ContractAttributionReconciliation = await getAttributionReconciliation(
        auth.brandId,
        {
          model,
          fromDate: new Date(`${fromStr}T00:00:00Z`),
          toDate: new Date(`${toStr}T00:00:00Z`),
          fromStr,
          toStr,
          dataSource: 'synthetic',
        },
        { srPool },
      );
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/attribution/channel-roas?from=&to=&model=
   * Per-channel ROAS = attributed_revenue ÷ ad_spend (honest null when spend=0).
   */
  fastify.get(
    '/api/v1/analytics/attribution/channel-roas',
    { preHandler: [bffProtectedPreHandler], schema: { querystring: attributionQuerySchema }, attachValidation: true },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({ request_id: requestId, error: { code: 'INVALID_PARAMS', message: 'from/to must be YYYY-MM-DD; model must be a valid model id.' } });
      }
      const auth = (request as AuthenticatedRequest).auth;
      const query = request.query as { from?: string; to?: string; model?: string };
      const model = parseModel(query.model);
      if (!auth.brandId) {
        const today = new Date().toISOString().split('T')[0] as string;
        return reply.send({ request_id: requestId, data: { state: 'no_data', from: today, to: today, model } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (StarRocks) not available' } });
      }
      const today = new Date().toISOString().split('T')[0] as string;
      const toStr = query.to ?? today;
      const fromStr = query.from ?? (new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string);

      const result: ContractChannelRoas = await getChannelRoas(
        auth.brandId,
        {
          model,
          fromDate: new Date(`${fromStr}T00:00:00Z`),
          toDate: new Date(`${toStr}T00:00:00Z`),
          fromStr,
          toStr,
          dataSource: 'synthetic',
        },
        { srPool },
      );
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/attribution/campaign-roas?from=&to=&model=
   * H8 — per-CAMPAIGN ROAS = attributed_revenue ÷ ad_spend (honest null when spend=0). The granular
   * sibling of channel-roas; joins gold_marketing_attribution × silver_marketing_spend on campaign_id.
   */
  fastify.get(
    '/api/v1/analytics/attribution/campaign-roas',
    { preHandler: [bffProtectedPreHandler], schema: { querystring: attributionQuerySchema }, attachValidation: true },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({ request_id: requestId, error: { code: 'INVALID_PARAMS', message: 'from/to must be YYYY-MM-DD; model must be a valid model id.' } });
      }
      const auth = (request as AuthenticatedRequest).auth;
      const query = request.query as { from?: string; to?: string; model?: string };
      const model = parseModel(query.model);
      if (!auth.brandId) {
        const today = new Date().toISOString().split('T')[0] as string;
        return reply.send({ request_id: requestId, data: { state: 'no_data', from: today, to: today, model } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (StarRocks) not available' } });
      }
      const today = new Date().toISOString().split('T')[0] as string;
      const toStr = query.to ?? today;
      const fromStr = query.from ?? (new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string);

      const result = await getCampaignRoas(
        auth.brandId,
        {
          model,
          fromDate: new Date(`${fromStr}T00:00:00Z`),
          toDate: new Date(`${toStr}T00:00:00Z`),
          fromStr,
          toStr,
        },
        { srPool },
      );
      return reply.send({ request_id: requestId, data: result });
    },
  );

  // ── Tracking Center endpoints (Phase 1 Track C) ───────────────────────────
  // Stakeholder-visible proof that the pixel works. Bounded reads (D-2 allowed),
  // RLS-scoped via withBrandTxn, brand from session (D-1). NO raw PII in responses.

  /**
   * GET /api/v1/analytics/tracking-health
   * Returns pixel-collection health: first-event-received, per-day volume,
   * last-event freshness, total + consent-capture counts. Honest-empty 'no_data'.
   */
  fastify.get(
    '/api/v1/analytics/tracking-health',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();

      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data' } });
      }
      if (!rawPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' } });
      }

      const result = await getTrackingHealth(auth.brandId, { pool: rawPool, srPool });

      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/recent-events?limit=20
   * Returns the latest N collected events (type/time/anonymized ids) for the
   * Event Explorer. Bounded read; NO raw PII (anonymized ids only).
   */
  fastify.get(
    '/api/v1/analytics/recent-events',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'string', pattern: '^\\d+$' },
          },
          additionalProperties: false,
        },
      },
      attachValidation: true,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();

      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { rows: [] } });
      }
      if (!rawPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' } });
      }

      const query = request.query as { limit?: string };
      const limit = query.limit ? Math.min(parseInt(query.limit, 10), 50) : 20;

      const result = await getRecentEvents(auth.brandId, limit, { pool: rawPool, srPool });

      return reply.send({ request_id: requestId, data: result });
    },
  );

  // ── Consent / Compliance (D13 — feat-d13-consent-cancontact Track C) ──────────
  //
  // Four brand-scoped reads behind the per-brand /settings/consent surface. All read
  // ONLY the consent system-of-record (consent_record + consent_tombstone + audit_log)
  // through the analytics use-cases inside withBrandTxn (GUC per-txn, RLS-enforced).
  // Brand from session (D-1, NEVER body). Honest no_data (D-2) — for consent, an empty
  // SoR is the FAIL-CLOSED state: nothing is sendable, "blocked until consent recorded".
  // PII: counts + hashes only; no raw email/phone (I-S02 / COMPLIANCE.md). No money.

  /**
   * GET /api/v1/consent/coverage
   * Per-category granted/withdrawn subject counts (the consent posture at a glance).
   */
  fastify.get(
    '/api/v1/consent/coverage',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data' } });
      }
      if (!rawPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' } });
      }
      const result = await getConsentCoverage(auth.brandId, { pool: rawPool });
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/consent/suppression-summary
   * Marketing-suppression counts (the fail-closed denominator: tombstoned + no-consent).
   */
  fastify.get(
    '/api/v1/consent/suppression-summary',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data' } });
      }
      if (!rawPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' } });
      }
      const result = await getConsentSuppressionSummary(auth.brandId, { pool: rawPool });
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/consent/gate-activity
   * The last-N can_contact() gate decisions by reason (from audit_log) — makes the
   * DEFAULT-CLOSED posture VISIBLE (a 'block: consent_absent' row proves the gate denied).
   */
  fastify.get(
    '/api/v1/consent/gate-activity',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data' } });
      }
      if (!rawPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' } });
      }
      const result = await getConsentGateActivity(auth.brandId, { pool: rawPool });
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/consent/window-config
   * The read-only 9am–9pm IST permitted-hours send window. SERVER-enforced at the queue
   * (TCCCPR/DLT) — surfaced here as display + a server-computed in_window_now / next-open
   * boundary (the UI never derives the window from a client clock). No DB read.
   */
  fastify.get(
    '/api/v1/consent/window-config',
    { preHandler: [bffProtectedPreHandler] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const result = getConsentWindowConfig();
      return reply.send({ request_id: requestId, data: result });
    },
  );

  // ── Conversion-Feedback / CAPI (Phase 6 — feat-capi-conversion-feedback Track C) ──────
  //
  // Three brand-scoped reads behind the stakeholder-visible Conversion-Feedback surface
  // (/analytics/conversion-feedback). All read ONLY the CAPI passback system-of-record
  // (capi_passback_log + capi_deletion_log, migration 0034) through the analytics use-cases
  // inside withBrandTxn (GUC per-txn, RLS-enforced, NON-INERT under brain_app). Brand from
  // session (D-1, NEVER body). Honest no_data (D-2) — fail-closed when 0034 is not yet
  // migrated (nothing passed back yet). PII: counts + a TRUNCATED event_id (sha256, never
  // PII) only; NO subject_hash, NO raw email/phone (those never existed in these tables).
  // Money is BIGINT minor + currency_code (value formatted minor→major in the web layer).
  // The blocked_by_consent count is the SLO=0 (non_consented_sends) made VISIBLE; the
  // would_send_dev count + dev_boundary flag drive the honest "would-send in dev" banner.

  /**
   * GET /api/v1/feedback/capi/summary
   * Passed-back vs BLOCKED-BY-CONSENT counts, deletion-request count, and the
   * match-quality proxy (avg Meta match keys / 4) — the SLO=0 made visible.
   */
  fastify.get(
    '/api/v1/feedback/capi/summary',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data' } });
      }
      if (!rawPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' } });
      }
      const result = await getCapiFeedbackSummary(auth.brandId, { pool: rawPool });
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/feedback/capi/events
   * The last-N passback log rows (truncated event_id, status, value minor+currency,
   * match_key_count, occurred_at). A 'blocked_no_consent' row proves the gate denied
   * a non-consented passback; a 'would_send_dev' row is the honest dev boundary.
   */
  fastify.get(
    '/api/v1/feedback/capi/events',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data' } });
      }
      if (!rawPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' } });
      }
      const result = await getCapiFeedbackEvents(auth.brandId, { pool: rawPool });
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/feedback/capi/deletions
   * The last-N retroactive-deletion requests (status, event_count, requested/completed,
   * latency seconds) — proof the ≤15-min consent-withdrawal deletion path works.
   */
  fastify.get(
    '/api/v1/feedback/capi/deletions',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data' } });
      }
      if (!rawPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' } });
      }
      const result = await getCapiFeedbackDeletions(auth.brandId, { pool: rawPool });
      return reply.send({ request_id: requestId, data: result });
    },
  );
}
