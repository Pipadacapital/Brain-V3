/**
 * Core monolith (Deployable 3) — Fastify bootstrap.
 *
 * Modules: workspace-access (auth/org/brand/invite/RBAC), notification (SES transactional),
 * frontend-api (BFF + dashboard), connector + pixel (mounted with guards — HIGH-MOUNT-01).
 *
 * INVARIANTS:
 *  - NN-5: argon2id params asserted at startup.
 *  - NN-3: validateSession preHandler on every protected route (via route registrations).
 *  - I-S09: JWT signing key + cookie secret fetched from SecretsProvider, never plain env values in prod.
 *  - Error envelope: { request_id, error: { code, message, fields? } }
 *  - Correlation ID propagated on every request (x-correlation-id header).
 *  - No StarRocks/Analytics API call in this module (ADR-002).
 */

import Fastify, { type FastifyRequest, type FastifyError } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';

import { createPool } from '@brain/db';
import pg from 'pg';
import { DbAuditWriter } from '@brain/audit';

import { assertArgon2Params, AuthService } from './modules/workspace-access/internal/application/auth.service.js';
import { WorkspaceService } from './modules/workspace-access/internal/application/workspace.service.js';
import { BrandService } from './modules/workspace-access/internal/application/brand.service.js';
import { InviteService } from './modules/workspace-access/internal/application/invite.service.js';
import { registerAuthRoutes } from './modules/workspace-access/internal/interfaces/rest/auth.routes.js';
import { RateLimiter } from './modules/workspace-access/internal/infrastructure/rate-limiter.js';
import { registerWorkspaceRoutes } from './modules/workspace-access/internal/interfaces/rest/workspace.routes.js';
import { registerBrandRoutes } from './modules/workspace-access/internal/interfaces/rest/brand.routes.js';
import { registerMemberRoutes } from './modules/workspace-access/internal/interfaces/rest/member.routes.js';
import { registerBffRoutes } from './modules/frontend-api/internal/bff.routes.js';
import { jtiFromJwt, csrfTokenForSession, csrfTokenMatches } from './modules/frontend-api/internal/csrf.js';
import { NotificationServiceImpl } from './modules/notification/internal/notification.service.impl.js';
import { registerDevRoutes } from './modules/notification/internal/dev.routes.js';
import { createEmailAdapter } from './modules/notification/internal/ses-adapter.js';

// ── Connector infrastructure imports (HIGH-MOUNT-01) ─────────────────────────
import { registerShopifyConnectorRoutes } from './modules/connector/sources/storefront/shopify/interfaces/http/shopifyConnectorRoutes.js';
import { registerDevShopifySyncRoutes } from './modules/connector/sources/storefront/shopify/interfaces/http/devShopifySyncRoutes.js';
import { registerPixelRoutes, buildDefaultSnippet } from './modules/connector/pixel/interfaces/http/pixelRoutes.js';
import { InitiateOAuthCommand } from './modules/connector/sources/storefront/shopify/application/commands/InitiateOAuthCommand.js';
import {
  HandleOAuthCallbackCommand,
  HmacValidationError,
  StateNonceError,
  ShopDomainError,
} from './modules/connector/sources/storefront/shopify/application/commands/HandleOAuthCallbackCommand.js';
import {
  DisconnectCommand,
  ConnectorNotFoundError,
} from './modules/connector/sources/storefront/shopify/application/commands/DisconnectCommand.js';
import { GetConnectorStatusQuery } from './modules/connector/sources/storefront/shopify/application/queries/GetConnectorStatusQuery.js';
import { PgConnectorInstanceRepository } from './modules/connector/sources/storefront/shopify/infrastructure/repositories/PgConnectorInstanceRepository.js';
import { PgConnectorSyncStatusRepository } from './modules/connector/sources/storefront/shopify/infrastructure/repositories/PgConnectorSyncStatusRepository.js';
import { LocalSecretsManager } from './modules/connector/sources/storefront/shopify/infrastructure/secrets/LocalSecretsManager.js';
import { AwsSecretsManager } from './modules/connector/sources/storefront/shopify/infrastructure/secrets/AwsSecretsManager.js';
import { InProcessOAuthStateStore } from './modules/connector/sources/storefront/shopify/infrastructure/state/InProcessOAuthStateStore.js';
import { GetOrCreatePixelInstallationCommand } from './modules/connector/pixel/application/commands/GetOrCreatePixelInstallationCommand.js';
import {
  VerifyPixelCommand,
  PixelInstallationNotFoundError,
} from './modules/connector/pixel/application/commands/VerifyPixelCommand.js';
import { GetPixelHealthQuery } from './modules/connector/pixel/application/queries/GetPixelHealthQuery.js';
import { PgPixelInstallationRepository } from './modules/connector/pixel/infrastructure/repositories/PgPixelInstallationRepository.js';
import { PgPixelStatusRepository } from './modules/connector/pixel/infrastructure/repositories/PgPixelStatusRepository.js';

