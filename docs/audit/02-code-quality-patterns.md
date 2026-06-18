# Brain Engineering Excellence Audit — PASS 3 (Code Quality) + PASS 4 (Design Patterns)

**Board:** code-quality · **Reviewer:** Independent principal engineer · **Date:** 2026-06-19
**Surface reviewed:** `apps/{core,collector,stream-worker,web}`, `packages/*` (54,597 LOC of non-test TS)

---

## Executive context

The codebase is, on the whole, **above industry median** for an early-stage platform: strong DDD bounded-context layout (`domain/application/infrastructure/interfaces` per module), near-zero `any` (only 7 files contain `: any`/`as any`, mostly tests), a clean versioned Registry in `packages/metric-engine`, correct DDD policy objects in the notification module, constructor-injected DI in the stream-worker consumers, and well-decomposed repull jobs. The findings below are concentrated in a handful of **god-files**, **systematic missing abstractions** (no shared HTTP error envelope, no shared cursor/sync-state util), **duplicated contract types**, and **dead scaffold modules**. None are Critical; the High-severity items are maintainability/drift hazards that will compound as the team scales.

---

## FINDINGS

### F-01 — `bff.routes.ts` is a 2,538-line god-file: one function, 46 routes, 8 positional params
**Severity:** High · **Category:** Complexity / God-object / Maintainability

**Evidence:** `apps/core/src/modules/frontend-api/internal/bff.routes.ts`
- Single exported function `registerBffRoutes(...)` spans the entire file (L77–L2538) and registers **46 routes** (`grep fastify.(get|post|...)` = 46; first L94, last L2522).
- Signature has **8 positional parameters, 6 of them optional** (L77–86): `(fastify, authService, pool?, cookieSecret='', rateLimiter?, rawPool?, onboardingService?, srPool?)`. Call site `apps/core/src/main.ts:477` passes all 8 positionally.
- 154 hand-rolled error envelopes inside this one file (see F-04).
- The 59-line single-line `import { getRevenueMetrics, getRevenueTimeseries, ... 30 symbols ... }` at L59 is a barrel fan-out hotspot.

**Impact (prod terms):** Any change to BFF auth/dashboard logic forces a reviewer to reason about a 2.5k-line closure with shared mutable closure state (`sessionPreHandler`, helpers). High merge-conflict surface for a team; the 8-arg positional constructor makes mis-wiring (e.g. swapping `rawPool`/`pool`) a silent class of bug that typechecks if both are `Pool`-shaped.
**Root Cause:** BFF grew route-by-route without extraction into sub-routers per concern (auth / dashboard / proxy).
**Recommended Fix:** Split into `bff/auth.routes.ts`, `bff/dashboard.routes.ts`, `bff/proxy.routes.ts`, each a Fastify plugin; replace the 8-arg signature with a single `BffDeps` options object.
**Priority:** P2 · **Tenant Impact:** Multi-tenant — the file is the sole edge for all brands; a regression here is blast-radius-all. · **Detection:** surfaces as review friction + occasional 500s traced to mis-ordered args; not alertable.

---

### F-02 — BFF edge layer issues raw OLTP SQL against domain tables, bypassing its own repositories (leaky abstraction)
**Severity:** High · **Category:** Leaky abstraction / DDD layering violation

**Evidence:** `apps/core/src/modules/frontend-api/internal/bff.routes.ts` — 10 inline SQL statements against `organization`, `brand`, `membership`, `connector_instance`, `pixel_installation`, `app_user`:
- L778-801 `SELECT id,name FROM organization` / `SELECT ... FROM brand ...` / `SELECT COUNT(DISTINCT app_user_id) ... FROM membership`
- L863-869 `SELECT ... FROM connector_instance ci LEFT JOIN connector_sync_status ...`

The `interfaces/` (edge) layer holds schema knowledge that already exists in `OrganizationRepository`, `BrandRepository`, `MembershipRepository` (`apps/core/src/modules/workspace-access/internal/infrastructure/repositories.ts:478/619/775`) and `PgConnectorInstanceRepository`. Per the loaded **domain-driven-design** skill: "Routes are THIN — parse/validate, call the use-case, map the result… A repository returning ORM rows… is an anti-pattern."

