# Pass 5: API Audit (api)

**Auditor:** Principal-level independent review  
**Date:** 2026-06-19  
**Scope:** Implemented endpoints vs. `docs/requirements/06_Brain_API_Architecture_and_Contracts.md` (Final v1.2)  
**Files examined:** `apps/core/src/modules/workspace-access/internal/interfaces/rest/` (auth, brand, member, workspace routes), `apps/core/src/modules/frontend-api/internal/bff.routes.ts`, `apps/core/src/main.ts`, `apps/core/src/modules/workspace-access/internal/infrastructure/repositories.ts`, `packages/metric-engine/src/kpi-summary.ts`, `apps/core/src/modules/analytics/internal/application/queries/get-kpi-summary.ts`

---

## Board Verdict

The API implementation is disciplined in its core happy-path: keyset pagination is correctly implemented throughout (no SQL OFFSET), CSRF double-submit with JTI binding is well-constructed, rate limiting is in place on auth routes, and Zod validation at the edge is broadly applied. However, six concrete gaps exist against the frozen v1.2 contract. The most impactful are: (1) the error code emitted for 422 validation failures is `VALIDATION_ERROR` everywhere in code but the spec mandates `VALIDATION_FAILED` — a machine-readable contract break affecting every consumer; (2) `X-Correlation-Id` is generated and logged but never echoed back in response headers — every endpoint violates §1.4 and §1.9; (3) `X-RateLimit-Limit/Remaining/Retry-After` headers are never emitted on successful rate-checked responses — only `Retry-After` appears on the 429 itself; (4) idempotency key enforcement is absent on several mutating endpoints mandated by §1.8 (POST /api/v1/brands, POST /api/v1/connectors, PATCH /api/v1/brands/:id, DELETE /api/v1/members/:id, PATCH /api/v1/members/:id/role) with zero replay-cache logic anywhere; (5) critical API contract endpoints from the frozen catalog are entirely unimplemented — `/api/v1/metrics/query`, `/api/v1/metrics/catalog`, `/api/v1/metrics/{metricId}`, all billing endpoints (§3.9), all recommendation endpoints (§3.11), all identity merge/unmerge endpoints (§3.6), all customer 360 endpoints, all AI NLQ and query-history endpoints (§7.1, §7.7), and both privacy/DSAR endpoints (§3.16); (6) metric-bearing responses lack the mandated `metric_version`, `recognition_label`, and `confidence` envelope fields per §1.4. The `trace_id` field is also absent from error envelopes per §1.5. The BFF correctly routes brand context from JWT (`auth.brandId`) rather than a client-supplied `X-Brand-Id` header — this is architecturally sound for the BFF pattern, but the path divergence vs. direct `/api/v1` clients relying on `X-Brand-Id` is undocumented.

**Severity counts: Critical 1 | High 3 | Medium 2 | Low 0**

---

## Finding API-1

**Title:** 422 error code emits `VALIDATION_ERROR` not spec-mandated `VALIDATION_FAILED`  
**Severity:** High  
**Category:** Error Standards / Contract Drift  
**Priority:** P1

**evidenceRef:**
- `apps/core/src/modules/workspace-access/internal/interfaces/rest/auth.routes.ts:84` — `code: 'VALIDATION_ERROR'`
- `apps/core/src/modules/workspace-access/internal/interfaces/rest/brand.routes.ts:35` — `code: 'VALIDATION_ERROR'`
- `apps/core/src/modules/workspace-access/internal/interfaces/rest/member.routes.ts:57` — `code: 'VALIDATION_ERROR'`
- `apps/core/src/modules/notification/internal/compliance/consent.routes.ts:119` — `code: 'VALIDATION_ERROR'`
- `apps/core/src/modules/frontend-api/internal/bff.routes.ts:366` — `code: 'VALIDATION_ERROR'`
- `docs/requirements/06_Brain_API_Architecture_and_Contracts.md:132` — spec mandates `VALIDATION_FAILED`

**Impact:** Every consumer (web app, mobile, external integrations, CI contract tests) that branches on the machine code for validation failures will receive `VALIDATION_ERROR` instead of the spec-mandated `VALIDATION_FAILED`. If/when a second major version ships with the correct code, a version-detection scheme that reads the code will silently fail on v1. 15 call sites across 5 route files all use the wrong code string.

