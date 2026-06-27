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
import type { SilverPool, ServingCacheReader } from '@brain/metric-engine';
import type { AuditWriter } from '@brain/audit';

import type { AuthService } from '../modules/workspace-access/internal/application/auth.service.js';
import type { WorkspaceService } from '../modules/workspace-access/internal/application/workspace.service.js';
import type { BrandService } from '../modules/workspace-access/internal/application/brand.service.js';
import type { OnboardingService } from '../modules/workspace-access/internal/application/onboarding.service.js';
import type { InviteService } from '../modules/workspace-access/internal/application/invite.service.js';
import { registerAuthRoutes } from '../modules/workspace-access/internal/interfaces/rest/auth.routes.js';
import { validateSessionPreHandler } from '../modules/workspace-access/internal/interfaces/rest/auth.routes.js';
import type { RateLimiter } from '../modules/workspace-access/internal/infrastructure/rate-limiter.js';
import { registerWorkspaceRoutes } from '../modules/workspace-access/internal/interfaces/rest/workspace.routes.js';
import { registerBrandRoutes } from '../modules/workspace-access/internal/interfaces/rest/brand.routes.js';
import { registerMemberRoutes } from '../modules/workspace-access/internal/interfaces/rest/member.routes.js';
import { registerBffRoutes } from '../modules/frontend-api/internal/bff.routes.js';
import { registerDevRoutes } from '../modules/notification/internal/dev.routes.js';
import { registerConsentRoutes } from '../modules/notification/internal/compliance/consent.routes.js';
import type { ContactPiiVaultService } from '../modules/identity/index.js';
import type { Neo4jIdentityReader } from '../modules/identity/internal/infrastructure/neo4j-identity-reader.js';

export interface RegisterWorkspaceAccessDeps {
  nodeEnv: string;
  cookieSecret: string;
  pool: DbPool;
  rawPgPool: pg.Pool;
  srPool: SilverPool;
  /** Brain V4 serving cache (Redis-fronted hot serving reads over the Trino seam). */
  servingCache: ServingCacheReader;
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
}

export function registerWorkspaceAccess(app: FastifyInstance, deps: RegisterWorkspaceAccessDeps): void {
  const {
    nodeEnv,
    cookieSecret,
    pool,
    rawPgPool,
    srPool,
    servingCache,
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
  } = deps;

  // Register workspace-access + BFF routes.
  registerAuthRoutes(app, authService, rateLimiter);
  registerWorkspaceRoutes(app, authService, workspaceService);
  registerBrandRoutes(app, authService, brandService);
  registerMemberRoutes(app, authService, inviteService, rawPgPool);
  registerBffRoutes(app, authService, pool, cookieSecret, rateLimiter, rawPgPool, onboardingService, srPool, piiVaultService, identityReader, getCoreSaltHex, servingCache);

  // D13: consent write + can_contact() gate-probe routes (brand-scoped, session-guarded).
  registerConsentRoutes(app, {
    pool,
    audit: auditWriter,
    saltFn: getCoreSaltHex,
    sessionPreHandler: validateSessionPreHandler(authService),
  });

  // DEV-ONLY: surface email action links (verify/reset/invite) for browser testing.
  if (nodeEnv !== 'production') {
    registerDevRoutes(app);
    app.log.warn('[dev] /api/v1/dev/last-email-link mounted (NODE_ENV != production)');
  }
}