// ── RBAC guards (HIGH-MOUNT-01) ───────────────────────────────────────────────
import { validateSessionPreHandler } from './modules/workspace-access/internal/interfaces/rest/auth.routes.js';
import { requireRole } from './modules/workspace-access/internal/security/rbac.js';
import type { AuthenticatedRequest } from './modules/workspace-access/internal/interfaces/rest/auth.routes.js';

// ── Secrets provider (HIGH-SECRETS-01) ───────────────────────────────────────
import { AwsSecretsProvider } from './infrastructure/secrets/AwsSecretsProvider.js';
import { LocalSecretsProvider } from './infrastructure/secrets/LocalSecretsProvider.js';

// ── Environment validation ────────────────────────────────────────────────────

function getEnvOrThrow(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`[core] Missing required environment variable: ${name}`);
  return val;
}

function getEnv(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue;
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

export async function main(): Promise<void> {
  // NN-5: Assert argon2id parameters at startup.
  assertArgon2Params();

  const nodeEnv = getEnv('NODE_ENV', 'development');
  const isProduction = nodeEnv === 'production';

  // ── HIGH-SECRETS-01: Resolve secrets from the appropriate provider ─────────
  // In production: env var holds the ARN; AwsSecretsProvider fetches the value.
  // In development: env var holds the raw value; LocalSecretsProvider returns it.
  // FAIL-CLOSED: if the secret cannot be resolved, startup aborts (no randomUUID default).
  const secretsProvider = isProduction
    ? new AwsSecretsProvider(getEnv('AWS_REGION', 'us-east-1'))
    : new LocalSecretsProvider();

  const jwtSigningSecretRef = getEnvOrThrow('JWT_SIGNING_SECRET');
  const cookieSecretRef = getEnvOrThrow('COOKIE_SECRET');

  const [jwtSigningSecret, cookieSecret] = await Promise.all([
    secretsProvider.getSecret(jwtSigningSecretRef),
    secretsProvider.getSecret(cookieSecretRef),
  ]);

  // Load remaining configuration.
  const config = {
    port: parseInt(getEnv('PORT', '3001'), 10),
    databaseUrl: getEnvOrThrow('DATABASE_URL'),
    redisUrl: getEnv('REDIS_URL', 'redis://localhost:6379'),
    jwtSigningSecret,
    appBaseUrl: getEnv('APP_BASE_URL', 'http://localhost:3000'),
    emailFromAddress: getEnv('EMAIL_FROM_ADDRESS', 'noreply@brain.app'),
    nodeEnv,
    cookieSecret,
    shopifyCallbackUrl: getEnv(
      'SHOPIFY_CALLBACK_URL',
      'http://localhost:3001/api/v1/connectors/shopify/callback',
    ),
    pixelIngestBaseUrl: getEnv('PIXEL_INGEST_BASE_URL', 'http://localhost:3001'),
  };

  // Create Fastify instance.
  const app = Fastify({
    logger: {
      level: config.nodeEnv === 'production' ? 'info' : 'debug',
      serializers: {
        req(req) {
          return {
            method: req.method,
            url: req.url,
            // Do NOT log Authorization header (PII / secret protection).
            correlationId: req.headers['x-correlation-id'] ?? randomUUID(),
          };
        },
      },
    },
    bodyLimit: 1024 * 1024,
    trustProxy: true,
    genReqId: () => randomUUID(),
  });

  // Register cookie plugin for BFF session.
  // Double-cast required: @fastify/cookie v11 uses FastifyTypeProviderDefault in its
  // plugin type signature, while fastify 5's register overload uses the generic
  // FastifyTypeProvider constraint. The two constraints are not assignable in either
  // direction, so a direct cast fails. Casting through unknown is the correct TS pattern
  // for this known upstream type incompatibility in @fastify/cookie v11.0.x.
  // Runtime behavior is correct — the plugin augments the instance at registration time.
  await app.register(fastifyCookie as unknown as Parameters<typeof app.register>[0], {
    secret: config.cookieSecret,
    parseOptions: {},
  });

  // Add correlation ID to every request + the browser BFF bridge + CSRF defense.
  app.addHook('onRequest', async (request, reply) => {
    if (!request.headers['x-correlation-id']) {
      request.headers['x-correlation-id'] = randomUUID();
    }

    const cookies = (request as unknown as { cookies?: Record<string, string | undefined> }).cookies;
    const sessionCookie = cookies?.['brain_session'];

    // Browser BFF bridge: the web app authenticates via the httpOnly `brain_session`
    // cookie (set by POST /api/v1/bff/session). Most API routes are guarded by
    // validateSessionPreHandler, which reads `Authorization: Bearer`. The browser
    // cannot set that header (the token is httpOnly), so translate the session cookie
    // into a Bearer header app-wide. Routes with their own cookie-aware preHandler
    // (bffProtectedPreHandler) read request.cookies directly and are unaffected.
    if (!request.headers.authorization && sessionCookie) {
      request.headers.authorization = `Bearer ${sessionCookie}`;
    }

    // CSRF defense (double-submit) for cookie-authenticated state-changing requests.
    // The cookie→Bearer bridge means any browser request carrying `brain_session` is
    // authenticated; sameSite=strict already blocks cross-site cookie sends, and this
    // adds explicit double-submit defense (SEC-0008-M01). Enforced ONLY when the
    // request authenticates via the session cookie — so:
    //   - public/no-session mutations (register, login, the session-creating routes,
    //     OAuth callback, HMAC webhooks) are exempt,
    //   - non-browser Bearer clients (a real Authorization header, no cookie) are exempt.
    const method = request.method.toUpperCase();
    const isMutation = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
    if (isMutation && sessionCookie) {
      const path = (request.url.split('?')[0] ?? '');
      const csrfExempt =
        path === '/api/v1/bff/session' || // login — establishes the session
        path === '/api/v1/auth/login' ||
        path === '/api/v1/auth/register' ||
        path === '/api/v1/auth/verify-email' ||
        path === '/api/v1/auth/forgot-password' ||
        path === '/api/v1/auth/reset-password' ||
        path === '/api/v1/auth/token/refresh' || // AC-1: refresh token is the credential
        path === '/api/v1/connectors/shopify/callback' || // OAuth (state-validated)
        path.startsWith('/api/v1/webhooks/'); // HMAC-validated
      if (!csrfExempt) {
        const csrfCookie = cookies?.['brain_csrf'];
        const csrfHeader = Array.isArray(request.headers['x-csrf-token'])
          ? request.headers['x-csrf-token'][0]
          : request.headers['x-csrf-token'];
        // Double-submit (cookie === header) AND session-binding (token must equal
        // HMAC(cookieSecret, jti) for this session) — SEC-0009-M02. Binding makes a
        // token issued for another session, or after this session revokes, invalid.
        const jti = jtiFromJwt(sessionCookie);
        const expected = jti ? csrfTokenForSession(jti, config.cookieSecret) : undefined;
        const ok =
          !!csrfCookie &&
          !!csrfHeader &&
          csrfTokenMatches(csrfCookie, csrfHeader) &&
          !!expected &&
          csrfTokenMatches(csrfHeader, expected);
        if (!ok) {
          return reply.code(403).send({
            request_id: (request.id as string) ?? randomUUID(),
            error: { code: 'CSRF_MISMATCH', message: 'CSRF token missing or invalid.' },
          });
        }
      }
    }
  });

  // Global error handler — always returns error envelope with request_id.
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const requestId = (request.id as string) ?? randomUUID();
    app.log.error({
      request_id: requestId,
      error: error.message,
      code: error.code,
      stack: config.nodeEnv !== 'production' ? error.stack : undefined,
    });

    const statusCode = error.statusCode ?? 500;
    return reply.code(statusCode).send({
      request_id: requestId,
      error: {
        code: error.code ?? 'INTERNAL_ERROR',
        message: statusCode >= 500 ? 'Internal server error' : error.message,
      },
    });
  });

  // Health routes.
  app.get('/', async () => ({ service: 'brain-core', version: '0.1.0' }));
  app.get('/health', async () => ({
    status: 'ok',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
  }));

  // Create Redis client for rate limiting (AC-3 / MA-04). FAIL-OPEN: the RateLimiter
  // itself handles Redis errors by allowing the request (no Redis = no blocking).
  const redis = new Redis(config.redisUrl, {
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    lazyConnect: true,
    enableOfflineQueue: false,
  });
  // lazyConnect: suppress startup errors — RateLimiter is fail-open anyway.
  redis.connect().catch((err: unknown) => {
    console.warn('[core] Redis connect failed — rate limiting will fail-open', err);
  });
  const rateLimiter = new RateLimiter(redis);

  // Raw pg.Pool for methods that need explicit BEGIN/COMMIT (rotateRefreshToken, acceptInvite,
  // updateMemberRole, removeMember). These require transaction control before knowing the userId,
  // so the GUC middleware cannot be applied at checkout. The raw pool bypasses GUC middleware.
  const rawPgPool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: 5, // smaller sub-pool for transactional paths
  });

  // Create DB pool (3-GUC middleware — NN-1).
  const pool = await createPool({ connectionString: config.databaseUrl });

  // Create audit writer (real sha256 hash-chain — L-02).
  const auditDb = {
    query: async <T = unknown>(sql: string, params?: unknown[]) => {
      const client = await pool.connect();
      try {
        return await client.query<T>({ correlationId: 'system' }, sql, params);
      } finally {
        client.release();
      }
    },
  };
  const auditWriter = new DbAuditWriter(auditDb);

  // Create notification service (SES in prod, console in dev — I-ST05).
  const emailAdapter = createEmailAdapter(config.nodeEnv, config.emailFromAddress);
  const notificationService = new NotificationServiceImpl(emailAdapter, config.appBaseUrl);

  // Create application services.
  const authServiceConfig = { jwtSigningSecret: config.jwtSigningSecret };
  const authService = new AuthService(pool, auditWriter, notificationService, authServiceConfig, rawPgPool);
  const workspaceService = new WorkspaceService(pool, auditWriter);
  const brandService = new BrandService(pool, auditWriter);
  const inviteService = new InviteService(pool, auditWriter, notificationService, rawPgPool);

  // Register workspace-access + BFF routes.
  registerAuthRoutes(app, authService, rateLimiter);
  registerWorkspaceRoutes(app, authService, workspaceService);
  registerBrandRoutes(app, authService, brandService);
  registerMemberRoutes(app, authService, inviteService, rawPgPool);
  registerBffRoutes(app, authService, pool, config.cookieSecret, rateLimiter);

  // DEV-ONLY: surface email action links (verify/reset/invite) for browser testing
  // without a real inbox. Registered ONLY outside production — the route does not
  // exist in prod, and dev-link-capture never stores anything in prod either.
  if (nodeEnv !== 'production') {
    registerDevRoutes(app);
    app.log.warn('[dev] /api/v1/dev/last-email-link mounted (NODE_ENV != production)');
  }

  // ── HIGH-MOUNT-01: Mount connector + pixel routes with guards wired HERE ────
  //
  // The preHandlers are always passed to the route registration functions so
  // the guard enforcement is self-contained at mount time — no deferred wiring,
  // no "comment says it will be done later".
  //
  // Guard assignments per the plan's RBAC:
  //   - Reads  (GET connectors, GET status):         analyst+
  //   - Writes (install, disconnect, pixel/verify):  manager+
  //   - Callback route is PUBLIC (Shopify-called), protected by HMAC (NN-4).
  //   - Pixel health read:                           analyst+
  //   - Pixel installation snippet:                  analyst+

  // ── Connector infrastructure ──────────────────────────────────────────────
  const connectorRepo = new PgConnectorInstanceRepository(pool);
  const syncStatusRepo = new PgConnectorSyncStatusRepository(pool);

  // HIGH-SECRETS-01-RESIDUAL: Select ISecretsManager conditionally based on environment.
  //
  // Production:  AwsSecretsManager — fetches the Shopify client secret from AWS Secrets
  //              Manager by ARN. The env var SHOPIFY_CLIENT_SECRET holds the ARN, NOT the
  //              value. IRSA provides credentials (no static AWS keys). Fail-closed: any
  //              Secrets Manager error propagates as a startup/request failure — never falls
  //              back to a plain env read. I-S09 satisfied.
  //
  // Development: LocalSecretsManager — reads SHOPIFY_CLIENT_SECRET from env directly
  //              (the env var holds the raw value in dev, not an ARN). Stores tokens
  //              in-memory only (never in Postgres). Acceptable for local dev.
  //
  // Mirror of the JWT/cookie SecretsProvider selection above.
  const shopifyClientSecretRef = getEnvOrThrow('SHOPIFY_CLIENT_SECRET');
  const connectorSecretsManager = isProduction
    ? new AwsSecretsManager(getEnv('AWS_REGION', 'us-east-1'), shopifyClientSecretRef)
    : new LocalSecretsManager();
  const oauthStateStore = new InProcessOAuthStateStore();

  // DEV-ONLY: validate-sync spike — pull live orders via the real connected token.
  // Mounted only outside production (token crosses the boundary here, I-S09).
  if (nodeEnv !== 'production') {
    registerDevShopifySyncRoutes(app, pool, connectorSecretsManager);
    app.log.warn('[dev] /api/v1/dev/shopify/validate-sync mounted (NODE_ENV != production)');
  }

  const initiateOAuth = new InitiateOAuthCommand(connectorSecretsManager, oauthStateStore);
  const handleCallback = new HandleOAuthCallbackCommand(
    connectorSecretsManager,
    oauthStateStore,
    connectorRepo,
    syncStatusRepo,
    async (_eventName: string, _payload: Record<string, unknown>) => {
      // Event stub: M1 uses in-process logging; async event bus is M2.
      app.log.info({ event: _eventName, payload: _payload }, '[core] domain event emitted');
    },
  );
  const disconnectCommand = new DisconnectCommand(
    connectorRepo,
    syncStatusRepo,
    connectorSecretsManager,
    async (_eventName: string, _payload: Record<string, unknown>) => {
      app.log.info({ event: _eventName, payload: _payload }, '[core] domain event emitted');
    },
  );
  const getConnectorStatus = new GetConnectorStatusQuery(connectorRepo, syncStatusRepo);

  // Shared session preHandler for connector/pixel routes (NN-3).
  const sessionPreHandler = validateSessionPreHandler(authService);

  // Helper to extract brand_id from the authenticated request.
  function getBrandId(req: Parameters<typeof sessionPreHandler>[0]): string {
    const auth = (req as AuthenticatedRequest).auth;
    if (!auth?.brandId) {
      throw Object.assign(new Error('No brand context in JWT'), { statusCode: 400, code: 'NO_BRAND_CONTEXT' });
    }
    return auth.brandId;
  }

  // ── Shopify connector routes (HIGH-MOUNT-01) ─────────────────────────────
  //
  // Route-level guard assignment (guards are passed INTO the route file, which
  // applies them at registration time — self-contained, no deferred comment).
  //
  // The route file (shopifyConnectorRoutes.ts) is owned by the connector builder
  // and accepts a `preHandlers` option. Since it does not currently expose that
  // parameter, we use a wrapper Fastify scope that pre-registers the guards as
  // a scope-level preHandler, then mounts the connector routes inside it.
  //
  // Read routes (GET /connectors, GET /connectors/:id/status) → analyst+
  // Write routes (GET /install → starts OAuth, DELETE /:id) → manager+
  // Callback is PUBLIC — no session guard (Shopify-called, HMAC-protected).
  //
  // Implementation: Fastify scope with selective preHandler per route group.
  // The connector route function registers directly onto the fastify instance it
  // receives, so we give it a scoped instance that already has the preHandlers set.
  //
  // For the callback (public), we register it directly on `app` outside the scope.

  // Register the public callback route FIRST (no session guard — Shopify-called).
  // Only this single route bypasses session validation; HMAC is the auth mechanism (NN-4).
  app.get('/api/v1/connectors/shopify/callback', async (req, reply) => {
    const query = req.query as Record<string, string | string[] | undefined>;
    const requestId = (req.id as string) ?? randomUUID();
    const brandIdParam = typeof query['brand_id'] === 'string' ? query['brand_id'] : null;
    if (!brandIdParam) {
      return reply.code(400).send({
        request_id: requestId,
        error: { code: 'MISSING_BRAND_CONTEXT', message: 'Brand context is required' },
      });
    }
    const state = typeof query['state'] === 'string' ? query['state'] : 'unknown';
    const idempotencyKey = `shopify-oauth-${brandIdParam}-${state}`;
    try {
      const result = await handleCallback.execute({ query, idempotencyKey });
      return reply.code(200).send({
        request_id: requestId,
        data: {
          connector_instance_id: result.connectorInstanceId,
          shop_domain: result.shopDomain,
          status: result.status,
        },
      });
    } catch (err) {
      if (err instanceof HmacValidationError) {
        return reply.code(401).send({ request_id: requestId, error: { code: 'HMAC_INVALID', message: 'Request authentication failed' } });
      }
      if (err instanceof StateNonceError) {
        return reply.code(400).send({ request_id: requestId, error: { code: 'STATE_INVALID', message: 'State parameter is invalid or expired' } });
      }
      if (err instanceof ShopDomainError) {
        return reply.code(400).send({ request_id: requestId, error: { code: 'SHOP_DOMAIN_INVALID', message: (err as Error).message } });
      }
      throw err;
    }
  });

  // Protected read routes (analyst+): GET /connectors, GET /connectors/:id/status
  await app.register(async (scope) => {
    scope.addHook('preHandler', sessionPreHandler);
    scope.addHook('preHandler', requireRole('analyst'));

    scope.get('/api/v1/connectors', async (req, reply) => {
      const brandId = getBrandId(req);
      const status = await getConnectorStatus.execute(brandId);
      return reply.code(200).send({ request_id: (req.id as string) ?? randomUUID(), data: status });
    });

    scope.get('/api/v1/connectors/:id/status', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const brandId = getBrandId(req);
      const status = await getConnectorStatus.execute(brandId);
      return reply.code(200).send({ request_id: (req.id as string) ?? randomUUID(), data: status.shopify });
    });
  });

  // Protected write routes (manager+): GET /install, DELETE /:id
  await app.register(async (scope) => {
    scope.addHook('preHandler', sessionPreHandler);
    scope.addHook('preHandler', requireRole('manager'));

    scope.get('/api/v1/connectors/shopify/install', async (req: FastifyRequest<{ Querystring: { shop: string } }>, reply) => {
      const brandId = getBrandId(req);
      const shopDomain = req.query.shop;
      if (!shopDomain) {
        return reply.code(400).send({ request_id: (req.id as string) ?? randomUUID(), error: { code: 'MISSING_SHOP_PARAM', message: 'shop query parameter is required' } });
      }
      const result = await initiateOAuth.execute({ brandId, shopDomain, callbackUrl: config.shopifyCallbackUrl });
      return reply.code(200).send({ request_id: (req.id as string) ?? randomUUID(), data: { install_url: result.installUrl } });
    });

    scope.delete('/api/v1/connectors/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const brandId = getBrandId(req);
      const idempotencyKey = (req.headers['idempotency-key'] as string | undefined) ?? randomUUID();
      const requestId = (req.id as string) ?? randomUUID();
      try {
        await disconnectCommand.execute({ connectorInstanceId: req.params.id, brandId, idempotencyKey });
        return reply.code(200).send({ request_id: requestId, data: { disconnected: true } });
      } catch (err) {
        if (err instanceof ConnectorNotFoundError) {
          return reply.code(404).send({ request_id: requestId, error: { code: 'CONNECTOR_NOT_FOUND', message: (err as Error).message } });
        }
        throw err;
      }
    });
  });

  // ── Pixel routes (HIGH-MOUNT-01) ───────────────────────────────────────────
  const pixelInstallationRepo = new PgPixelInstallationRepository(pool);
  const pixelStatusRepo = new PgPixelStatusRepository(pool);
  const getOrCreateInstallation = new GetOrCreatePixelInstallationCommand(
    pixelInstallationRepo,
    pixelStatusRepo,
    async (_eventName: string, _payload: Record<string, unknown>) => {
      app.log.info({ event: _eventName, payload: _payload }, '[core] domain event emitted');
    },
  );
  const verifyPixel = new VerifyPixelCommand(
    pixelInstallationRepo,
    pixelStatusRepo,
    async (_eventName: string, _payload: Record<string, unknown>) => {
      app.log.info({ event: _eventName, payload: _payload }, '[core] domain event emitted');
    },
  );
  const getPixelHealth = new GetPixelHealthQuery(pixelInstallationRepo, pixelStatusRepo);

  // Pixel read routes (analyst+): GET /pixel/installation, GET /pixel/health
  await app.register(async (scope) => {
    scope.addHook('preHandler', sessionPreHandler);
    scope.addHook('preHandler', requireRole('analyst'));

    // SEC-0009-M01: GET is READ-ONLY (no write). Returns the existing installation
    // or { installed: false }. Provisioning is the POST below (CSRF-protected).
    scope.get('/api/v1/pixel/installation', async (req, reply) => {
      const brandId = getBrandId(req);
      const requestId = (req.id as string) ?? randomUUID();
      const existing = await pixelInstallationRepo.findByBrandId(brandId);
      if (!existing) {
        return reply.code(200).send({ request_id: requestId, data: { installed: false } });
      }
      const snippet = buildDefaultSnippet(existing.installToken, brandId, config.pixelIngestBaseUrl);
      return reply.code(200).send({
        request_id: requestId,
        data: {
          installed: true,
          installation_id: existing.id,
          install_token: existing.installToken,
          target_host: existing.targetHost,
          snippet_html: snippet,
          is_new: false,
        },
      });
    });

    scope.get('/api/v1/pixel/health', async (req, reply) => {
      const brandId = getBrandId(req);
      const requestId = (req.id as string) ?? randomUUID();
      const health = await getPixelHealth.execute(brandId);
      return reply.code(200).send({ request_id: requestId, data: health });
    });
  });

  // Pixel write routes (manager+): POST /pixel/installation (provision), POST /pixel/verify
  await app.register(async (scope) => {
    scope.addHook('preHandler', sessionPreHandler);
    scope.addHook('preHandler', requireRole('manager'));

    // SEC-0009-M01: provisioning (get-or-create) is a POST — the write path, behind
    // the app-wide CSRF check. Idempotent: returns the existing installation if any.
    scope.post('/api/v1/pixel/installation', async (req: FastifyRequest<{ Body: { target_host?: string } }>, reply) => {
      const brandId = getBrandId(req);
      const requestId = (req.id as string) ?? randomUUID();
      const idempotencyKey = (req.headers['idempotency-key'] as string | undefined) ?? randomUUID();
      const targetHost = (req.body?.target_host ?? '').trim();
      if (!targetHost) {
        return reply.code(400).send({ request_id: requestId, error: { code: 'MISSING_TARGET_HOST', message: 'target_host is required' } });
      }
      const result = await getOrCreateInstallation.execute({ brandId, targetHost, idempotencyKey });
      const snippet = buildDefaultSnippet(result.installToken, brandId, config.pixelIngestBaseUrl);
      return reply.code(result.isNew ? 201 : 200).send({
        request_id: requestId,
        data: { installed: true, installation_id: result.installationId, install_token: result.installToken, target_host: result.targetHost, snippet_html: snippet, is_new: result.isNew },
      });
    });

    scope.post('/api/v1/pixel/verify', async (req, reply) => {
      const brandId = getBrandId(req);
      const requestId = (req.id as string) ?? randomUUID();
      const idempotencyKey = (req.headers['idempotency-key'] as string | undefined) ?? randomUUID();
      try {
        const result = await verifyPixel.execute({ brandId, idempotencyKey });
        return reply.code(200).send({ request_id: requestId, data: { verified: result.verified, state: result.state, message: result.message } });
      } catch (err) {
        if (err instanceof PixelInstallationNotFoundError) {
          return reply.code(404).send({ request_id: requestId, error: { code: 'PIXEL_NOT_INSTALLED', message: (err as Error).message } });
        }
        throw err;
      }
    });
  });

  // Graceful shutdown.
  const shutdown = async () => {
    app.log.info('[core] Shutting down...');
    await app.close();
    await pool.end();
    await rawPgPool.end().catch(() => { /* ignore */ });
    await redis.quit().catch(() => { /* ignore */ });
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Start server.
  try {
    await app.listen({ port: config.port, host: '0.0.0.0' });
    app.log.info({ port: config.port }, '[core] Server listening');
  } catch (err) {
    app.log.fatal({ err }, '[core] Failed to start server');
    process.exit(1);
  }
}

// Entry point.
main().catch((err) => {
  console.error('[core] Fatal startup error:', err);
  process.exit(1);
});