**rootCause:** The spec was written with `VALIDATION_FAILED` (§1.5 table, §4.1, §4.2, §4.3 error tables) but the implementation was written with `VALIDATION_ERROR` — a common naming-convention divergence that no contract test catches because there is no CI gate comparing error codes to the OpenAPI spec.

**Fix:** Replace all `'VALIDATION_ERROR'` occurrences in route files with `'VALIDATION_FAILED'`. Add a contract test that asserts the exact `error.code` string returned by each endpoint on a 422 response matches the OpenAPI spec. A `grep` pre-commit hook for the disallowed string would catch future drift.

**tenantImpact:** All tenants equally affected — every brand that receives a 422 from any endpoint gets the wrong machine code.

**Detection:** Visible now in any integration test that asserts `error.code`; in production it surfaces when a client tries to branch on the code and misses.

---

## Finding API-2

**Title:** `X-Correlation-Id` never echoed in response headers despite mandatory §1.4 + §1.9 requirement

**Severity:** High  
**Category:** Standards Compliance / Observability  
**Priority:** P1

**evidenceRef:**
- `apps/core/src/main.ts:238-241` — `onRequest` hook sets `x-correlation-id` on the request but no `onSend` hook or per-route `reply.header()` call echoes it in the response
- `apps/core/src/modules/workspace-access/internal/interfaces/rest/auth.routes.ts:62-63` — correlation ID read from request, never written to reply headers
- `docs/requirements/06_Brain_API_Architecture_and_Contracts.md:118` — "§1.4 Response standards: `X-Correlation-Id` echoed on every response"
- `docs/requirements/06_Brain_API_Architecture_and_Contracts.md:149` — "§1.9: echoed in responses"

**Impact:** Clients cannot correlate their request to a server-side trace ID without grepping logs. Support and on-call runbooks that say "attach the `X-Correlation-Id` from the response" provide zero value. Distributed tracing across BFF → Core is broken for operator-initiated debugging. The SLO error-budget burn alert (§1.15) relies on correlation across layers — without the echoed header, a failing request cannot be linked client-side to a server span.

**rootCause:** The `onRequest` hook correctly generates and sets the correlation ID on `request.headers` for internal propagation, but there is no `onSend` (or `addHook('onSend', ...)`) hook that copies it to the response headers. All ~40 route handlers read the correlationId for logging but none call `reply.header('x-correlation-id', correlationId)`.

**Fix:** Add a single `app.addHook('onSend', async (request, reply) => { reply.header('x-correlation-id', request.headers['x-correlation-id']); })` in `apps/core/src/main.ts` immediately after the `onRequest` hook. Add a smoke test asserting the response carries the header.

**tenantImpact:** All tenants on all endpoints — universal gap.

**Detection:** Invisible until a client reports it or a load test asserts response headers; no alert currently fires.

---

## Finding API-3

**Title:** Rate-limit response headers (`X-RateLimit-Limit`, `X-RateLimit-Remaining`) never emitted; §1.7 mandate is entirely unimplemented

**Severity:** Medium  
**Category:** Standards Compliance / Rate Limiting  
**Priority:** P2

**evidenceRef:**
- `apps/core/src/modules/workspace-access/internal/infrastructure/rate-limiter.ts:28-48` — `RateLimiterResult` returns `allowed`, `retryAfter`, `remaining`, but callers never forward `remaining` to response headers
- `apps/core/src/modules/workspace-access/internal/interfaces/rest/auth.routes.ts:69-75` — on 429, only `Retry-After` header is set; `X-RateLimit-Limit` and `X-RateLimit-Remaining` are never set on any response (200 or 429)
- `docs/requirements/06_Brain_API_Architecture_and_Contracts.md:142-143` — "§1.7: returned via `X-RateLimit-Limit` / `X-RateLimit-Remaining` / `Retry-After`. Defaults: read 120/min/brand, mutations 30/min/brand, NLQ 20/min/brand"

**Impact:** Clients cannot implement proactive rate-limit management — they can only react to 429s. A client hammering the auth endpoints (register, login) with retry logic cannot tell how many attempts remain before a lockout, leading to unnecessary 429s and degraded user-experience during legitimate parallel registration flows.

**rootCause:** The `RateLimiter.check()` method returns a `remaining` count, but neither the auth routes nor the BFF routes ever copy it to `reply.header()` on successful responses. The 429 path sets only `Retry-After`.

