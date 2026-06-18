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
import fastifyRawBody from 'fastify-raw-body';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { Kafka } from 'kafkajs';

import { createPool } from '@brain/db';
import pg from 'pg';
import { DbAuditWriter } from '@brain/audit';

import { assertArgon2Params, AuthService } from './modules/workspace-access/internal/application/auth.service.js';
import { WorkspaceService } from './modules/workspace-access/internal/application/workspace.service.js';
import { BrandService } from './modules/workspace-access/internal/application/brand.service.js';
import { OnboardingService } from './modules/workspace-access/internal/application/onboarding.service.js';
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
import { PgBackfillJobRepository } from './modules/connector/backfill/infrastructure/PgBackfillJobRepository.js';
import type { BackfillJobProgress } from '@brain/contracts';
import { PgSyncRequestRepository } from './modules/connector/sync/infrastructure/PgSyncRequestRepository.js';
import { RequestConnectorSyncCommand } from './modules/connector/sync/application/commands/RequestConnectorSyncCommand.js';
import { registerShopifyWebhookRoutes } from './modules/connector/sources/storefront/shopify/interfaces/webhooks/shopifyWebhookHandler.js';
import { registerRazorpayWebhookRoutes } from './modules/connector/sources/payment/razorpay/interfaces/webhooks/razorpayWebhookHandler.js';
import { registerShopifyConnectorRoutes } from './modules/connector/sources/storefront/shopify/interfaces/http/shopifyConnectorRoutes.js';
import { registerDevShopifySyncRoutes } from './modules/connector/sources/storefront/shopify/interfaces/http/devShopifySyncRoutes.js';
import { registerPixelRoutes, buildDefaultSnippet } from './modules/connector/pixel/interfaces/http/pixelRoutes.js';
// Connector catalog + dispatch (A3 — feat-connector-marketplace)
import { getDefinition, isConnectable, CONNECTOR_CATALOG } from './modules/connector/catalog/index.js';
import { registerOAuthDispatch, getOAuthDispatch } from './modules/connector/catalog/dispatch.js';
import { InitiateOAuthCommand } from './modules/connector/sources/storefront/shopify/application/commands/InitiateOAuthCommand.js';
import { ConnectorInstance as ConnectorInstanceEntity } from './modules/connector/sources/storefront/shopify/domain/entities/ConnectorInstance.js';
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
// ── Advertising OAuth connectors (feat-ad-connectors Track 1) ─────────────────
import { InitiateMetaOAuthCommand } from './modules/connector/sources/advertising/meta/application/commands/InitiateMetaOAuthCommand.js';
import { HandleMetaOAuthCallbackCommand } from './modules/connector/sources/advertising/meta/application/commands/HandleMetaOAuthCallbackCommand.js';
import {
  registerMetaInstallRoute,
  registerMetaCallbackRoute,
} from './modules/connector/sources/advertising/meta/interfaces/http/metaConnectorRoutes.js';
import { InitiateGoogleAdsOAuthCommand } from './modules/connector/sources/advertising/google/application/commands/InitiateGoogleAdsOAuthCommand.js';
import { HandleGoogleAdsOAuthCallbackCommand } from './modules/connector/sources/advertising/google/application/commands/HandleGoogleAdsOAuthCallbackCommand.js';
import {
  registerGoogleAdsInstallRoute,
  registerGoogleAdsCallbackRoute,
} from './modules/connector/sources/advertising/google/interfaces/http/googleAdsConnectorRoutes.js';
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
import { requireVerifiedEmail } from './modules/workspace-access/internal/security/email-verified.guard.js';
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
    // ADR-CM-3: generic callback path — brand_id from signed state only (D-1)
    shopifyCallbackUrl: getEnv(
      'SHOPIFY_CALLBACK_URL',
      'http://localhost:3001/api/v1/oauth/callback/shopify',
    ),
    // feat-ad-connectors Track 1 — ads OAuth callbacks (public HTTPS URL in prod; dev = localhost).
    // The repull/exchange reads these from the same env vars (META_CALLBACK_URL / GOOGLE_ADS_CALLBACK_URL).
    metaCallbackUrl: getEnv(
      'META_CALLBACK_URL',
      'http://localhost:3001/api/v1/connectors/meta/callback',
    ),
    googleAdsCallbackUrl: getEnv(
      'GOOGLE_ADS_CALLBACK_URL',
      'http://localhost:3001/api/v1/connectors/google_ads/callback',
    ),
    pixelIngestBaseUrl: getEnv('PIXEL_INGEST_BASE_URL', 'http://localhost:3001'),
    // Webhook live-lane Kafka config (B1 / ADR-LV-3)
    kafkaBrokers: (getEnv('KAFKA_BROKERS', 'localhost:9092')).split(','),
    kafkaEnv: getEnv('APP_ENV', 'dev'),
    // Webhook registration callback base URL (B2 / ADR-LV-5 — public URL in prod)
    webhookCallbackBaseUrl: getEnv('WEBHOOK_CALLBACK_BASE_URL', 'http://localhost:3001'),
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

  // Register raw-body plugin (D-2 / ADR-LV-2) — MUST be registered before webhook routes.
  // Captures the raw Buffer on routes that declare `config: { rawBody: true }`.
  // Required for Shopify webhook HMAC validation (HMAC over the raw body bytes — NN-4).
  // global: false — only captures raw body on routes that opt-in (performance).
  await app.register(fastifyRawBody as unknown as Parameters<typeof app.register>[0], {
    field: 'rawBody',
    global: false,
    encoding: false, // return Buffer (not a string) — HMAC requires bytes
    runFirst: true,  // run before JSON body parsing so rawBody is available
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
        path === '/api/v1/bff/register' || // register + auto-login — establishes the session
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

  // Pixel provision wiring (ADR-4): construct the idempotent installation command
  // BEFORE BrandService so brand-create-with-website can auto-provision the per-brand
  // pixel_installation server-side. brandId flows ONLY from the just-written brand.id.
  const pixelInstallationRepo = new PgPixelInstallationRepository(pool);
  const pixelStatusRepo = new PgPixelStatusRepository(pool);
  const getOrCreateInstallation = new GetOrCreatePixelInstallationCommand(
    pixelInstallationRepo,
    pixelStatusRepo,
    async (eventName: string, payload: Record<string, unknown>) => {
      app.log.info({ event: eventName, payload }, '[core] domain event emitted');
    },
  );

  const brandService = new BrandService(
    pool,
    auditWriter,
    async (brandId, targetHost, idempotencyKey) => {
      await getOrCreateInstallation.execute({ brandId, targetHost, idempotencyKey });
    },
  );
  const inviteService = new InviteService(pool, auditWriter, notificationService, rawPgPool);

  // feat-onboarding-ux (D3): merged workspace+brand provisioning. Reuses the SAME
  // pixel provisioner injected into BrandService so the website→pixel path is not
  // regressed; runs the org+brand inserts in one rawPgPool BEGIN/COMMIT transaction.
  const onboardingService = new OnboardingService(
    pool,
    rawPgPool,
    auditWriter,
    async (brandId, targetHost, idempotencyKey) => {
      await getOrCreateInstallation.execute({ brandId, targetHost, idempotencyKey });
    },
  );

  // Register workspace-access + BFF routes.
  registerAuthRoutes(app, authService, rateLimiter);
  registerWorkspaceRoutes(app, authService, workspaceService);
  registerBrandRoutes(app, authService, brandService);
  registerMemberRoutes(app, authService, inviteService, rawPgPool);
  registerBffRoutes(app, authService, pool, config.cookieSecret, rateLimiter, rawPgPool, onboardingService);

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
  // D-7/ADR-CM-4: CONNECTOR_SECRETS_KMS_KEY_ID must be set in production — the ARN or
  // alias of the customer-managed KMS key used for per-brand EncryptionContext isolation.
  // Hard-fail at startup if absent (mirrors LocalSecretsManager's prod-hard-fail pattern).
  if (isProduction && !process.env['CONNECTOR_SECRETS_KMS_KEY_ID']) {
    throw new Error(
      '[core] FATAL: CONNECTOR_SECRETS_KMS_KEY_ID must be set in production. ' +
        'AwsSecretsManager requires a customer-managed KMS key ARN/alias for per-brand ' +
        'EncryptionContext isolation (D-7/ADR-CM-4). Set the env var and restart.',
    );
  }
  const connectorKmsKeyId = getEnv('CONNECTOR_SECRETS_KMS_KEY_ID', 'alias/brain-connector-secrets-dev');
  const connectorSecretsManager = isProduction
    ? new AwsSecretsManager(getEnv('AWS_REGION', 'us-east-1'), shopifyClientSecretRef, connectorKmsKeyId)
    // DEV-TOKEN-REACH (0024): pass rawPgPool so dev tokens persist to dev_secret —
    // durable across core restarts and readable by the separate stream-worker process.
    : new LocalSecretsManager(rawPgPool);
  const oauthStateStore = new InProcessOAuthStateStore();

  // ── B1: Shopify webhook receiver (ADR-LV-1..4) ───────────────────────────────
  // Kafka producer for the live lane (direct produce to dev.collector.event.v1 — ADR-LV-3).
  // The producer is connected ONCE at startup and reused across all webhook requests.
  const webhookKafka = new Kafka({
    clientId: 'core-webhook-receiver',
    brokers: config.kafkaBrokers,
    retry: { retries: 3 },
  });
  const webhookProducer = webhookKafka.producer();
  await webhookProducer.connect();
  const liveTopic = `${config.kafkaEnv}.collector.event.v1`;

  // Per-brand salt for PII hashing in the webhook receiver.
  // Mirrors the SaltProvider pattern from stream-worker: env var IDENTITY_SALT_<BRAND_UUID_NO_DASHES>.
  async function getWebhookSaltHex(brandId: string): Promise<string> {
    const envKey = `IDENTITY_SALT_${brandId.replace(/-/g, '').toUpperCase()}`;
    const salt = process.env[envKey] ?? '';
    if (!salt || salt.length !== 64) {
      throw new Error(
        `[webhook] salt for brand ${brandId} is missing or wrong length (expected 64 hex chars)`,
      );
    }
    return salt;
  }

  // Register Shopify webhook routes (PUBLIC — HMAC-protected, exempt from session guard).
  // The CSRF middleware at the onRequest hook already exempts /api/v1/webhooks/ paths.
  registerShopifyWebhookRoutes(app, {
    secretsManager: connectorSecretsManager,
    rawPgPool,
    producer: webhookProducer,
    liveTopic,
    getSaltHex: getWebhookSaltHex,
  });

  app.log.info({ topic: liveTopic }, '[core] Shopify webhook receiver registered (B1)');

  // ── B1: Razorpay webhook receiver (ADR-RZ-7 / C2 / C3 / MB-1) ───────────────
  // PUBLIC route — HMAC-protected (NN-4); exempt from session guard + CSRF middleware.
  // CSRF middleware already exempts /api/v1/webhooks/ paths (see onRequest hook above).
  registerRazorpayWebhookRoutes(app, {
    secretsManager: connectorSecretsManager,
    rawPgPool,
    producer: webhookProducer,
    liveTopic,
    getSaltHex: getWebhookSaltHex,
    redis,
  });

  app.log.info({ topic: liveTopic }, '[core] Razorpay webhook receiver registered (ADR-RZ-7)');

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

  // ── Advertising OAuth connectors (feat-ad-connectors Track 1) ──────────────
  // setAdAccountId: persists ad_account_id onto connector_instance via a brand-scoped
  // direct UPDATE (mirrors how razorpay_account_id is set — kept out of the generic repo).
  const setAdAccountId = async (
    brandId: string,
    connectorInstanceId: string,
    adAccountId: string,
  ): Promise<void> => {
    const client = await rawPgPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_brand_id', $1, true)`, [brandId]);
      await client.query(
        `UPDATE connector_instance SET ad_account_id = $1 WHERE id = $2 AND brand_id = $3`,
        [adAccountId, connectorInstanceId, brandId],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  };

  const emitConnectorEvent = async (eventName: string, payload: Record<string, unknown>): Promise<void> => {
    app.log.info({ event: eventName, payload }, '[core] domain event emitted');
  };

  const initiateMetaOAuth = new InitiateMetaOAuthCommand(oauthStateStore);
  const handleMetaCallback = new HandleMetaOAuthCallbackCommand(
    connectorSecretsManager,
    oauthStateStore,
    connectorRepo,
    syncStatusRepo,
    emitConnectorEvent,
    setAdAccountId,
  );
  const initiateGoogleAdsOAuth = new InitiateGoogleAdsOAuthCommand(oauthStateStore);
  const handleGoogleAdsCallback = new HandleGoogleAdsOAuthCallbackCommand(
    connectorSecretsManager,
    oauthStateStore,
    connectorRepo,
    syncStatusRepo,
    emitConnectorEvent,
    setAdAccountId,
  );

  // Audit hook for a successful ads OAuth connect (brandId is state-derived — D-1).
  const auditAdConnected =
    (connectorType: 'meta' | 'google_ads') =>
    async (brandId: string, connectorInstanceId: string): Promise<void> => {
      await auditWriter.append({
        brand_id: brandId,
        actor_id: null,
        actor_role: 'system',
        action: 'connector.connected',
        entity_type: 'connector_instance',
        entity_id: connectorInstanceId,
        payload: { connector_type: connectorType },
        // NO secret_ref, NO token in payload (I-S02 / I-S09)
      });
    };

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

  // ── OAUTH_DISPATCH_TABLE registration (A3 — ADR-CM-3) ─────────────────────
  // Shopify InitiateOAuthCommand registered under 'shopify' key.
  // meta/google_ads are NOT registered (coming_soon → 422 before dispatch reaches here).
  registerOAuthDispatch('shopify', {
    initiate: async ({ brandId, shopDomain, callbackUrl }) => {
      if (!shopDomain) {
        throw Object.assign(new Error('shop_domain is required for shopify OAuth'), {
          code: 'MISSING_SHOP_DOMAIN',
          statusCode: 400,
        });
      }
      const result = await initiateOAuth.execute({ brandId, shopDomain, callbackUrl });
      return { oauth_url: result.installUrl };
    },
  });

  // ── Ads OAuth dispatch (feat-ad-connectors Track 1 / ADR-AD-2) ─────────────
  // No shopDomain. The provider-specific callbackUrl is bound from config (the generic
  // POST /api/v1/connectors route passes the shopify callbackUrl, which ads ignore).
  registerOAuthDispatch('meta', {
    initiate: async ({ brandId }) => {
      const result = await initiateMetaOAuth.execute({
        brandId,
        callbackUrl: config.metaCallbackUrl,
      });
      return { oauth_url: result.installUrl };
    },
  });
  registerOAuthDispatch('google_ads', {
    initiate: async ({ brandId }) => {
      const result = await initiateGoogleAdsOAuth.execute({
        brandId,
        callbackUrl: config.googleAdsCallbackUrl,
      });
      return { oauth_url: result.installUrl };
    },
  });

  // ── Ads OAuth callback routes (PUBLIC — state nonce is the auth, ADR-AD-2) ──
  // Mounted directly on the app, outside the authenticated scope. These live in the
  // connector module (mirror shopifyConnectorRoutes) and do NOT touch bff.routes.ts.
  registerMetaCallbackRoute(app, {
    initiateOAuth: initiateMetaOAuth,
    handleCallback: handleMetaCallback,
    getBrandId: () => {
      throw new Error('getBrandId is not used on the public callback route');
    },
    callbackUrl: config.metaCallbackUrl,
    appBaseUrl: config.appBaseUrl,
    onConnected: auditAdConnected('meta'),
  });
  registerGoogleAdsCallbackRoute(app, {
    initiateOAuth: initiateGoogleAdsOAuth,
    handleCallback: handleGoogleAdsCallback,
    getBrandId: () => {
      throw new Error('getBrandId is not used on the public callback route');
    },
    callbackUrl: config.googleAdsCallbackUrl,
    appBaseUrl: config.appBaseUrl,
    onConnected: auditAdConnected('google_ads'),
  });

  // ── Generic OAuth callback (ADR-CM-3 / D-1) ───────────────────────────────
  // REPLACES the divergent main.ts:422 handler that read brand_id from query.
  // brand_id is derived EXCLUSIVELY from consumeAndGetBrandId(state) — D-1.
  // The :type param dispatches to the correct command (shopify only in M1).
  //
  // PUBLIC route (no session guard) — HMAC is the auth mechanism (NN-4).
  // idempotencyKey does NOT include brand_id (unknown pre-state-consume — ADR-CM-3).
  app.get('/api/v1/oauth/callback/:type', async (req: FastifyRequest<{ Params: { type: string } }>, reply) => {
    const query = req.query as Record<string, string | string[] | undefined>;
    const requestId = (req.id as string) ?? randomUUID();
    const connectorType = req.params.type;
    const state = typeof query['state'] === 'string' ? query['state'] : 'unknown';
    // ADR-CM-3: idempotency key does NOT include brand_id (not yet known)
    const idempotencyKey = `${connectorType}-oauth-${state}`;

    try {
      // Dispatch to the type-specific callback command
      // For Shopify: HandleOAuthCallbackCommand (HMAC-first, brand from state — NN-4 / D-1)
      let result: { connectorInstanceId: string; shopDomain: string; status: string };
      if (connectorType === 'shopify') {
        const cbResult = await handleCallback.execute({ query, idempotencyKey });
        result = {
          connectorInstanceId: cbResult.connectorInstanceId,
          shopDomain: cbResult.shopDomain,
          status: cbResult.status,
        };
        // Audit: connector.connected (D-11 / Sec-C4)
        // brandId from cbResult is state-derived (D-1 — never from query)
        await auditWriter.append({
          brand_id: cbResult.brandId,
          actor_id: null,
          actor_role: 'system',
          action: 'connector.connected',
          entity_type: 'connector_instance',
          entity_id: result.connectorInstanceId,
          payload: { connector_type: connectorType },
          // NO secret_ref, NO token in payload (I-S02/I-S09)
        });
      } else {
        // Browser-facing callback → redirect back to the marketplace with an error, not JSON.
        return reply.redirect(`${config.appBaseUrl}/settings/connectors?connect_error=unknown_connector`);
      }

      // SUCCESS: redirect the browser back to the marketplace (good UX) instead of returning raw
      // JSON. The connectors page refetches and the tile flips to Connected. requestId is logged.
      req.log?.info({ requestId, connectorType, connectorInstanceId: result.connectorInstanceId }, 'oauth callback success');
      return reply.redirect(`${config.appBaseUrl}/settings/connectors?connected=${encodeURIComponent(connectorType)}`);
    } catch (err) {
      // Browser-facing: always land back on the connectors page with an error code (no JSON page).
      let code = 'unexpected';
      if (err instanceof HmacValidationError) code = 'auth_failed';
      else if (err instanceof StateNonceError) code = 'state_invalid';
      else if (err instanceof ShopDomainError) code = 'shop_invalid';
      else req.log?.error({ requestId, err }, 'oauth callback unexpected error'); // keep unexpected errors visible
      return reply.redirect(`${config.appBaseUrl}/settings/connectors?connect_error=${code}`);
    }
  });

  // ── Connector read routes (analyst+) ────────────────────────────────────────
  // GET /api/v1/connectors → marketplace list (catalog ⨝ instance, ADR-CM-1/ADR-CM-8)
  // GET /api/v1/connectors/:id/status → legacy per-connector status
  await app.register(async (scope) => {
    scope.addHook('preHandler', sessionPreHandler);
    scope.addHook('preHandler', requireRole('analyst'));

    // Marketplace catalog⨝instance list (A3 — ADR-CM-1/ADR-CM-8/D-10)
    scope.get('/api/v1/connectors', async (req, reply) => {
      const brandId = getBrandId(req);
      const requestId = (req.id as string) ?? randomUUID();
      // Fetch all connector instances for this brand (RLS enforced)
      const instances = await connectorRepo.findAllByBrand(brandId);
      const instanceByProvider = new Map(instances.map((i) => [i.provider, i]));

      // Join catalog with instance data → MarketplaceTile[]
      const tiles = CONNECTOR_CATALOG.map((def) => {
        // A 'disconnected' instance row persists for audit, but the marketplace must present it
        // as NOT connected (clean Connect button) — never as a connected/failing tile. Only an
        // ACTIVE instance attaches to the tile; a disconnected one renders as connectable again.
        const found = instanceByProvider.get(def.id);
        const instance = found && found.status !== 'disconnected' ? found : null;
        return {
          id: def.id,
          category: def.category,
          display_name: def.displayName,
          description: def.description,
          connect_method: def.connectMethod as 'oauth' | 'credential' | 'coming_soon',
          available: def.availability === 'available',
          // NN-2: NO secret_ref, NO token in this response (success criterion #4)
          instance: instance
            ? {
                id: instance.id,
                status: instance.status,
                health_state: instance.healthState,
                safety_rating: instance.safetyRating,
                shop_domain: instance.shopDomain || null,
                connected_at: instance.connectedAt.toISOString(),
              }
            : null,
        };
      });

      return reply.code(200).send({ request_id: requestId, data: { tiles } });
    });

    scope.get('/api/v1/connectors/:id/status', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const requestId = (req.id as string) ?? randomUUID();
      const brandId = getBrandId(req);
      const id = req.params.id;

      // Back-compat: the legacy Shopify dashboard calls this with id='shopify'
      // (or any non-UUID). Return the provider-resolved Shopify view (unchanged).
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
      if (!isUuid) {
        const status = await getConnectorStatus.execute(brandId);
        return reply.code(200).send({ request_id: requestId, data: status.shopify });
      }

      // feat-connector-sync-now §4: per-connector status by connector_instance_id
      // (any provider). Real connector_sync_status row — never simulated.
      const view = await getConnectorStatus.executeForConnector(id, brandId);
      if (!view) {
        return reply.code(404).send({
          request_id: requestId,
          error: { code: 'CONNECTOR_NOT_FOUND', message: 'Connector not found for this brand.' },
        });
      }

      return reply.code(200).send({
        request_id: requestId,
        data: {
          id: view.connectorInstanceId,
          provider: view.provider,
          status: view.status,
          sync_state: view.syncState,
          last_sync_at: view.lastSyncAt,
          last_error: view.lastError,
        },
      });
    });
  });

  // ── Connector write routes (manager+) ────────────────────────────────────────
  // POST /api/v1/connectors  → generic connect (ADR-CM-2)
  // GET  /api/v1/connectors/shopify/install  → legacy Shopify install path
  // DELETE /api/v1/connectors/:id → disconnect (ADR-CM-5 + Sec-C4 audit)
  await app.register(async (scope) => {
    scope.addHook('preHandler', sessionPreHandler);
    scope.addHook('preHandler', requireRole('manager'));
    // feat-onboarding-ux (Deliverable 2): connecting a real store is a sensitive
    // action — block unverified users server-side (403 EMAIL_NOT_VERIFIED). Runs AFTER
    // session + role. Covers POST /api/v1/connectors (generic connect → OAuth initiate),
    // GET /api/v1/connectors/shopify/install, and the ads install routes in this scope.
    // The public OAuth callbacks live in a different (state/HMAC-authed) scope → ungated.
    scope.addHook('preHandler', requireVerifiedEmail(authService));

    // Generic connect (ADR-CM-2 / D-5 / D-10)
    scope.post('/api/v1/connectors', async (req: FastifyRequest<{ Body: { type?: string; shop_domain?: string; credentials?: Record<string, string> } }>, reply) => {
      const brandId = getBrandId(req);
      const auth = (req as typeof req & { auth?: { userId?: string; role?: string } }).auth;
      const requestId = (req.id as string) ?? randomUUID();
      const body = req.body ?? {};
      const connectorType = body.type;

      if (!connectorType) {
        return reply.code(400).send({ request_id: requestId, error: { code: 'MISSING_CONNECTOR_TYPE', message: 'type is required' } });
      }

      // 1. Catalog lookup (unknown type ⇒ 400 — Int-C3)
      const def = getDefinition(connectorType);
      if (!def) {
        return reply.code(400).send({ request_id: requestId, error: { code: 'UNKNOWN_CONNECTOR_TYPE', message: `Unknown connector type: ${connectorType}` } });
      }

      // 2. Coming-soon gate ⇒ 422 (Sec-C5 / D-5 / success criterion #2)
      if (!isConnectable(def)) {
        return reply.code(422).send({ request_id: requestId, error: { code: 'CONNECTOR_NOT_AVAILABLE', message: `${def.displayName} is not yet available for connection.` } });
      }

      // 3a. OAuth connector
      if (def.connectMethod === 'oauth') {
        const dispatch = getOAuthDispatch(connectorType);
        if (!dispatch) {
          return reply.code(422).send({ request_id: requestId, error: { code: 'CONNECTOR_NOT_AVAILABLE', message: `OAuth not configured for ${connectorType}` } });
        }
        try {
          const { oauth_url } = await dispatch.initiate({
            brandId,
            shopDomain: body.shop_domain,
            callbackUrl: config.shopifyCallbackUrl,
          });
          // Audit: connect initiated (actor from auth)
          await auditWriter.append({
            brand_id: brandId,
            actor_id: auth?.userId ?? null,
            actor_role: auth?.role ?? 'unknown',
            action: 'connector.connected',
            entity_type: 'connector_instance',
            entity_id: `${connectorType}:${brandId}`,
            payload: { connector_type: connectorType, phase: 'oauth_initiated' },
          });
          return reply.code(200).send({ request_id: requestId, data: { kind: 'oauth', oauth_url } });
        } catch (err) {
          if ((err as { code?: string }).code === 'MISSING_SHOP_DOMAIN') {
            return reply.code(400).send({ request_id: requestId, error: { code: 'MISSING_SHOP_DOMAIN', message: (err as Error).message } });
          }
          // Dev boundary: the OAuth app for this provider (e.g. Meta/Google Ads) isn't
          // configured. Fail gracefully (503 + friendly message the UI toasts), not a 500.
          if ((err as { code?: string }).code === 'OAUTH_NOT_CONFIGURED') {
            return reply.code(503).send({ request_id: requestId, error: { code: 'OAUTH_NOT_CONFIGURED', message: (err as Error).message } });
          }
          throw err;
        }
      }

      // 3b. Credential connector
      if (def.connectMethod === 'credential') {
        const credentials = body.credentials;
        if (!credentials || Object.keys(credentials).length === 0) {
          return reply.code(400).send({ request_id: requestId, error: { code: 'MISSING_CREDENTIALS', message: 'credentials are required for credential connectors' } });
        }

        // ── Razorpay credential connector (C2 / ADR-RZ-8) ─────────────────
        // Requires: key_id, key_secret, webhook_secret, razorpay_account_id.
        // razorpay_account_id is stored on connector_instance (NOT in the secret bundle —
        // it is a merchant identifier, not a secret) and used by
        // resolve_razorpay_connector_by_account() for webhook brand resolution (ADR-RZ-7).
        if (connectorType === 'razorpay') {
          const keyId = credentials['key_id'];
          const keySecret = credentials['key_secret'];
          const webhookSecret = credentials['webhook_secret'];
          const razorpayAccountId = credentials['razorpay_account_id'];

          if (!keyId || !keySecret || !webhookSecret || !razorpayAccountId) {
            return reply.code(400).send({
              request_id: requestId,
              error: {
                code: 'MISSING_RAZORPAY_CREDENTIALS',
                message: 'razorpay connector requires: key_id, key_secret, webhook_secret, razorpay_account_id',
              },
            });
          }

          // Store composite bundle (C2 — ONE secret_ref, webhook_secret independently rotatable)
          // I-S09: subKey = razorpayAccountId (merchant ID, not secret)
          const { arn } = await connectorSecretsManager.storeSecret(
            brandId,
            { connectorType: 'razorpay', subKey: razorpayAccountId },
            { key_id: keyId, key_secret: keySecret, webhook_secret: webhookSecret },
          );

          const now = new Date();
          const connectorInstanceId = randomUUID();
          const instance = ConnectorInstanceEntity.create({
            id: connectorInstanceId,
            brandId,
            provider: 'razorpay',
            shopDomain: '',
            secretRef: arn,
            status: 'connected',
            healthState: 'Healthy',
            safetyRating: 'safe',
            connectedAt: now,
            disconnectedAt: null,
            createdAt: now,
            updatedAt: now,
          });
          await connectorRepo.save(instance);

          // Set razorpay_account_id on connector_instance (migration 0027 column)
          // Required by resolve_razorpay_connector_by_account() for webhook brand resolution.
          const rzClient = await rawPgPool.connect();
          try {
            await rzClient.query('BEGIN');
            await rzClient.query(`SELECT set_config('app.current_brand_id', $1, true)`, [brandId]);
            await rzClient.query(
              `UPDATE connector_instance SET razorpay_account_id = $1 WHERE id = $2 AND brand_id = $3`,
              [razorpayAccountId, connectorInstanceId, brandId],
            );
            await rzClient.query('COMMIT');
          } catch (rzErr) {
            await rzClient.query('ROLLBACK').catch(() => undefined);
            throw rzErr;
          } finally {
            rzClient.release();
          }

          await auditWriter.append({
            brand_id: brandId,
            actor_id: auth?.userId ?? null,
            actor_role: auth?.role ?? 'unknown',
            action: 'connector.connected',
            entity_type: 'connector_instance',
            entity_id: connectorInstanceId,
            payload: { connector_type: 'razorpay' },
            // NO key_id, NO key_secret, NO webhook_secret in payload (I-S09)
          });
          return reply.code(200).send({
            request_id: requestId,
            data: { kind: 'credential', connected: true, connector_instance_id: connectorInstanceId },
          });
        }

        // Generic credential connector path (non-Razorpay — kept for future connectors)
        const { arn } = await connectorSecretsManager.storeSecret(brandId, { connectorType }, credentials);
        const now = new Date();
        const instance = ConnectorInstanceEntity.create({
          id: randomUUID(),
          brandId,
          provider: connectorType,
          shopDomain: '',
          secretRef: arn,
          status: 'connected',
          healthState: 'Healthy',
          safetyRating: 'safe',
          connectedAt: now,
          disconnectedAt: null,
          createdAt: now,
          updatedAt: now,
        });
        await connectorRepo.save(instance);
        await auditWriter.append({
          brand_id: brandId,
          actor_id: auth?.userId ?? null,
          actor_role: auth?.role ?? 'unknown',
          action: 'connector.connected',
          entity_type: 'connector_instance',
          entity_id: instance.id,
          payload: { connector_type: connectorType },
        });
        return reply.code(200).send({ request_id: requestId, data: { kind: 'credential', connected: true } });
      }

      return reply.code(422).send({ request_id: requestId, error: { code: 'CONNECTOR_NOT_AVAILABLE', message: 'Connector type not available' } });
    });

    // Legacy Shopify install path (kept for back-compat; routes through same initiateOAuth)
    scope.get('/api/v1/connectors/shopify/install', async (req: FastifyRequest<{ Querystring: { shop: string } }>, reply) => {
      const brandId = getBrandId(req);
      const shopDomain = req.query.shop;
      if (!shopDomain) {
        return reply.code(400).send({ request_id: (req.id as string) ?? randomUUID(), error: { code: 'MISSING_SHOP_PARAM', message: 'shop query parameter is required' } });
      }
      const result = await initiateOAuth.execute({ brandId, shopDomain, callbackUrl: config.shopifyCallbackUrl });
      return reply.code(200).send({ request_id: (req.id as string) ?? randomUUID(), data: { install_url: result.installUrl } });
    });

    // ── Ads install routes (manager+ — feat-ad-connectors Track 1) ──────────
    // Return oauth_url + set the brand-bound state nonce. The connector module owns
    // these route files (mirror shopifyConnectorRoutes); no bff.routes.ts edit.
    registerMetaInstallRoute(scope, {
      initiateOAuth: initiateMetaOAuth,
      handleCallback: handleMetaCallback,
      getBrandId: (req) => getBrandId(req as Parameters<typeof getBrandId>[0]),
      callbackUrl: config.metaCallbackUrl,
      appBaseUrl: config.appBaseUrl,
    });
    registerGoogleAdsInstallRoute(scope, {
      initiateOAuth: initiateGoogleAdsOAuth,
      handleCallback: handleGoogleAdsCallback,
      getBrandId: (req) => getBrandId(req as Parameters<typeof getBrandId>[0]),
      callbackUrl: config.googleAdsCallbackUrl,
      appBaseUrl: config.appBaseUrl,
    });

    // Generic disconnect (ADR-CM-3 / Sec-C3 / Sec-C4 audit)
    scope.delete('/api/v1/connectors/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const brandId = getBrandId(req);
      const auth = (req as typeof req & { auth?: { userId?: string; role?: string } }).auth;
      const idempotencyKey = (req.headers['idempotency-key'] as string | undefined) ?? randomUUID();
      const requestId = (req.id as string) ?? randomUUID();
      try {
        await disconnectCommand.execute({ connectorInstanceId: req.params.id, brandId, idempotencyKey });
        // Audit: connector.disconnected (D-11 / Sec-C4)
        await auditWriter.append({
          brand_id: brandId,
          actor_id: auth?.userId ?? null,
          actor_role: auth?.role ?? 'unknown',
          action: 'connector.disconnected',
          entity_type: 'connector_instance',
          entity_id: req.params.id,
          payload: { connector_instance_id: req.params.id },
          // NO secret_ref, NO token in payload (I-S02/I-S09)
        });
        return reply.code(200).send({ request_id: requestId, data: { disconnected: true } });
      } catch (err) {
        if (err instanceof ConnectorNotFoundError) {
          return reply.code(404).send({ request_id: requestId, error: { code: 'CONNECTOR_NOT_FOUND', message: (err as Error).message } });
        }
        throw err;
      }
    });
  });

  // ── Backfill routes (brand_admin+ — ADR-BF-2/3/4/7/9/15) ───────────────────
  //
  // POST /api/v1/connectors/:id/backfill  (B1 — trigger, ADR-BF-3)
  //   1. Load connector_instance (brand-scoped, NN-1 RLS).
  //   2. getSecret(secret_ref) — null => 409 RECONNECT_REQUIRED (D-7).
  //   3. Overlap-lock SELECT FOR UPDATE SKIP LOCKED => 409 BACKFILL_ALREADY_RUNNING (D-9/HP-2).
  //   4. INSERT backfill_job status=queued.
  //   5. Audit connector.backfill.requested (NO secret/token in payload — I-S09).
  //   6. 202 {request_id, data: {job_id, status:'queued'}}
  //
  // GET  /api/v1/connectors/:id/jobs      (B2 — progress, ADR-BF-4)
  //   findLatestForConnector => BackfillJobProgress (percent=null when estimated_total null — D-8).
  //
  // Guard: brand_admin+ (D-15). Manager => 403 (non-inert negative control).
  // brand_id from JWT session, NEVER from request body (ADR-BF-13 / MT-1).
  // NO secret_ref / token in any response (I-S09).
  const backfillJobRepo = new PgBackfillJobRepository(pool);

  // ── On-demand "Sync now" trigger (feat-connector-sync-now) ──────────────────
  // Enqueues an INCREMENTAL trailing-window re-pull request for one connector;
  // the in-worker claimer dispatches the SAME run() the scheduler invokes (same
  // code path). Overlap-locked (run()'s own FOR UPDATE SKIP LOCKED) + spam-safe
  // (sentinel-row dedup). brand_admin+ only; brand_id from session, never the body.
  const syncRequestRepo = new PgSyncRequestRepository(pool);
  const requestConnectorSync = new RequestConnectorSyncCommand(
    connectorRepo,
    connectorSecretsManager,
    syncRequestRepo,
    auditWriter,
  );

  await app.register(async (scope) => {
    scope.addHook('preHandler', sessionPreHandler);
    // Scope minimum is MANAGER (sync = Owner/Brand-Admin/Manager per the data-ingestion
    // spec — sync is lower-risk than backfill). Backfill routes below re-tighten to
    // brand_admin+ via a per-route preHandler, so only "Sync now" gains Manager.
    scope.addHook('preHandler', requireRole('manager'));

    // ── POST /api/v1/connectors/:id/sync — "Sync now" (feat-connector-sync-now) ─
    // Owner/Brand-Admin/Manager (Analyst → 403 + UI-hidden);
    // brand_id from session (MT-1); token check → 409 RECONNECT_REQUIRED;
    // overlap pre-checks → 409 SYNC_ALREADY_RUNNING / SYNC_ALREADY_REQUESTED;
    // enqueue sentinel request; audit connector.sync.requested; 202 {status:'syncing'}.
    scope.post('/api/v1/connectors/:id/sync', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const requestId = (req.id as string) ?? randomUUID();
      const brandId = getBrandId(req);
      const connectorInstanceId = req.params.id;
      const auth = (req as typeof req & { auth?: { userId?: string; role?: string } }).auth;

      const result = await requestConnectorSync.execute({
        connectorInstanceId,
        brandId,
        correlationId: requestId,
        actorId: auth?.userId ?? null,
        actorRole: auth?.role ?? 'unknown',
      });

      if (!result.ok) {
        const httpCode = result.code === 'CONNECTOR_NOT_FOUND' ? 404 : 409;
        return reply.code(httpCode).send({
          request_id: requestId,
          error: { code: result.code, message: result.message },
        });
      }

      return reply.code(202).send({
        request_id: requestId,
        data: {
          connector_instance_id: result.connectorInstanceId,
          status: result.status,
          requested_at: result.requestedAt,
        },
      });
    });

    // B1 — Backfill trigger (ADR-BF-3). Re-tighten to brand_admin+ (Manager → 403):
    // backfill stays Owner/Brand-Admin only, unlike the Manager-allowed sync above.
    scope.post<{ Params: { id: string } }>('/api/v1/connectors/:id/backfill', { preHandler: requireRole('brand_admin') }, async (req, reply) => {
      const requestId = (req.id as string) ?? randomUUID();
      const brandId = getBrandId(req);
      const connectorInstanceId = req.params.id;
      const auth = (req as typeof req & { auth?: { userId?: string; role?: string } }).auth;

      // Step 1: Load connector_instance (brand-scoped via RLS — NN-1).
      const connectorInstance = await connectorRepo.findById(connectorInstanceId, brandId);
      if (!connectorInstance) {
        return reply.code(404).send({
          request_id: requestId,
          error: { code: 'CONNECTOR_NOT_FOUND', message: 'Connector not found for this brand.' },
        });
      }

      // Step 2: getSecret(secret_ref) — if null => 409 RECONNECT_REQUIRED (D-7).
      // NO token value is ever logged or included in any response (I-S09).
      const secret = await connectorSecretsManager.getSecret(connectorInstance.secretRef);
      if (secret === null) {
        return reply.code(409).send({
          request_id: requestId,
          error: {
            code: 'RECONNECT_REQUIRED',
            message: 'Your Shopify connection has expired. Please reconnect the store before backfilling.',
          },
        });
      }

      // Step 3: Overlap-lock — SELECT FOR UPDATE SKIP LOCKED (D-9 / HP-2 — DB-level, not in-process).
      const activeJobId = await backfillJobRepo.checkActiveJob(connectorInstanceId, brandId, requestId);
      if (activeJobId !== null) {
        return reply.code(409).send({
          request_id: requestId,
          error: {
            code: 'BACKFILL_ALREADY_RUNNING',
            message: 'A backfill job is already queued or running for this connector.',
          },
        });
      }

      // Step 4: INSERT backfill_job status=queued.
      const jobId = await backfillJobRepo.insertQueued(brandId, connectorInstanceId, requestId);

      // Step 5: Audit connector.backfill.requested — actor, connector_instance_id, brand_id.
      // NO secret_ref, NO token in payload (I-S09 / I-S02).
      await auditWriter.append({
        brand_id: brandId,
        actor_id: auth?.userId ?? null,
        actor_role: auth?.role ?? 'unknown',
        action: 'connector.backfill.requested',
        entity_type: 'backfill_job',
        entity_id: jobId,
        payload: {
          job_id: jobId,
          connector_instance_id: connectorInstanceId,
          // NO secret_ref, NO token (I-S09)
        },
      });

      // Step 6: 202 {request_id, data: {job_id, status:'queued'}} (BackfillTriggerResponse)
      return reply.code(202).send({
        request_id: requestId,
        data: { job_id: jobId, status: 'queued' },
      });
    });

    // B2 — Progress API (ADR-BF-4)
    scope.get<{ Params: { id: string } }>('/api/v1/connectors/:id/jobs', { preHandler: requireRole('brand_admin') }, async (req, reply) => {
      const requestId = (req.id as string) ?? randomUUID();
      const brandId = getBrandId(req);
      const connectorInstanceId = req.params.id;

      // Verify the connector exists for this brand (brand-scoped, NN-1 RLS).
      const connectorInstance = await connectorRepo.findById(connectorInstanceId, brandId);
      if (!connectorInstance) {
        return reply.code(404).send({
          request_id: requestId,
          error: { code: 'CONNECTOR_NOT_FOUND', message: 'Connector not found for this brand.' },
        });
      }

      const job = await backfillJobRepo.findLatestForConnector(connectorInstanceId, brandId, requestId);
      if (!job) {
        return reply.code(404).send({
          request_id: requestId,
          error: { code: 'NO_BACKFILL_JOB', message: 'No backfill job found for this connector.' },
        });
      }

      // Map PG row → BackfillJobProgress.
      // percent = null when estimated_total is null (D-8 honesty — never fabricate).
      // NO secret_ref / token in response (I-S09).
      const recordsProcessed = parseInt(job.records_processed, 10);
      const estimatedTotal = job.estimated_total !== null ? parseInt(job.estimated_total, 10) : null;
      const percent =
        estimatedTotal !== null && estimatedTotal > 0
          ? Math.min(100, Math.round((recordsProcessed / estimatedTotal) * 100))
          : null;

      const progress: BackfillJobProgress = {
        job_id: job.id,
        status: job.status,
        records_processed: recordsProcessed,
        estimated_total: estimatedTotal,
        percent,
        cursor_date: job.cursor_date ?? null,
        achieved_depth_label: job.achieved_depth_label ?? null,
        failure_reason: job.failure_reason ?? null,
        started_at: job.started_at ?? null,
        completed_at: job.completed_at ?? null,
      };

      return reply.code(200).send({
        request_id: requestId,
        data: progress,
      });
    });
  });

  // ── Pixel routes (HIGH-MOUNT-01) ───────────────────────────────────────────
  // pixelInstallationRepo / pixelStatusRepo / getOrCreateInstallation are constructed
  // earlier (above BrandService) so brand-create can auto-provision (ADR-4).
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
    await webhookProducer.disconnect().catch(() => { /* ignore */ });
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
