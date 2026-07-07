/**
 * Shared BFF plugin scaffolding (CQ-1 decomposition).
 *
 * The ~4,500-line bff.routes.ts god-file is split into cohesive per-feature Fastify
 * route-PLUGIN files under this directory. Each plugin is a `(fastify, deps)` function
 * registering ONLY its routes; the top-level `registerBffRoutes` composes them with a
 * single shared `BffDeps` bundle so every route path/method/response/auth/brand-scope
 * stays byte-identical.
 *
 * This file centralizes the cookie-augmentation types, the module constants, and the
 * `BffDeps` contract (deps + shared pre-handlers/helpers) that the plugins consume.
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import type { DbPool } from '@brain/db';
import type { Pool as PgPool } from 'pg';
import type { SilverPool, ServingCacheReader, TouchpointZsetClient, SemanticServingRouter } from '@brain/metric-engine';
import type {
  AuthService,
  OnboardingService,
  RateLimiter,
} from '../../../workspace-access/index.js';
import type { IdentityReader } from '../../../identity/index.js';
import type { ContactPiiVaultService } from '../../../identity/index.js';
import type { FoundationSignals } from '../../../analytics/index.js';
import type { FlagService } from '@brain/platform-flags';
import type { IdentityEventPublisher } from '../../../../infrastructure/events/IdentityEventPublisher.js';

// @fastify/cookie v11 module augmentation is not automatically applied in
// NodeNext module resolution when the package has no `exports` field.
// We define local helpers to type the cookie-augmented reply/request without
// relying on side-effect augmentation propagation.
export type CookieOptions = {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'strict' | 'lax' | 'none' | boolean;
  path?: string;
  maxAge?: number;
  domain?: string;
  expires?: Date;
};
export type CookieReply = FastifyReply & {
  setCookie(name: string, value: string, options?: CookieOptions): CookieReply;
  clearCookie(name: string, options?: CookieOptions): CookieReply;
};

export const COOKIE_NAME = 'brain_session';
export const CSRF_COOKIE_NAME = 'brain_csrf';
export const ACCESS_TOKEN_EXPIRY_SECS = 7 * 24 * 60 * 60; // 7 days — matches the session cookie maxAge (user decision 2026-07-06; keep in lockstep with auth/shared.ts)

/**
 * The shared dependency bundle handed to every BFF route plugin. It carries the raw
 * deps injected into `registerBffRoutes` plus the per-registration shared pre-handlers
 * and helpers (constructed once in `registerBffRoutes`). Plugins destructure what they
 * need; the bundle keeps the public registration entrypoint + the handler bodies intact.
 */
export interface BffDeps {
  authService: AuthService;
  pool?: DbPool;
  cookieSecret: string;
  rateLimiter?: RateLimiter;
  rawPool?: PgPool;
  onboardingService?: OnboardingService;
  srPool?: SilverPool;
  /**
   * Brain V4 serving cache (Redis-fronted hot serving reads over the Trino seam). Optional:
   * when absent, the metric routes read Trino directly (the safe-OFF fallback). Wraps a
   * known-metric read as getOrSet(buildCacheKey(brandId, metricId, paramsHash, servingVersion)).
   */
  servingCache?: ServingCacheReader;
  /**
   * SPEC: B.3 / A.4 — the Redis touchpoint-cache read client (the shared ioredis at the root,
   * satisfying the zrevrange/zcard structural port). Optional: absent → the B.3 journey timeline
   * reads the durable Trino ledger directly (the §1.11 cold-path fallback).
   */
  touchpointCacheReader?: TouchpointZsetClient;
  /**
   * SPEC: D.3 — the semantic-serving flag switch. Every migrated metric read routes through it:
   * flag `semantic.serving` OFF (default) → legacy mv_gold_* mart read (BYTE-IDENTICAL); ON +
   * compiled read → compiled semantic view. Optional: absent → routes call the legacy read directly
   * (identical to pre-Wave-D). FAIL-CLOSED (flag error → legacy). See semantic-serving.ts.
   */
  semanticRouter?: SemanticServingRouter;
  vaultService?: ContactPiiVaultService;
  identityReader?: IdentityReader;
  /**
   * SPEC: A.2.4 (WA-19) — identity-lane producer for admin mutations (unmerge → identity.unmerged.v1).
   * Optional: absent → the unmerge still commits (Neo4j split + PG audit) but emits no wire event
   * (the batch re-version job folds the change from silver_identity_map). Existing tests omit it.
   */
  identityEventPublisher?: IdentityEventPublisher;
  /**
   * Per-brand salt resolver (the single brandSaltSource: dev-derived / prod KMS-unwrapped from
   * brand_identity_salt). Used by the Customer-360 search to hash the query term identically to how
   * the brand's identities were hashed. Optional: absent → callers fall back to the dev resolver.
   */
  getCoreSaltHex?: (brandId: string) => Promise<string>;
  /**
   * SPEC: 0.5 — per-brand feature flags (Redis-backed, DEFAULT OFF, fail-closed).
   * Optional: absent → the admin flag routes answer 503 and nothing reads flags
   * (equivalent to every flag OFF — the safe pre-wave state).
   */
  flagService?: FlagService;
  /** Standard session validation pre-handler (NN-3). */
  sessionPreHandler: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  /** Cookie + CSRF + session validation pre-handler used by every protected BFF route. */
  bffProtectedPreHandler: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  /** Composes the foundation-health signals (pixel/commerce/sync/freshness/DQ) for a brand. */
  gatherFoundationSignals: (brandId: string, requestId: string) => Promise<FoundationSignals>;
}