**Fix:** In auth.routes.ts and bff.routes.ts, after each successful `rateLimiter.check()`, emit `reply.header('X-RateLimit-Limit', limit).header('X-RateLimit-Remaining', rl.remaining)`. On 429, also emit `X-RateLimit-Limit: 0`. This requires the limit constant to be threaded through alongside the key in the call sites.

**tenantImpact:** All tenants — universal gap on all rate-limited endpoints.

**Detection:** Not currently detected; no monitor for missing response headers.

---

## Finding API-4

**Title:** Idempotency-Key not enforced on multiple spec-mandated mutating endpoints; zero replay-cache logic exists

**Severity:** High  
**Category:** Idempotency / API Standards  
**Priority:** P1

**evidenceRef:**
- `docs/requirements/06_Brain_API_Architecture_and_Contracts.md:144-146` — "§1.8: Every POST/PATCH/PUT/DELETE requires `Idempotency-Key: <uuid>`; result cached 24h and replayed on repeat"
- `apps/core/src/modules/workspace-access/internal/interfaces/rest/brand.routes.ts:23-101` — `POST /api/v1/brands`: no idempotency key check
- `apps/core/src/modules/workspace-access/internal/interfaces/rest/brand.routes.ts:202-258` — `PATCH /api/v1/brands/:id`: no idempotency key check
- `apps/core/src/modules/workspace-access/internal/interfaces/rest/member.routes.ts:198-251` — `PATCH /api/v1/members/:id/role`: no idempotency key check
- `apps/core/src/modules/workspace-access/internal/interfaces/rest/member.routes.ts:253-289` — `DELETE /api/v1/members/:id`: no idempotency key check
- `apps/core/src/main.ts:956-1012` — `POST /api/v1/connectors`: no idempotency key check (key accepted but presence not enforced, not validated as UUID)
- `apps/core/src/main.ts:1321` — `DELETE /api/v1/connectors/:id`: idempotency key accepted if present but falls back to `randomUUID()` — effectively opt-out, not opt-in

**Note:** Some routes DO check for the header (`POST /api/v1/invites/:id/resend`, `POST /api/v1/invites/:id/revoke`, `POST /api/v1/members/:id/suspend`, `POST /api/v1/members/:id/reactivate` at member.routes.ts:372, 428, 475, 547). But the replay-cache (same key + same body → same response; same key + different body → 409 `IDEMPOTENCY_CONFLICT`) is nowhere implemented. The service layer uses `idempotency_key` for DB-level conflict detection on some writes, but not for the HTTP-level 24h replay requirement.

**Impact:** A network retry on `POST /api/v1/brands` can create duplicate brands. A retry on `DELETE /api/v1/connectors/:id` after a timeout may succeed on the second attempt without the client knowing the first also succeeded. A retry on `PATCH /api/v1/members/:id/role` with a different body should return `409 IDEMPOTENCY_CONFLICT` but instead silently applies the second mutation.

**rootCause:** The spec was agreed after initial route files were written. Some routes were updated to require the header but neither a global middleware nor a Redis-backed 24h replay cache was implemented. The connector routes fall back to `randomUUID()` which defeats idempotency entirely (each retry is treated as a new request).

**Fix:** (1) Add a Fastify `preHandler` that, for all `POST/PATCH/PUT/DELETE`, checks `request.headers['idempotency-key']` is present and a valid UUID, returning `400 MISSING_IDEMPOTENCY_KEY` if absent. (2) Implement a Redis-backed idempotency store: on first receipt, atomically store `sha256(key + body)` with a 24h TTL and execute; on repeat, replay the stored response. On key-match + body-mismatch, return `409 IDEMPOTENCY_CONFLICT`.

**tenantImpact:** All tenants — any duplicate network operation against an unguarded mutation endpoint can produce duplicate state.

**Detection:** Detectable under network partition testing; currently no alert or test covers retry behavior.

---

## Finding API-5

**Title:** Error envelope missing `trace_id` field; 401 uses wrong machine code `UNAUTHORIZED` instead of spec-mandated `UNAUTHENTICATED`

**Severity:** Medium  
**Category:** Error Standards / Contract Drift  
**Priority:** P2

