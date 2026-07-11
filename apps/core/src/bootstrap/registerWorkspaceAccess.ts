/**
 * registerWorkspaceAccess (CQ-2) — the workspace-access + frontend-api (BFF) + notification
 * bounded-context registrar.
 *
 * EXTRACTED VERBATIM from apps/core/src/main.ts. Behavior-preserving move: registers the
 * auth/workspace/brand/member routes, the BFF + dashboard routes, the D13 consent routes,
 * and (dev-only) the email-link capture routes — exactly as the prior inline registration.
 */

import { type FastifyInstance } from 'fastify';
import type { DbPool } from '@brain/db';
import type pg from 'pg';
import type { SilverPool, ServingCacheReader, TouchpointZsetClient, SemanticServingRouter } from '@brain/metric-engine';
import type { AuditWriter } from '@brain/audit';
import type { FlagService } from '@brain/platform-flags';

import type {
  AuthService,
  WorkspaceService,
  BrandService,
  OnboardingService,
  InviteService,
  RateLimiter,
} from '../modules/workspace-access/index.js';
import {
  registerAuthRoutes,
  validateSessionPreHandler,
  registerWorkspaceRoutes,
  registerBrandRoutes,
  registerMemberRoutes,
} from '../modules/workspace-access/index.js';
import { registerBffRoutes } from '../modules/frontend-api/index.js';
import { registerDevRoutes, registerConsentRoutes } from '../modules/notification/index.js';
import type { ContactPiiVaultService } from '../modules/identity/index.js';
import type { Neo4jIdentityReader } from '../modules/identity/internal/infrastructure/neo4j-identity-reader.js';
import type { IdentityEventPublisher } from '../infrastructure/events/IdentityEventPublisher.js';
import type { ErasureEventPublisher } from '../infrastructure/events/ErasureEventPublisher.js';

export interface RegisterWorkspaceAccessDeps {
  nodeEnv: string;
  cookieSecret: string;
  pool: DbPool;
  rawPgPool: pg.Pool;
  srPool: SilverPool;
  /** Brain V4 serving cache (Redis-fronted hot serving reads over the Trino seam). */
  servingCache: ServingCacheReader;
  /** SPEC: B.3 / A.4 — the Redis touchpoint-cache read client (shared ioredis). Optional. */
  touchpointCacheReader?: TouchpointZsetClient;
  rateLimiter: RateLimiter;
  auditWriter: AuditWriter;
  authService: AuthService;
  workspaceService: WorkspaceService;
  brandService: BrandService;
  inviteService: InviteService;
  onboardingService: OnboardingService;
  piiVaultService: ContactPiiVaultService;
  identityReader: Neo4jIdentityReader;
  /** D13: per-brand salt resolver for the consent gate. */
  getCoreSaltHex: (brandId: string) => Promise<string>;
  /** SPEC: 0.5 — per-brand feature flags (Redis-backed, DEFAULT OFF, fail-closed). */
  flagService?: FlagService;
  /** SPEC: A.2.4 (WA-19, AMD-08) — identity-lane producer for the admin unmerge (identity.unmerged.v1). */
  identityEventPublisher?: IdentityEventPublisher;
  /**
   * AUD-OPS-036 — the RTBF erasure-trigger bridge (privacy.erasure.requested on the collector
   * lane). Optional: absent → the consent-withdraw + identity-erase entry points still perform
   * their synchronous partial erase but emit no trigger (pre-bridge behavior; tests omit it).
   */
  erasureEventPublisher?: ErasureEventPublisher;
  /** SPEC: D.3 — semantic-serving flag switch (compiled-view migration; DEFAULT OFF, legacy pass-through). */
  semanticRouter?: SemanticServingRouter;
}

export function registerWorkspaceAccess(app: FastifyInstance, deps: RegisterWorkspaceAccessDeps): void {
  const {
    nodeEnv,
    cookieSecret,
    pool,
    rawPgPool,
    srPool,
    servingCache,
    touchpointCacheReader,
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
    flagService,
    identityEventPublisher,
    erasureEventPublisher,
    semanticRouter,
  } = deps;

  // Register workspace-access + BFF routes.
  registerAuthRoutes(app, authService, rateLimiter);
  registerWorkspaceRoutes(app, authService, workspaceService);
  registerBrandRoutes(app, authService, brandService);
  registerMemberRoutes(app, authService, inviteService, rawPgPool);
  registerBffRoutes(app, authService, pool, cookieSecret, rateLimiter, rawPgPool, onboardingService, srPool, piiVaultService, identityReader, getCoreSaltHex, servingCache, flagService, identityEventPublisher, touchpointCacheReader, semanticRouter, erasureEventPublisher);

  // D13: consent write + can_contact() gate-probe routes (brand-scoped, session-guarded).
  registerConsentRoutes(app, {
    pool,
    audit: auditWriter,
    saltFn: getCoreSaltHex,
    sessionPreHandler: validateSessionPreHandler(authService),
    // AUD-OPS-036: withdraw(reason=erasure) also publishes the RTBF trigger event.
    erasurePublisher: erasureEventPublisher,
  });

  // DEV-ONLY: surface email action links (verify/reset/invite) for browser testing.
  if (nodeEnv !== 'production') {
    registerDevRoutes(app);
    app.log.warn('[dev] /api/v1/dev/last-email-link mounted (NODE_ENV != production)');
  }
}