**Impact (prod terms):** A schema change (e.g. renaming `membership.brand_id`) ripples into edge route handlers that no repository test covers; the `COUNT(DISTINCT app_user_id)` double-counting workaround (L796-798) is business logic living in a route, un-reusable by any RPC/consumer path (Single-Primitive violation). RLS scoping correctness now depends on each ad-hoc `QueryContext` being passed correctly per query instead of being centralized.
**Root Cause:** Dashboard-aggregate endpoints were built directly in the BFF for speed rather than through workspace-access query use-cases.
**Recommended Fix:** Move each `SELECT` into a query use-case / repository method in the owning bounded context; BFF calls the use-case.
**Priority:** P2 · **Tenant Impact:** Multi-tenant — these are tenant-scoped reads; correctness of brand isolation is now spread across inline queries. · **Detection:** surfaces as a cross-brand count bug or a NULL-render after a schema migration.

---

### F-03 — Three webhook handlers re-implement an identical 8-step pipeline (~1,256 LOC of structural duplication)
**Severity:** High · **Category:** Duplication / Missing abstraction

**Evidence:**
- `shopfloWebhookHandler.ts` (399 L), `razorpayWebhookHandler.ts` (474 L), `shopifyWebhookHandler.ts` (383 L) under `apps/core/src/modules/connector/sources/*/*/interfaces/webhooks/`.
- Each independently re-codes the same pipeline: raw-body guard → JSON parse → connector resolution (`SELECT … FROM resolve_*_connector_by_*`) → secret fetch → HMAC validate → brand-from-row → idempotency → enqueue → error envelopes. Compare `shopflo` L107-216 with `razorpay` L120-220 — structurally identical, only the header name and `*Hmac` helper differ.
- Each repeats the same `reply.code(4xx).send({ request_id, error: {...} })` block 10–18 times (`grep` per file: shopflo 16, razorpay 18, shopify 10).

**Impact (prod terms):** A fix to the security-critical pipeline (e.g. the HMAC-before-parse ordering, or a new replay-window rule) must be applied 3× and **will drift** — already visible in divergent error counts. New connectors copy-paste a 400-line file. Divergence in a security pipeline is how one channel ends up missing a guard another channel has.
**Root Cause:** No `registerWebhookRoute(fastify, { signatureHeader, hmac, resolveConnector, handle })` template; the `*Hmac` helper and `RedisDedupAdapter` were extracted but the orchestration was not.
**Recommended Fix:** Extract a single `withVerifiedWebhook()` higher-order handler taking a per-provider strategy ({headerName, hmacValidator, connectorResolver, eventRouter}); the three files shrink to a strategy + event-router each.
**Priority:** P2 · **Tenant Impact:** Multi-tenant — webhooks carry every brand's commerce events; a drifted guard is a per-channel isolation/integrity risk. · **Detection:** surfaces as an incident when one connector mishandles an edge case the others fixed.

---

### F-04 — No shared HTTP error-envelope helper — 154 hand-rolled `{request_id, error}` blocks in one file (250+ across core)
**Severity:** Medium · **Category:** Missing abstraction / Duplication

**Evidence:** `grep "request_id: requestId,"` counts: `bff.routes.ts`=154, `member.routes.ts`=41, `main.ts`=40, `razorpayWebhookHandler.ts`=29, `auth.routes.ts`=28, `shopfloWebhookHandler.ts`=27. A search for any `export function sendError|errorReply|replyError|envelope` returns **nothing** — no central helper exists. Every handler open-codes `return reply.code(X).send({ request_id: requestId, error: { code: 'X', message: 'Y' } })`.