**evidenceRef:**
- `docs/requirements/06_Brain_API_Architecture_and_Contracts.md:121-134` — §1.5 specifies envelope: `{ "error": { "code": "STRING_CODE", "message": "...", "trace_id": "...", "details": {} } }`; 401 codes: `UNAUTHENTICATED`, `TOKEN_REVOKED`
- `apps/core/src/modules/workspace-access/internal/interfaces/rest/auth.routes.ts:415` — 401 returns `code: 'UNAUTHORIZED'` (not `UNAUTHENTICATED`)
- `apps/core/src/modules/workspace-access/internal/interfaces/rest/auth.routes.ts:424` — 401 returns `code: 'UNAUTHORIZED'` (not `UNAUTHENTICATED`)
- `apps/core/src/modules/workspace-access/internal/security/rbac.ts:40` — 401 returns `code: 'UNAUTHORIZED'`
- `apps/core/src/modules/workspace-access/internal/security/email-verified.guard.ts:45` — 401 returns `code: 'UNAUTHORIZED'`
- `apps/core/src/main.ts:306-322` — global error handler sends `{ request_id, error: { code, message } }` — no `trace_id` field in any error response

**Impact:** Consumers that branch on `error.code === 'UNAUTHENTICATED'` (per the contract) to distinguish auth failure from other 401s (e.g., `TOKEN_REVOKED`) will not match. The absence of `trace_id` in error responses means operators cannot link a client-reported error back to a server log entry without embedding the `request_id` in every external bug report.

**rootCause:** The error envelope comment in auth.routes.ts line 16 documents `{ request_id, error: { code, message, fields? } }` — `trace_id` was never added to the implementation. The `UNAUTHORIZED` vs `UNAUTHENTICATED` discrepancy is a copy-paste from HTTP status semantics into the machine code, diverging from the spec's chosen vocabulary.

**Fix:** (1) Add `trace_id: request.headers['x-correlation-id'] ?? requestId` to all error envelopes, or add it in the global `onSend` hook by injecting it into error payloads. (2) Replace `'UNAUTHORIZED'` → `'UNAUTHENTICATED'` in auth.routes.ts:415, auth.routes.ts:424, rbac.ts:40, email-verified.guard.ts:45, and bff.routes.ts:146, 711.

**tenantImpact:** All tenants on all unauthenticated requests.

**Detection:** Visible in any integration test asserting exact error codes; not currently caught.

---

## Finding API-6

**Title:** Large swaths of the frozen Phase-1 API catalog are entirely unimplemented with no stub or 501 response

**Severity:** Critical  
**Category:** Implementation Gap / Contract Drift  
**Priority:** P0

**evidenceRef:**
- `apps/core/src/modules/billing/index.ts:7` — `export {}; // TODO: expose the public operations of this bounded context.` — zero implementation; doc §3.9 mandates `GET /billing/subscription`, `GET /billing/preview`, `GET /billing/invoices`, `POST /billing/period/{period}/seal`, etc.
- `apps/core/src/modules/recommendation/index.ts:7` — `export {}; // TODO` — zero implementation; doc §3.11 mandates `GET /api/v1/recommendations` and `POST /api/v1/recommendations/{id}/respond`
- `apps/core/src/modules/identity/index.ts:7` — `export {}; // TODO` — zero implementation; doc §3.6 mandates `GET /api/v1/customers`, `GET /api/v1/customers/{brainId}`, `POST /api/v1/identity/merge`, `POST /api/v1/identity/unmerge`, `GET /api/v1/identity/review-queue`
- No route file found for: `/api/v1/metrics/query`, `/api/v1/metrics/catalog`, `/api/v1/metrics/{metricId}` (doc §3.7 / §4.7)
- No route file found for: `/api/v1/privacy/erasure-requests` (doc §3.16 / §4.15)
- No route file found for: `/api/v1/customers/{brainId}/consent` (doc §3.6 / §4.16)
- No route file found for: `/api/v1/ai/nlq` (NLQ lives under `/api/v1/ask` — path diverges from §7.1 spec)
- No route file found for: `GET /api/v1/ai/queries/{queryId}` (doc §7.7 / §4.17)
- No route file found for: `GET /api/v1/audit-log` (doc §3.13)
- No route file found for: `GET /api/v1/connectors/{connectorId}/jobs`, `GET /api/v1/connectors/{connectorId}/jobs/{jobId}` (doc §3.5 / §4.13)
- No route file found for: `GET /api/v1/jobs`, `GET /api/v1/jobs/{jobRunId}` (doc §3.15 / §4.14)
- `apps/core/src/modules/frontend-api/internal/bff.routes.ts:1218` — NLQ is exposed as `POST /api/v1/ask`, not `POST /api/v1/ai/nlq` as mandated by §7.1

