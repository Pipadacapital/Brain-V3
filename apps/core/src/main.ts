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

import Fastify, { type FastifyError } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyRawBody from 'fastify-raw-body';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { requireEnvInProd, loadCoreConfig } from '@brain/config';
import { Kafka } from 'kafkajs';

import { createPool } from '@brain/db';
import pg from 'pg';
import mysql from 'mysql2/promise';
import type { SilverPool } from '@brain/metric-engine';
import { DbAuditWriter } from '@brain/audit';

import { assertArgon2Params, AuthService } from './modules/workspace-access/internal/application/auth.service.js';
import { WorkspaceService } from './modules/workspace-access/internal/application/workspace.service.js';
import { BrandService } from './modules/workspace-access/internal/application/brand.service.js';
import { OnboardingService } from './modules/workspace-access/internal/application/onboarding.service.js';
import { InviteService } from './modules/workspace-access/internal/application/invite.service.js';
import { RateLimiter } from './modules/workspace-access/internal/infrastructure/rate-limiter.js';
import {
  ContactPiiVaultRepository,
  ContactPiiVaultService,
  DevVaultKeyProvider,
  KmsVaultKeyProvider,
  AwsKmsDecryptAdapter,
  AwsKmsEncryptAdapter,
  BrandCryptoProvisioner,
  KmsBrandSaltProvider,
  DevBrandSaltProvider,
  PgIdentityTimelineReader,
  getIdentityTimeline,
  getCustomer360,
} from './modules/identity/index.js';
import type { BrandSaltSource } from './modules/identity/index.js';
import { Neo4jIdentityReader } from './modules/identity/internal/infrastructure/neo4j-identity-reader.js';
import { createMcpDispatch } from './modules/ai/index.js';
import { initObservability, initSentry, createLogger } from '@brain/observability';

/** Structured logger for core's lifecycle/error logs (request logs go through Fastify's pino). */
const log = createLogger({ serviceName: 'core' });
import { jtiFromJwt, csrfTokenForSession, csrfTokenMatches } from './modules/frontend-api/internal/csrf.js';
import { NotificationServiceImpl } from './modules/notification/internal/notification.service.impl.js';
import { createEmailAdapter } from './modules/notification/internal/ses-adapter.js';
import { createCapiAdapter } from './modules/notification/internal/capi-adapter.js';
import { createCapiCredsPort } from './modules/notification/internal/compliance/capi-creds.adapter.js';
import { CapiPassbackService } from './modules/notification/internal/capi-passback.service.js';
import { startCapiPassback } from './modules/notification/internal/capi-passback.orchestrator.js';
import { fetchFinalizedPurchaseCandidatesScoped } from './modules/notification/internal/capi-source.query.js';
import { CanContactEngine } from './modules/notification/internal/compliance/can-contact.engine.js';
import { FunctionSaltPort } from './modules/notification/internal/compliance/salt.adapter.js';
import { PgSuppressionQuery } from './modules/notification/internal/compliance/suppression.query.js';
import { StubDltRegistry, StubNcprRegistry } from './modules/notification/internal/compliance/stubs.js';

// ── Connector infrastructure (global primitives; route wiring lives in bootstrap/) ──
import { PgConnectorInstanceRepository } from './modules/connector/sources/storefront/shopify/infrastructure/repositories/PgConnectorInstanceRepository.js';
import { PgConnectorSyncStatusRepository } from './modules/connector/sources/storefront/shopify/infrastructure/repositories/PgConnectorSyncStatusRepository.js';
import { LocalSecretsManager } from '@brain/connector-secrets';
import { AwsSecretsManager } from '@brain/connector-secrets';
import { InProcessOAuthStateStore } from './modules/connector/sources/storefront/shopify/infrastructure/state/InProcessOAuthStateStore.js';
import { RedisOAuthStateStore } from './modules/connector/sources/storefront/shopify/infrastructure/state/RedisOAuthStateStore.js';
import type { IOAuthStateStore } from './modules/connector/sources/storefront/shopify/infrastructure/state/IOAuthStateStore.js';
import { GetOrCreatePixelInstallationCommand } from './modules/connector/pixel/application/commands/GetOrCreatePixelInstallationCommand.js';
import { PgPixelInstallationRepository } from './modules/connector/pixel/infrastructure/repositories/PgPixelInstallationRepository.js';
import { PgPixelStatusRepository } from './modules/connector/pixel/infrastructure/repositories/PgPixelStatusRepository.js';

