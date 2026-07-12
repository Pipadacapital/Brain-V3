/**
 * BFF API client — the web app talks ONLY to the frontend-api BFF.
 * Never the DB, never StarRocks, never Postgres directly.
 *
 * All calls go to /api/bff/* which maps to the frontend-api module in apps/core.
 * The BFF exchanges the httpOnly cookie for a short-lived access token on every call.
 *
 * Correlation ID (X-Request-Id) is forwarded on every request so the backend
 * can include it in the error response for UI display.
 *
 * AUD-IMPL-006: this file was a 2,640-line god-file (the largest source file in the repo — the
 * backend equivalent was decomposed by CQ-1; web was not). It is now the RE-EXPORT INDEX over the
 * per-domain modules in ./client/ — every existing `import { … } from '@/lib/api/client'` keeps
 * working, and the public surface below is EXACTLY the set the old file exported. The shared
 * fetch/CSRF/error/parse core lives in ./client/core; each domain module owns its API objects
 * verbatim (bodies unchanged by the split).
 */

// ── Shared core: fetch wrapper, error type, zod boundary parse ────────────────
export { BffApiError, userFacingMessage, getSupportReference, parseData } from './client/core';

// ── Auth + session ────────────────────────────────────────────────────────────
export { authApi, sessionApi } from './client/auth';

// ── Onboarding / workspace / brand / members ──────────────────────────────────
export { onboardingApi, workspaceApi, brandApi, membersApi } from './client/workspace';

// ── Connectors: marketplace, pixel, backfill, sync ────────────────────────────
export { connectorsApi, pixelApi, backfillApi, syncApi } from './client/connectors';
export type {
  PixelInstallerDescriptor,
  PixelInstallResult,
  BackfillTriggerResponse,
  BackfillJobProgress,
  SyncTriggerResponse,
} from './client/connectors';

// ── Analytics (Phase 1 — the big read surface) ────────────────────────────────
export { analyticsApi } from './client/analytics';

// ── Insights / segments / consent / CAPI feedback / Ask Brain ─────────────────
export { insightsApi, segmentsApi, consentApi, capiFeedbackApi, askApi } from './client/insights';

// ── Dashboard ─────────────────────────────────────────────────────────────────
export { dashboardApi } from './client/dashboard';

// ── Identity ──────────────────────────────────────────────────────────────────
export { identityApi } from './client/identity';

// ── Billing / recommendations / ML ────────────────────────────────────────────
export { billingApi, recommendationApi, mlApi } from './client/billing';

// ── Journeys + metrics lineage ────────────────────────────────────────────────
export { journeyApi, metricsApi } from './client/journeys';