**Impact:** Phase-1 exit criteria (doc 04 §O.3) cannot be met. Any client (web app, external integrator, MCP tools) relying on the frozen contract will receive 404 on billing, recommendations, customer 360, identity operations, metrics catalog, privacy/DSAR, audit log, connector job visibility, and AI query history. The `/api/v1/ask` vs `/api/v1/ai/nlq` path divergence is a breaking change relative to the spec and will cause SDK-generated clients to target the wrong path.

**rootCause:** These modules are acknowledged stubs in the monorepo's incremental delivery plan. The `TODO` comments confirm awareness. However, the frozen contract document (v1.2) does not indicate any of these are deferred to Phase 2+ — they are all listed under Phase 1 §3 and §4.

**Fix:** For each missing endpoint: implement or return `501 Not Implemented` with a machine-stable `error.code: 'NOT_IMPLEMENTED'` response. For the NLQ path: register an alias at `/api/v1/ai/nlq` that delegates to the same `askBrain` handler, or migrate the existing `/api/v1/ask` to `/api/v1/ai/nlq` and add a redirect. Update the release-readiness tracking to reflect which §3/§4 endpoints remain unimplemented before Phase-1 exit.

**tenantImpact:** All tenants — structural absence means zero tenants can exercise these capabilities via the documented API surface.

**Detection:** Any automated contract test against the OpenAPI spec would immediately expose 404s; currently no such test suite is wired to CI.

---

## Finding API-7 (appended from continued review)

**Title:** Metric-bearing API responses omit mandatory `metric_version`, `recognition_label`, and `confidence` envelope fields from §1.4

**Severity:** Medium  
**Category:** Response Standards / Contract Drift  
**Priority:** P2

**evidenceRef:**
- `docs/requirements/06_Brain_API_Architecture_and_Contracts.md:116-117` — "§1.4: Every metric-bearing response carries `metric_version`, `as_of`, `recognition_label` (`provisional|settling|finalized`), and `confidence` where applicable"
- `apps/core/src/modules/analytics/internal/domain/metrics/revenue-snapshot.ts:35-47` — `RevenueSnapshot` type has `state` and `as_of` but no `metric_version`, `recognition_label`, or `confidence` fields
- `apps/core/src/modules/analytics/internal/application/queries/get-kpi-summary.ts:11-18` — `KpiSummaryDto` has no `metric_version`, `recognition_label`, or `confidence`
- `packages/metric-engine/src/kpi-summary.ts:18-31` — `KpiSummaryResult` has no `metric_version` or `recognition_label`
- `apps/core/src/modules/frontend-api/internal/bff.routes.ts:1209-1215` — `/api/v1/dashboard/realized-revenue` response wraps `snapshot` directly with no version or label injection

**Impact:** Consumers cannot determine whether a number they received is finalized, provisional, or settling without issuing a second call. The `metric_version` field is the key for cache invalidation (§1.14: "a definition change auto-busts"), reproducible reports (§4.7), and billing audit trails. Absent `metric_version`, a cached result cannot be safely served after a metric definition change — stale numbers can silently reach billing-sensitive decisions.

**rootCause:** The `RevenueSnapshot` and `KpiSummaryDto` domain objects were designed before the §1.4 response standards were finalized in v1.2. The metric engine returns data but does not tag it with a version string. No layer between the engine and the route enforces the envelope.

**Fix:** (1) Add `metric_version: MetricVersion` and `recognition_label: 'provisional' | 'settling' | 'finalized' | 'mixed'` fields to `RevenueSnapshot`, `KpiSummaryDto`, and all other metric-bearing DTOs. (2) The metric engine registry (`packages/metric-engine/src/registry.ts`) already tracks `MetricVersion` — thread it through `computeRealizedRevenue`, `computeKpiSummary`, etc. (3) Add a conformance test that any route returning `data.realized_minor` or `data.kpis` also returns `metric_version` and `recognition_label`.

**tenantImpact:** All tenants reading any metric endpoint; particularly impactful for billing-integrity and multi-period comparisons.

**Detection:** Not currently detected; would surface when a client renders stale finalized numbers after a metric definition change.

---

*End of Pass 5: API Audit. Companion reference: `docs/requirements/06_Brain_API_Architecture_and_Contracts.md` (v1.2 frozen).*