// ── Bounded-context registrars (CQ-2) + the M1 event publisher (EV-2) ─────────
import { registerWorkspaceAccess } from './bootstrap/registerWorkspaceAccess.js';
import { registerConnectors } from './bootstrap/registerConnectors.js';
import { createM1EventPublisher } from './infrastructure/events/M1EventPublisher.js';

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

  // Real OpenTelemetry export (ADR-009) — gated by OTEL_EXPORTER_OTLP_ENDPOINT (no-op in dev).
  // Keep the returned shutdown/flush fns so the graceful-shutdown handler can flush buffered
  // spans/metrics/errors before exit (C1 — otherwise the final batch is lost on SIGTERM in k8s).
  const shutdownObservability = await initObservability({
    serviceName: 'core',
    otlpEndpoint: getEnv('OTEL_EXPORTER_OTLP_ENDPOINT', '') || undefined,
  });
  const closeSentry = await initSentry({ serviceName: 'core' }); // gated by SENTRY_DSN (no-op in dev)

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

  // ── App secrets: META_APP_SECRET + GOOGLE_ADS_CLIENT_SECRET (sub-fix 3) ─────
  // In production these env vars hold AWS Secrets Manager ARNs; AwsSecretsProvider
  // fetches the values at startup (fail-fast if absent — no silent drift).
  // In dev they hold the raw values; LocalSecretsProvider returns them as-is.
  // After resolution the values are written back to process.env so the existing
  // command call sites (HandleMetaOAuthCallbackCommand, HandleGoogleAdsOAuthCallbackCommand,
  // meta-token-client.ts) read the resolved values without further refactoring.
  // FAIL-CLOSED: missing META_APP_SECRET in production → startup aborts.
  if (isProduction) {
    if (!process.env['META_APP_SECRET']) {
      throw new Error(
        '[core] FATAL: META_APP_SECRET must be set in production (ARN or Secrets Manager name). ' +
          'HandleMetaOAuthCallbackCommand and the meta-token-refresh job require it.',
      );
    }
    if (!process.env['GOOGLE_ADS_CLIENT_SECRET']) {
      throw new Error(
        '[core] FATAL: GOOGLE_ADS_CLIENT_SECRET must be set in production (ARN or Secrets Manager name). ' +
          'HandleGoogleAdsOAuthCallbackCommand requires it.',
      );
    }
  }
  // Resolve (non-empty only — skip absent optional secrets in dev)
  if (process.env['META_APP_SECRET']) {
    const resolved = await secretsProvider.getSecret(process.env['META_APP_SECRET']);
    process.env['META_APP_SECRET'] = resolved;
  }
  if (process.env['GOOGLE_ADS_CLIENT_SECRET']) {
    const resolved = await secretsProvider.getSecret(process.env['GOOGLE_ADS_CLIENT_SECRET']);
    process.env['GOOGLE_ADS_CLIENT_SECRET'] = resolved;
  }

  // Load remaining configuration.
  const config = {
    port: parseInt(getEnv('PORT', '3001'), 10),
    // feat-tenancy-runtime-brain-app (A1): the app RUNTIME connects as the non-superuser brain_app so
    // RLS is actually enforced (FORCE RLS is a no-op against a superuser/owner). Migrations keep the
    // owner DATABASE_URL (run via the CLI, not here). Prod MUST set BRAIN_APP_DATABASE_URL (fail-closed
    // — running as superuser in prod is the R-01 hole); dev defaults to the local brain_app DSN.
    databaseUrl: requireEnvInProd('BRAIN_APP_DATABASE_URL', 'postgres://brain_app:brain_app@localhost:5432/brain'),
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
    // The collector (not core) serves /pixel.js + /collect — default to its local port. In prod set
    // PIXEL_INGEST_BASE_URL to the public HTTPS host (CNAME / tunnel) so the Shopify ScriptTag is valid.
    pixelIngestBaseUrl: getEnv('PIXEL_INGEST_BASE_URL', 'http://localhost:8787'),
    // Webhook live-lane Kafka config (B1 / ADR-LV-3)
    kafkaBrokers: (getEnv('KAFKA_BROKERS', 'localhost:9092')).split(','),
    // Kafka topic prefix — derived from NODE_ENV (production → 'prod') so it agrees with the
    // collector (which derives 'prod' from NODE_ENV) regardless of the APP_ENV env-file selector.
    kafkaEnv: process.env['NODE_ENV'] === 'production' ? 'prod' : 'dev',
    // Webhook registration callback base URL (B2 / ADR-LV-5 — public URL in prod)
    webhookCallbackBaseUrl: getEnv('WEBHOOK_CALLBACK_BASE_URL', 'http://localhost:3001'),
    // Silver tier (StarRocks) read pool — feat-silver-tier-order-state. The metric-engine
    // Silver seam reads silver.order_state as the SELECT-only brain_analytics user (NOT root).
    // Optional: when absent the order-status-mix route returns an honest 503.
    starrocksHost: getEnv('STARROCKS_HOST', 'localhost'),
    starrocksPort: parseInt(getEnv('STARROCKS_PORT', '9030'), 10),
    starrocksUser: getEnv('STARROCKS_ANALYTICS_USER', 'brain_analytics'),
    // Dev default MUST match db/starrocks/bootstrap.sql, which creates brain_analytics
    // IDENTIFIED BY 'brain_analytics_dev'. An empty default caused every Silver-read route
    // (order-status-mix, journey, attribution-via-Silver) to 500 with ER_ACCESS_DENIED on a
    // fresh `pnpm dev`. Prod FAILS CLOSED if unset (never reuse the known weak dev password).
    starrocksPassword: requireEnvInProd('STARROCKS_ANALYTICS_PASSWORD', 'brain_analytics_dev'),
  };

  // Typed config single-source-of-record (parsed once, frozen). Loaded AFTER the META/GOOGLE
  // secret-resolution writeback above so any env mutation that matters is already applied; none of
  // the fields below depend on it, but ordering is preserved for safety.
  const cfg = loadCoreConfig();

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
        code: statusCode >= 500 ? 'INTERNAL_ERROR' : (error.code ?? 'INTERNAL_ERROR'),
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
    log.warn('Redis connect failed — rate limiting will fail-open', { err });
  });
  const rateLimiter = new RateLimiter(redis);

  // Raw pg.Pool for methods that need explicit BEGIN/COMMIT (rotateRefreshToken, acceptInvite,
  // updateMemberRole, removeMember). These require transaction control before knowing the userId,
  // so the GUC middleware cannot be applied at checkout. The raw pool bypasses GUC middleware.
  const rawPgPool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: 5, // smaller sub-pool for transactional paths
  });

  // Readiness probe (T2-10). `/health` above is LIVENESS — the process is up, so K8s must
  // NOT restart it. `/readyz` is READINESS — it answers "can this instance serve traffic
  // right now?", which is false while Postgres is unreachable (a fresh pod still booting,
  // or a transient DB blip). K8s pulls a not-ready pod from the Service endpoints WITHOUT
  // killing it, so it rejoins automatically once the dependency recovers. The DB ping is
  // bounded so a hung socket can't make the probe itself hang (mirrors T2-9's posture).
  app.get('/readyz', async (_req, reply) => {
    try {
      await Promise.race([
        rawPgPool.query('SELECT 1'),
        new Promise((_resolve, rejectTimeout) =>
          setTimeout(() => rejectTimeout(new Error('readiness db ping timed out')), 2000),
        ),
      ]);
      return reply.code(200).send({ status: 'ready', timestamp: new Date().toISOString() });
    } catch {
      // Do not leak the DB error string; the dependency name is enough for the operator.
      return reply
        .code(503)
        .send({ status: 'not_ready', reason: 'database_unreachable', timestamp: new Date().toISOString() });
    }
  });

  // Silver tier (StarRocks) read pool — feat-silver-tier-order-state. mysql2 speaks the
  // StarRocks MySQL wire protocol (:9030). Connects as brain_analytics (SELECT-only — NOT
  // root): reading Silver as a non-DDL user is part of the isolation posture even though
  // engine-level row policy is unavailable on the dev allin1 image (the brand predicate is
  // injected at the withSilverBrand seam; see packages/metric-engine/src/silver-deps.ts).
  // The pool's structural shape satisfies @brain/metric-engine SilverPool.
  const srPool: SilverPool = mysql.createPool({
    host: config.starrocksHost,
    port: config.starrocksPort,
    user: config.starrocksUser,
    password: config.starrocksPassword,
    connectionLimit: 5,
    connectTimeout: 5000,
    // StarRocks DATETIMEs are UTC; tell mysql2 so it builds JS Dates as UTC (not the process-local
    // tz). Without this a non-UTC core pod mis-reads Iceberg/Silver timestamps by the tz offset.
    timezone: 'Z',
  }) as unknown as SilverPool;

  // Create DB pool (3-GUC middleware — NN-1). assertRlsEnforcingRole (P2.3): refuse to start if
  // DATABASE_URL points at an RLS-bypassing role (the superuser footgun) — raw queries would
  // silently defeat tenant isolation.
  const pool = await createPool({ connectionString: config.databaseUrl, assertRlsEnforcingRole: true });

  // Create audit writer (real sha256 hash-chain — L-02).
  const auditDb = {
    query: async <T = unknown>(sql: string, params?: unknown[]) => {
      const client = await pool.connect();
      try {
        // audit_log FORCE-RLS (0067): reads gate on USING (cross-brand isolation) and an INSERT with
        // RETURNING re-checks the new row against USING. The audit writer is the trusted, server-side,
        // cross-brand SoR writer (it stamps brand_id + reads the per-brand hash-chain head), so it runs
        // with the designed 'audit_reader' app.role escape — without it the chain-head SELECT silently
        // sees 0 rows AND every INSERT ... RETURNING fails the policy (42501), breaking register/login.
        return await client.query<T>({ correlationId: 'system', role: 'audit_reader' }, sql, params);
      } finally {
        client.release();
      }
    },
  };
  const auditWriter = new DbAuditWriter(auditDb);

  // ── D13: can_contact() compliance engine (the SOLE outbound gate, I-ST05) ────
  // Per-brand salt for PII hashing in the consent gate (env var
  // IDENTITY_SALT_<BRAND_UUID_NO_DASHES>, 64-hex; HARD-CRASH on miss — D-2).
  // ONE salt source (Single-Primitive) reused for both consent hashing + webhooks.
  // ── Per-brand identity salt source (shared by every core salt site) ──────────
  // DEV: DevBrandSaltProvider → the deterministic dev salt (resolveDevSaltHex) — same value the
  // worker derives, so a brand hashes identically core↔worker with zero seeding. PROD: the per-brand
  // salt KMS-unwrapped from tenancy.brand_identity_salt (0109) — a RUNTIME-created brand has no
  // IDENTITY_SALT env, so prod MUST read the provisioned DB salt. Per-brand cache; fails CLOSED (D-2).
  const brandSaltSource: BrandSaltSource = isProduction
    ? new KmsBrandSaltProvider(rawPgPool, new AwsKmsDecryptAdapter())
    : new DevBrandSaltProvider();

  async function getCoreSaltHex(brandId: string): Promise<string> {
    // Delegates to the single per-brand salt source above (dev-derived / prod-DB). The provider is
    // the D-2 crash point (throws on missing/inactive/wrong-length salt); we re-assert the 64-hex
    // length here as defence in depth so no caller ever hashes with a bad salt.
    const salt = await brandSaltSource.saltHexForBrand(brandId);
    if (!salt || salt.length !== 64) {
      throw new Error(
        `[can_contact] salt for brand ${brandId} is missing or wrong length ` +
          `(expected 64 hex chars) — refusing to hash with empty/default salt (D-2)`,
      );
    }
    return salt;
  }
  // The engine + write path are built PER REQUEST inside the consent routes (a fresh
  // GUC-scoped DbClient is acquired per call → no GUC bleed across concurrent brands);
  // brandId flows per call from the session JWT. DLT/NCPR are the shipped default-
  // closed stubs (real registries are a documented platform follow-up). One salt
  // source (Single-Primitive) via getCoreSaltHex.
  app.log.info(
    '[core] can_contact() compliance engine wired (consent + DLT-stub + NCPR-stub + 9–9 IST window, default-closed)',
  );

  // Create notification service (SES in prod, console in dev — I-ST05).
  const emailAdapter = createEmailAdapter(config.nodeEnv, config.emailFromAddress);
  const notificationService = new NotificationServiceImpl(emailAdapter, config.appBaseUrl);

  // ── Phase 6: Meta CAPI conversion-passback adapter (DEFAULT-CLOSED, I-ST05) ───
  // Mirrors the email adapter wiring. The creds port resolves null in dev → the
  // factory returns the DevCapiAdapter (would_send_dev, NEVER sends). The real Meta
  // send (graph.facebook.com Conversions API) is reachable ONLY in prod with resolved
  // creds AND ONLY behind can_contact(purpose='advertising') in CapiPassbackService.
  // Constructed here so the adapter is available; no send fires without the gate.
  const capiCredsPort = createCapiCredsPort(); // dev/default-closed (prod resolver = follow-up)
  const capiAdapter = createCapiAdapter(config.nodeEnv, null);
  void capiCredsPort;
  app.log.info(
    '[core] Meta CAPI passback adapter wired (DEFAULT-CLOSED: dev → would_send_dev, never sends; behind can_contact(advertising))',
  );

  // ── PII vault (P0-C): encrypted contact_pii read/write + MatchPiiPort + coverage ──
  // Prod unwraps the per-brand DEK from brand_keyring via AWS KMS (IRSA creds); dev derives a
  // deterministic per-brand DEK. The vault service is the contact_pii read seam (the only place
  // app.role='send_service' is set) and structurally satisfies notification's MatchPiiPort.
  const vaultKeyProvider =
    config.nodeEnv === 'production'
      ? new KmsVaultKeyProvider(rawPgPool, new AwsKmsDecryptAdapter())
      : new DevVaultKeyProvider();
  // MEDALLION REALIGNMENT (Epic 3 / ADR-0004): the Neo4j identity SoR read/admin client. The identity
  // surfaces (Customer 360, browse, merge-admin, GDPR erase, vault coverage) read it; contact_pii +
  // identity_audit stay PG (passed via rawPgPool for the erase mutation).
  const identityReader = new Neo4jIdentityReader(
    cfg.NEO4J_URI,
    cfg.NEO4J_USER,
    cfg.NEO4J_PASSWORD,
    rawPgPool,
  );
  const piiVaultService = new ContactPiiVaultService(
    new ContactPiiVaultRepository(rawPgPool, identityReader),
    vaultKeyProvider,
  );

  // ── READ-ONLY MCP dispatch MOUNT (Brain V4; D5 / I-S08 / I-S01) ──────────────
  // Compose the read-only MCP dispatch over its real seams: INTELLIGENCE/MARKETING via the
  // metric-engine (inside the ai module, over brain_serving.mv_*), IDENTITY injected here as
  // read-only closures over the identity module reads (timeline = identity_audit projection;
  // explainability = the Neo4j graph merges, hash-only). brand_id is taken from the principal at
  // dispatch time — never a tool input. The MCP server transport (deferred) calls this function.
  const identityTimelineReader = new PgIdentityTimelineReader(rawPgPool);
  const mcpDispatch = createMcpDispatch({
    srPool,
    identity: {
      identityTimeline: (brandId, brainId) =>
        getIdentityTimeline(brandId, brainId, randomUUID(), { reader: identityTimelineReader }),
      identityExplain: async (brandId, brainId) => {
        const r = await getCustomer360(brandId, brainId, randomUUID(), { reader: identityReader });
        if (r.state === 'not_found') return { state: 'not_found', brain_id: brainId };
        return {
          state: 'found',
          brain_id: r.customer.brain_id,
          identifiers: r.identifiers.map((i) => ({
            identifier_type: i.identifier_type,
            identifier_hash_prefix: i.identifier_hash_prefix,
          })),
          merges: r.merges.map((m) => ({
            role: m.role,
            canonical_brain_id: m.canonical_brain_id,
            merged_brain_id: m.merged_brain_id,
            confidence: m.confidence,
            rule_version: m.rule_version,
          })),
        };
      },
    },
  });
  // The dispatch is constructed at assembly time so the wiring is live; the MCP server transport
  // (LiteLLM/MCP, deferred to M3) binds to it. Referenced to keep it in the assembly graph.
  void mcpDispatch;
  // ── Meta CAPI passback ORCHESTRATOR (P0 — the missing driver) ────────────────
  // Nothing previously called passback(); the service was constructed then void-ed. This wires the
  // periodic driver: enumerate brands → fetch finalized-purchase candidates (anti-joined vs
  // capi_passback_log → idempotent) → passback() each. DOUBLE-GATED for prod safety: (1) passback
  // is consent-gated + the adapter is the DevCapiAdapter (never sends) unless real Meta creds are
  // resolved in prod; (2) this loop only RUNS when CAPI_PASSBACK_ENABLED=true. Off by default → no
  // behavior change; flip on once prod Meta creds are wired.
  // passback acquires a fresh GUC-scoped DbClient per conversion (mirrors the consent-route pattern:
  // the CanContactEngine's PgSuppressionQuery + the service's writeLog both need a brand-scoped
  // client). Passbacks are infrequent (finalized purchases), so per-call construction is fine.
  const capiPassback = async (conv: Parameters<CapiPassbackService['passback']>[0]) => {
    const client = await pool.connect();
    try {
      const engine = new CanContactEngine({
        salt: new FunctionSaltPort(getCoreSaltHex),
        suppression: new PgSuppressionQuery(client),
        dlt: new StubDltRegistry(),
        ncpr: new StubNcprRegistry(),
      });
      const svc = new CapiPassbackService({ engine, adapter: capiAdapter, pii: piiVaultService, db: client });
      return await svc.passback(conv);
    } finally {
      client.release();
    }
  };
  let stopCapiPassback: (() => void) | null = null;
  if (cfg.CAPI_PASSBACK_ENABLED) {
    const handle = startCapiPassback({
      enumerateBrandIds: async () => {
        const r = await rawPgPool.query<{ id: string }>('SELECT id FROM list_active_brand_ids()');
        return r.rows.map((x) => x.id);
      },
      // Epic 1: finalized purchases come from the lakehouse gold ledger (srPool); subject_hash +
      // passback dedup resolve in PG. Cross-store read inside fetchFinalizedPurchaseCandidatesScoped.
      fetchCandidates: (brandId, from, to) => fetchFinalizedPurchaseCandidatesScoped(rawPgPool, srPool, brandId, from, to),
      passback: capiPassback,
      windowHours: cfg.CAPI_PASSBACK_WINDOW_HOURS,
      intervalMs: cfg.CAPI_PASSBACK_INTERVAL_MS,
      log: { info: (m) => app.log.info(m), warn: (m, meta) => app.log.warn(meta ?? {}, m), error: (m, meta) => app.log.error(meta ?? {}, m) },
    });
    stopCapiPassback = handle.stop;
    app.log.info('[core] Meta CAPI passback orchestrator RUNNING (CAPI_PASSBACK_ENABLED=true)');
  } else {
    void capiPassback;
    app.log.info('[core] Meta CAPI passback orchestrator wired but IDLE (set CAPI_PASSBACK_ENABLED=true to drive sends)');
  }

  app.log.info(
    `[core] PII vault wired (${config.nodeEnv === 'production' ? 'PROD: AWS KMS per-brand DEK (brand_keyring)' : 'dev: per-brand derived DEK'}); MatchPiiPort ready for CAPI passback`,
  );

  // ── B1: live-lane Kafka producer (ADR-LV-1..4) ───────────────────────────────
  // Connected ONCE at startup and reused by the webhook pipeline AND the M1 event publisher.
  // Built BEFORE the application services so the lifecycle emitters (user.registered,
  // brand.created) can be injected into AuthService/BrandService below.
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
    // Same single brandSaltSource as getCoreSaltHex / the worker — a live webhook ingest and a repull
    // of the same order hash the same email identically. The provider is the D-2 crash point; the
    // length re-assert is defence in depth.
    const salt = await brandSaltSource.saltHexForBrand(brandId);
    if (!salt || salt.length !== 64) {
      throw new Error(
        `[webhook] salt for brand ${brandId} is missing or wrong length (expected 64 hex chars)`,
      );
    }
    return salt;
  }

  // ── EV-2: the REAL M1 domain-event publisher ────────────────────────────────
  // Replaces the prior log-only emitEvent stubs: publishes versioned M1 lifecycle events
  // (pixel.installed.v1, connector.connected.v1, brand.created.v1, user.registered.v1) to
  // Kafka via the same producer pattern the webhook pipeline + collector use. Wired into
  // every command-event callback below (getOrCreateInstallation, the connector commands,
  // verifyPixel) AND the lifecycle services (AuthService → user.registered, BrandService →
  // brand.created) so the events actually reach the bus instead of only the log.
  const emitEvent = createM1EventPublisher({
    producer: webhookProducer,
    env: config.kafkaEnv,
    log: {
      info: (obj, msg) => app.log.info(obj, msg),
      warn: (obj, msg) => app.log.warn(obj, msg),
      error: (obj, msg) => app.log.error(obj, msg),
    },
  });

  // Create application services.
  const authServiceConfig = { jwtSigningSecret: config.jwtSigningSecret };
  const authService = new AuthService(pool, auditWriter, notificationService, authServiceConfig, rawPgPool, emitEvent);
  const workspaceService = new WorkspaceService(pool, auditWriter);

  // ── Connector infrastructure (global primitives shared by the connector registrar) ──
  // Constructed here (before pixel provisioning + the registrars) so the SAME instances are
  // reused across contexts and the webhook producer is available to the M1 event publisher.
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
  const connectorKmsKeyId = cfg.CONNECTOR_SECRETS_KMS_KEY_ID;
  const connectorSecretsManager = isProduction
    ? new AwsSecretsManager(getEnv('AWS_REGION', 'us-east-1'), shopifyClientSecretRef, connectorKmsKeyId)
    // DEV-TOKEN-REACH (0024): pass rawPgPool so dev tokens persist to dev_secret —
    // durable across core restarts and readable by the separate stream-worker process.
    : new LocalSecretsManager(rawPgPool);
  // Scale-C4: prod uses the Redis-backed store so OAuth state survives across replicas (the
  // callback may land on a different pod than initiated). Dev stays in-process (no Redis
  // dependency for the local connect flow). Shared by Shopify/Meta/Google via IOAuthStateStore.
  const oauthStateStore: IOAuthStateStore = isProduction
    ? new RedisOAuthStateStore(redis)
    : new InProcessOAuthStateStore();

  // Pixel provision wiring (ADR-4): construct the idempotent installation command
  // BEFORE BrandService so brand-create-with-website can auto-provision the per-brand
  // pixel_installation server-side. brandId flows ONLY from the just-written brand.id.
  const pixelInstallationRepo = new PgPixelInstallationRepository(pool);
  const pixelStatusRepo = new PgPixelStatusRepository(pool);
  const getOrCreateInstallation = new GetOrCreatePixelInstallationCommand(
    pixelInstallationRepo,
    pixelStatusRepo,
    emitEvent,
  );

  // Per-brand identity-crypto provisioner (prod): at brand creation, generate + KMS-wrap a random
  // salt + DEK and write tenancy.brand_identity_salt + brand_keyring (0109) via the SECURITY DEFINER
  // provision_brand_crypto, so a RUNTIME-created brand can hash PII (identity/consent/webhooks) and
  // use the contact_pii vault — closing the prod onboarding gap. Dev derives both deterministically,
  // so no provisioning closure is wired there. Uses rawPgPool (brain_app has EXECUTE; the fn is
  // SECURITY DEFINER → no brand GUC needed) and the same connector CMK the bootstrap wraps with.
  const provisionBrandCrypto = isProduction
    ? ((): ((brandId: string) => Promise<void>) => {
        // Key-domain separation (KMS best practice): identity salt + PII-vault DEK are a different
        // data classification from connector OAuth tokens, so they SHOULD use a dedicated CMK. Honour
        // IDENTITY_CRYPTO_KMS_KEY_ID when set; fall back to the connector CMK so existing single-key
        // deployments keep working. The read side (AwsKmsDecryptAdapter) resolves the key from the
        // wrapped blob's stored kms_key_id, so a future key swap is transparent to readers.
        const identityKmsKeyId =
          cfg.IDENTITY_CRYPTO_KMS_KEY_ID ?? connectorKmsKeyId;
        const provisioner = new BrandCryptoProvisioner(
          rawPgPool,
          new AwsKmsEncryptAdapter(),
          identityKmsKeyId,
        );
        return (brandId: string) => provisioner.provision(brandId);
      })()
    : undefined;

  const brandService = new BrandService(
    pool,
    auditWriter,
    async (brandId, targetHost, idempotencyKey) => {
      await getOrCreateInstallation.execute({ brandId, targetHost, idempotencyKey });
    },
    provisionBrandCrypto,
    srPool,
    emitEvent,
  );
  const inviteService = new InviteService(pool, auditWriter, notificationService, rawPgPool);

  // feat-onboarding-ux (D3): merged workspace+brand provisioning. Reuses the SAME pixel
  // provisioner injected into BrandService so the website→pixel path is not regressed; the
  // org+brand+memberships are created atomically by provision_workspace_and_brand() (0047),
  // run through the RLS pool under brain_app (feat-tenancy-runtime-brain-app A1).
  const onboardingService = new OnboardingService(
    pool,
    auditWriter,
    async (brandId, targetHost, idempotencyKey) => {
      await getOrCreateInstallation.execute({ brandId, targetHost, idempotencyKey });
    },
    emitEvent,
    provisionBrandCrypto,
  );

  // ── CQ-2: register the workspace-access + frontend-api (BFF) + notification context ──
  registerWorkspaceAccess(app, {
    nodeEnv,
    cookieSecret: config.cookieSecret,
    pool,
    rawPgPool,
    srPool,
    rateLimiter,
    auditWriter,
    authService,
    workspaceService,
    brandService,
    inviteService,
    onboardingService,
    piiVaultService,
    identityReader,
    getCoreSaltHex,
  });

  // ── CQ-2: register the connector + pixel context (HIGH-MOUNT-01) ────────────
  // All connector/pixel route wiring + per-context command construction lives in the
  // registrar; the global primitives it needs are built above and passed in.
  registerConnectors(app, {
    config: {
      nodeEnv,
      appBaseUrl: config.appBaseUrl,
      shopifyCallbackUrl: config.shopifyCallbackUrl,
      metaCallbackUrl: config.metaCallbackUrl,
      googleAdsCallbackUrl: config.googleAdsCallbackUrl,
      pixelIngestBaseUrl: config.pixelIngestBaseUrl,
      kafkaEnv: config.kafkaEnv,
    },
    pool,
    rawPgPool,
    redis,
    authService,
    auditWriter,
    connectorRepo,
    syncStatusRepo,
    connectorSecretsManager,
    oauthStateStore,
    webhookProducer,
    liveTopic,
    getWebhookSaltHex,
    identityReader,
    pixelInstallationRepo,
    pixelStatusRepo,
    getOrCreateInstallation,
    emitEvent,
  });

  // Graceful shutdown.
  const shutdown = async () => {
    app.log.info('[core] Shutting down...');
    if (stopCapiPassback) stopCapiPassback(); // stop the CAPI passback loop before tearing down pools
    await app.close();
    await webhookProducer.disconnect().catch(() => { /* ignore */ });
    await pool.end();
    await rawPgPool.end().catch(() => { /* ignore */ });
    await (srPool as unknown as { end: () => Promise<void> }).end().catch(() => { /* ignore */ });
    await redis.quit().catch(() => { /* ignore */ });
    // Flush buffered telemetry LAST so shutdown logs/spans are exported (C1).
    await shutdownObservability().catch(() => { /* ignore */ });
    await closeSentry().catch(() => { /* ignore */ });
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
  log.error('Fatal startup error', { err });
  process.exit(1);
});