**Impact (prod terms):** The error contract (`request_id` + `error.code` + `error.message`) — which the audit brief itself flags as a VETO surface — is enforced only by copy-paste discipline. One forgotten `request_id` (and there are 250+ chances) produces an error response with no correlation ID, which is exactly the Stage-4 veto condition. No single place to add `trace_id` propagation or PII redaction to error bodies.
**Root Cause:** Error shaping was never centralized into a Fastify `setErrorHandler` + a `fail(reply, status, code, msg)` util.
**Recommended Fix:** One `reply.fail(status, code, message, fields?)` decorator (or `setErrorHandler`) that injects `request_id`/`trace_id` from the request context automatically; replace all open-coded envelopes.
**Priority:** P2 · **Tenant Impact:** Multi-tenant (correlation-ID loss affects all brands' debuggability). · **Detection:** surfaces as un-correlatable 4xx/5xx in the log store during an incident.

---

### F-05 — Cursor/sync-state plumbing duplicated across 4+ stream-worker repull jobs (no shared util)
**Severity:** Medium · **Category:** Duplication / Missing abstraction

**Evidence:** `async function acquireCursorLock / getCursorValue / upsertCursorValue / setSyncState` are **privately redefined** in:
- `apps/stream-worker/src/jobs/razorpay-settlement-repull/run.ts:360/414/445/479`
- `apps/stream-worker/src/jobs/gokwik-awb-repull/run.ts:296/.../405`
- `apps/stream-worker/src/jobs/shopify-repull/run.ts:440`
- `apps/stream-worker/src/jobs/meta-spend-repull/run.ts`

A search for an exported shared version outside `/jobs/` returns nothing. Each job carries its own copy of the cursor-lock advisory-lock + sync-state-transition logic.

**Impact (prod terms):** The cursor/lock semantics (advisory lock acquisition, state machine `idle→syncing→…`) are the correctness core of every backfill; a fix in one job (e.g. lock-key collision, stuck-`syncing` recovery) silently won't reach the other three. Inconsistent state transitions across connectors are an operational-debugging tax.
**Root Cause:** Repull jobs were authored per-connector, copying the first job's scaffolding.
**Recommended Fix:** Extract `infrastructure/pg/CursorStore.ts` + `SyncStateMachine.ts` (or a `RepullRunner` template); jobs pass only their resource-list + page-fetch fn.
**Priority:** P2 · **Tenant Impact:** Multi-tenant — backfills run per brand; a drifted state machine can leave one brand's sync stuck. · **Detection:** surfaces as a stuck `connector_sync_status.state='syncing'` for one provider only.

---

### F-06 — Dead/placeholder bounded-context modules misrepresent the architecture map
**Severity:** Medium · **Category:** Dead code / Misleading structure

**Evidence:** Four `apps/core/src/modules/<ctx>` are **7-line empty stubs** — the entire module is `export {}; // TODO: expose the public operations of this bounded context.`:
- `identity/index.ts`, `recommendation/index.ts`, `job-orchestration/index.ts`, `billing/index.ts` (each 1 file, 7 LOC).

The audit brief and `domain-driven-design` skill list these as live bounded contexts (e.g. billing is explicitly in the Backend Engineer's lane). The real identity logic lives in `packages/identity-core` + `apps/stream-worker`; billing/metering has no implementation at all in `apps/core`.

**Impact (prod terms):** The directory tree advertises capabilities (`billing/`, `recommendation/`) that do not exist, misleading onboarding engineers and any "is feature X built?" audit. Empty modules that are imported nowhere are dead scaffolding.
**Root Cause:** Bounded contexts were scaffolded up front per the DDD skeleton but never implemented; the placeholders were never removed or marked.
**Recommended Fix:** Either delete the empty module dirs until implemented, or replace the stub with a documented `@status: not-implemented` marker and exclude from the bounded-context map. For billing specifically, confirm against the Canon whether metering belongs here.
**Priority:** P3 · **Tenant Impact:** N/A (no runtime code). · **Detection:** surfaces only via code audit / "where is billing?" confusion.

---

### F-07 — `apps/web/lib/api/types.ts` is a 1,309-line hand-maintained mirror of `packages/contracts` (contract drift hazard)
**Severity:** Medium · **Category:** Duplication / Single-source-of-truth violation

**Evidence:** `apps/web/lib/api/types.ts:1-13` header: *"NOTE: Track 0 (packages/contracts) will publish these as Zod schemas. Until those are committed, we declare the TypeScript types here so the frontend can typecheck without a running backend."* Yet `packages/contracts/src/api/` already contains the canonical Zod schemas: `auth.api.v1.ts`, `brand.api.v1.ts`, `member.api.v1.ts`, `workspace.api.v1.ts`, `connector.api.v1.ts`, `pixel.api.v1.ts`. The web app imports `@brain/contracts` in only **4 files**, while maintaining 1,309 lines of parallel types + a 1,526-line `client.ts`.

**Impact (prod terms):** Two definitions exist for one API contract. When the BFF/contract changes, the web types must be hand-updated; nothing enforces parity, so the frontend can typecheck green against a stale shape and break at runtime. The stated "until committed" precondition is already false (schemas are committed), so the workaround is now pure tech debt.
**Root Cause:** A bootstrapping decoupling that outlived its reason; the contracts package landed but the web types were not migrated to derive from it (`z.infer`).
**Recommended Fix:** Replace hand-written interfaces with `type X = z.infer<typeof XSchema>` re-exported from `@brain/contracts`; delete the duplicated declarations.
**Priority:** P2 · **Tenant Impact:** N/A (type-level), but a runtime shape mismatch affects all users. · **Detection:** surfaces as a runtime "cannot read property of undefined" in the web app after a backend contract change that typechecked.

---

### F-08 — `auth.service.rotateRefreshToken` reaches around its own repository with embedded raw SQL + txn management
**Severity:** Medium · **Category:** Leaky abstraction / DDD layering

**Evidence:** `apps/core/src/modules/workspace-access/internal/application/auth.service.ts:481-540+`. The application-layer method opens a `rawPgPool` client, runs `BEGIN`, and issues a raw `SELECT … FROM user_session … FOR UPDATE` (L506-510), a raw `set_config('app.current_user_id', …)` (L528-531), and a raw `UPDATE user_session …` family-wipe (L535-540) — duplicating schema knowledge that `UserSessionRepository.findForUpdateByRefreshHash` (`repositories.ts:220`), `.revokeFamilyRaw` (`:275`), `.markRotatedRaw` (`:258`) already encapsulate.

**Impact (prod terms):** The single most security-sensitive flow (refresh-token rotation + replay family-wipe) keeps a second copy of the `user_session` schema and RLS-GUC handling inside the service layer. A column/policy change must be made in two places; the repository's tested query path and the service's inline path can diverge. There is a documented reason (GUC must be set after the SELECT reveals `app_user_id`), but the duplication is avoidable by passing the raw client into repo methods.
**Root Cause:** GUC-ordering constraint led to inlining raw SQL rather than threading the raw client through repository methods (which the repo already supports via `*Raw` variants).
**Recommended Fix:** Route the FOR-UPDATE lookup and family-wipe through `UserSessionRepository` methods that accept the raw `PoolClient`; keep only `BEGIN/COMMIT/set_config` orchestration in the service.
**Priority:** P3 · **Tenant Impact:** Multi-tenant — session integrity is per-user across all brands. · **Detection:** surfaces as a rotation/replay regression after a `user_session` schema change.

---

### F-09 — Cross-bounded-context code import: checkout context imports payment context's `RedisDedupAdapter`
**Severity:** Low · **Category:** DDD boundary violation / coupling

**Evidence:** `apps/core/src/modules/connector/sources/checkout/shopflo/interfaces/webhooks/shopfloWebhookHandler.ts:38`:
`import { RedisDedupAdapter } from '../../../../payment/razorpay/infrastructure/RedisDedupAdapter.js';`
The shopflo (checkout) handler reaches four levels up into the razorpay (payment) source's `infrastructure/`. The DDD skill's anti-patterns list: *"Two services [contexts] sharing a `domain/` [infrastructure] module (share via contracts/events, not code)."*

**Impact (prod terms):** A change to razorpay's dedup adapter (a payment-context concern) silently affects shopflo webhook idempotency. The dependency direction (checkout→payment) is accidental, not designed.
**Root Cause:** A genuinely shared utility (Redis idempotency) was placed inside one connector's infra folder instead of a shared connector-infra package.
**Recommended Fix:** Promote `RedisDedupAdapter` to `connector/internal/infrastructure/` (or a `@brain/` package) shared by all connector sources.
**Priority:** P3 · **Tenant Impact:** Multi-tenant (webhook dedup is per-brand). · **Detection:** code audit; or an incident where a payment-side change breaks checkout dedup.

---

### F-10 — Repositories instantiated per-method (`new XxxRepository(client)` ×22 in auth.service) — Factory/DI under-use
**Severity:** Low · **Category:** Design pattern (DI under-use) / minor duplication

**Evidence:** `new XxxRepository(client)` appears 22× in `auth.service.ts`, 9× in `brand.service.ts`, 9× in `invite.service.ts`, 7× in `workspace.service.ts` (`grep -c`). Each method re-creates `AppUserRepository`, `UserSessionRepository`, `MembershipRepository`, `OrganizationRepository` against the freshly-acquired client (e.g. `login()` L354-357, `issueSession()` L412-414).

**Impact (prod terms):** Low — the repos are stateless wrappers over a per-request client, so this is correct, just verbose. But it couples every service method to concrete repository classes (no interface seam), making the repos hard to mock in unit tests and obscuring the dependency surface of each method.
**Root Cause:** Repositories are bound to a `client` rather than the pool, so they can't be constructor-injected once; a per-client factory was the path of least resistance.
**Recommended Fix:** Introduce a `RepositoryFactory(client)` or repo interfaces injected into the service constructor and bound to a transaction context — removes the repeated `new` and enables interface-based testing.
**Priority:** P3 · **Tenant Impact:** N/A. · **Detection:** code audit / test-mocking friction.

---

## Patterns assessed — what is DONE WELL (counter-evidence, for balance)

- **Registry/Strategy (correct):** `packages/metric-engine/src/registry.ts` — versioned-immutable-key metric registry, `resolveMetric()` seam, zero-model deterministic; `connector/catalog/dispatch.ts` — clean Strategy+Registry OAuth dispatch table (unknown→null→caller 4xx, no base-class over-engineering).
- **DDD policy objects (correct):** `notification/internal/compliance/policies/{send-window,consent,ncpr,dlt}.policy.ts` — encapsulated rules, not if-ladders in routes.
- **DI (correct) in stream-worker:** `SettlementLedgerConsumer` (`interfaces/consumers/SettlementLedgerConsumer.ts:88-104`) — constructor-injected `kafka`, `ledgerWriter`, `mapPool`, `dlqProducer`.
- **Decomposition (correct):** the 588-line `razorpay-settlement-repull/run.ts` is 9 focused functions, not a god-function.
- **Type discipline:** only 7 source files contain `: any`/`as any`; `as unknown as` is concentrated in tests + legit Fastify-plugin casts.
- **Money:** ledger writers operate in integer minor units (`LedgerWriter.writeXxx` params use `*_minor`), consistent with the Money value-object rule.

---

## VERDICT (code-quality domain)

The Brain backend is **structurally sound and well-typed**, with genuinely good DDD layering, a model-grade metric Registry, correct policy/strategy/DI usage in the services that matter most, and disciplined typing. The debt is **localized and systematic rather than pervasive**: a small number of god-files (`bff.routes.ts` 2.5k L, `main.ts` 1.6k L), three classes of **missing-abstraction duplication** (no shared error envelope → 250+ hand-rolled blocks; per-job cursor/sync-state plumbing ×4; three copy-pasted webhook pipelines), a 1.3k-line **hand-maintained type mirror** of an already-committed contracts package, **dead placeholder bounded-context modules** (billing/identity/recommendation/job-orchestration) that misrepresent the capability map, and a few **leaky abstractions** where the edge/service layer reaches around its own repositories with raw SQL. None are Critical and none block correctness today, but F-01 through F-05 and F-07 are the kind of debt that compounds quadratically as connectors/endpoints/engineers are added — they should be paid down before the next wave of feature surface, with the shared error-envelope helper (F-04) and webhook-template extraction (F-03) as the highest-leverage fixes.
