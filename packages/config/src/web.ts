/**
 * @brain/config — web (Next.js) SERVER-SIDE configuration.
 *
 * This loader is the typed single-source-of-record for every SERVER-SIDE value the
 * web service configures (values read in Server Components, Route Handlers, Server
 * Actions, middleware, and `next.config.js`'s server-evaluated functions).
 *
 * SCOPE — SERVER ONLY. Client-side `NEXT_PUBLIC_*` reads are build-inlined by Next.js
 * at compile time and MUST stay as raw `process.env.NEXT_PUBLIC_*` reads — they are
 * statically replaced in the client bundle, so routing them through this runtime
 * loader would break dead-code elimination and produce the wrong value. Likewise
 * `process.env.NODE_ENV` reads in client components (e.g. components/auth/
 * verify-email-form.tsx) are inlined + dead-code-eliminated and stay raw.
 *
 * NOTE on next.config.js: the two server-side rewrite-target vars below
 * (BFF_BASE_URL, CORE_API_URL) are *physically read* in apps/web/next.config.js.
 * That file is plain CommonJS evaluated by Node directly BEFORE Next's workspace
 * transpile pipeline runs, and @brain/config ships raw ESM TypeScript source
 * (package main = src/index.ts) — Node cannot `require()`/`import` it there. So
 * those reads intentionally stay raw `process.env` in next.config.js; this schema
 * documents them as the typed source-of-record (exact same defaults) so the
 * canonical name + default + coercion live in one place.
 *
 * Preserve every existing default EXACTLY (pure refactor — zero behavior change).
 */
import { z } from 'zod';
import { CommonEnvSchema, defineConfig } from './common.js';

// ── Web (server-side) env vars ────────────────────────────────────────────────

export const WebEnvSchema = CommonEnvSchema.extend({
  SERVICE_NAME: z.literal('web').default('web'),

  // ── Server-side rewrite targets (consumed in next.config.js rewrites()) ─────
  // The web app talks ONLY to the frontend-api BFF (ADR-011); next.config.js
  // proxies `/api/bff/*` → BFF and `/api/v1/*` → core. Both are environment-
  // specific origins with a localhost dev default.
  //
  // Origin of the BFF the `/api/bff/*` rewrite proxies to. In dev it points at
  // apps/core (which serves the BFF). Default mirrors next.config.js exactly.
  BFF_BASE_URL: z.string().default('http://localhost:3001'),
  // Origin of the core API the direct `/api/v1/*` rewrite proxies to (backfill
  // trigger + progress, ADR-BF-3/4 — not BFF-wrapped). Default mirrors
  // next.config.js exactly.
  CORE_API_URL: z.string().default('http://localhost:3001'),
});

export type WebEnv = z.infer<typeof WebEnvSchema>;

/** Memoized + frozen loader for the web server-side config (parsed once per process). */
export const loadWebConfig = defineConfig(WebEnvSchema);
