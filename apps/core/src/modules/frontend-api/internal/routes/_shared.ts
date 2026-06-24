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

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { DbPool } from '@brain/db';
import type { Pool as PgPool } from 'pg';
import type { SilverPool } from '@brain/metric-engine';
import type {
  AuthService,
  OnboardingService,
  RateLimiter,
} from '../../../workspace-access/index.js';
import type { IdentityReader } from '../../../identity/index.js';
import type { ContactPiiVaultService } from '../../../identity/index.js';
import type { FoundationSignals } from '../../../analytics/index.js';

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
export const CSRF_HEADER_NAME = 'x-csrf-token';
export const ACCESS_TOKEN_EXPIRY_SECS = 60 * 60; // 1 hour — matches the session cookie maxAge

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
  vaultService?: ContactPiiVaultService;
  identityReader?: IdentityReader;
  /** Standard session validation pre-handler (NN-3). */
  sessionPreHandler: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  /** Cookie + CSRF + session validation pre-handler used by every protected BFF route. */
  bffProtectedPreHandler: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  /** Composes the foundation-health signals (pixel/commerce/sync/freshness/DQ) for a brand. */
  gatherFoundationSignals: (brandId: string, requestId: string) => Promise<FoundationSignals>;
}

/** A BFF route plugin: registers only its own routes against the shared deps bundle. */
export type BffRoutePlugin = (fastify: FastifyInstance, deps: BffDeps) => void;
