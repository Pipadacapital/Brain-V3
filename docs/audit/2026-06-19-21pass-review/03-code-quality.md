# Pass 3: Code Quality Audit (code-quality)

**Board:** code-quality
**Date:** 2026-06-19

## Verdict

The codebase demonstrates sound architectural discipline — pool-per-repository, GUC-before-query invariants, and append-only ledger design are consistent throughout. However, five structural quality defects were found: (1) cursor management and sync-state functions are copied verbatim across four repull jobs with self-acknowledged clone comments; (2) the entire Kafka consumer retry/DLQ scaffolding (MAX_RETRY, retryCount map, DLQ routing) is duplicated across five consumers without a shared base; (3) `suspendUser` and `reactivateUser` in `auth.service.ts` each re-implement the same 40-line actor/target membership authority check inline, as does `updateMemberRole` in `invite.service.ts`; (4) `generateToken()` is defined identically in both `auth.service.ts` and `invite.service.ts` in the same package; and (5) four `new PgPool({ connectionString, max: 3 })` in `main.ts` and every repull-job pool omit `idleTimeoutMillis`/`statement_timeout`, inconsistent with the infrastructure repositories that do set them. A fire-and-forget `Promise.resolve().then(...)` at `auth.service.ts:254` is intentional and documented (MA-15), but is not `void`-prefixed, leaving TypeScript's floating-promise lint rule incomplete. The `user_full_name` field in `MembershipRepository.listByOrganization` is hard-coded to the member's email address (`r.email`) rather than a name — an acknowledged temporary placeholder that could escape if the feature backlog stalls.

**Severity counts:** Critical 0 · High 1 · Medium 4 · Low 2

---

## Finding CQ-1

**Title:** Cursor management and sync-state functions copied verbatim across four repull jobs

**Severity:** High

**Category:** Duplication / Maintainability

**evidenceRef:**
- `apps/stream-worker/src/jobs/razorpay-settlement-repull/run.ts:360-520` (`acquireCursorLock`, `getCursorValue`, `upsertCursorValue`, `setSyncState`)
- `apps/stream-worker/src/jobs/gokwik-awb-repull/run.ts:296-438` (same four functions; comment at line 403 says "mirrors razorpay-settlement-repull setSyncState exactly")
- `apps/stream-worker/src/jobs/meta-spend-repull/run.ts:268-365` (same three; comment at line 266 says "mirror razorpay-settlement-repull exactly")
- `apps/stream-worker/src/jobs/shopify-repull/run.ts:440-497` (`setSyncState` only; re-exported at line 497)

**Impact:** A bug fix or security change (e.g., adding `connectionTimeoutMillis` to cursor pool, or hardening the `SET LOCAL` GUC path) must be applied in four independent copies. One copy has already drifted: `razorpay-settlement-repull` and `gokwik-awb-repull` pass three GUCs in one SELECT (`current_brand_id`, `current_user_id`, `current_workspace_id`) inside `acquireCursorLock`, while `meta-spend-repull` does the same; a future change that adds a fourth GUC will silently be missed in whichever copy isn't updated.

**Root Cause:** Each repull job was built as a "near-verbatim clone" (gokwik-awb-repull/run.ts:4 — docstring uses those words). The comments acknowledge the copy but do not enforce sharing because no shared utility module was extracted.

**Fix:** Extract a `packages/connector-cursor` (or `apps/stream-worker/src/infrastructure/pg/CursorRepository.ts`) exporting `acquireCursorLock`, `getCursorValue`, `upsertCursorValue`, and `setSyncState`. Each repull job imports and calls them. `shopify-repull` already exports its `setSyncState` — that should be the canonical. Delete the four private copies.

**Priority:** P1

**tenantImpact:** Multi-tenant — all brands are affected if a cursor-state bug is patched in one copy but not others. A brand whose connector maps to the un-patched copy silently loses the fix.

**Detection:** No alert fires today. The only current signal is that the four copies are tested by separate e2e tests; a divergence manifests only in a failing e2e for one connector while others pass.

---

## Finding CQ-2

**Title:** Kafka consumer DLQ/retry scaffold duplicated across five consumer classes

**Severity:** Medium

**Category:** Duplication / Abstraction

**evidenceRef:**
- `apps/stream-worker/src/interfaces/consumers/CollectorEventConsumer.ts:25-34` (`MAX_RETRY`, `type RetryKey`, `retryCount` map)
- `apps/stream-worker/src/interfaces/consumers/ConsentSuppressorConsumer.ts:27-33` (identical scaffold)
- `apps/stream-worker/src/interfaces/consumers/CapiDeletionConsumer.ts:33-41` (identical scaffold)
- `apps/stream-worker/src/interfaces/consumers/BackfillOrderConsumer.ts:35-41` (identical scaffold)
- `apps/stream-worker/src/identity-bridge/IdentityBridgeConsumer.ts:21-27` (identical scaffold)

**Impact:** MAX_RETRY is currently 5 across all consumers. If the value needs to change for a single consumer (e.g., consent must not retry beyond 3 for DPDP SLA reasons), there is no per-consumer override — the constant must be changed in all five files or a per-class override added ad-hoc. A bug in the retry-key format (`${partition}:${offset}`) must be fixed in five places.

**Root Cause:** Each consumer was written independently. The docstring for `ConsentSuppressorConsumer` says "Mirrors IdentityBridgeConsumer / CollectorEventConsumer" (line 6), confirming deliberate copy.

**Fix:** Extract an abstract `BaseKafkaConsumer<TUseCase>` or a `withRetryAndDlq(consumer, useCase, handler)` higher-order function that encapsulates `MAX_RETRY`, `retryCount`, and the DLQ routing loop. Each concrete consumer calls it with its own use-case handler. This also makes it trivial to change per-consumer retry limits.

**Priority:** P2

**tenantImpact:** Single-tenant blast radius per copy (each consumer serves all brands, not a per-brand fork). A retry-logic bug affects all tenants equally.

**Detection:** Unit test `dlq.unit.test.ts` tests one consumer's DLQ path; the other consumers' DLQ paths are covered only by e2e tests. A regression in the retry logic for one consumer may not be caught until e2e.

---

## Finding CQ-3

**Title:** Actor/target authority check duplicated inline in three service methods

**Severity:** Medium

**Category:** Duplication / Complexity

**evidenceRef:**
- `apps/core/src/modules/workspace-access/internal/application/auth.service.ts:900-939` (`suspendUser` — actor membership query, role guard, hierarchy check, 40 lines)
- `apps/core/src/modules/workspace-access/internal/application/auth.service.ts:1008-1047` (`reactivateUser` — identical 40-line block; comment at line 1037 says "same rules as suspend")
- `apps/core/src/modules/workspace-access/internal/application/invite.service.ts:404-423` (`updateMemberRole` — requester membership query + hierarchy check)

**Impact:** The ownership/authority rules are stated four times with slightly different error messages (`'Cannot suspend an Owner.'` vs `'Cannot reactivate an Owner.'`). If a new role is added above `brand_admin`, all four copies must be updated. The `actorIdx` variable is computed in both `suspendUser` and `reactivateUser` but is never used in either (only `targetIdx` appears in the comparison `actorIdx <= targetIdx`), a dead local variable that signals copy-paste without review.

**Root Cause:** `suspendUser` and `reactivateUser` were written sequentially (auth.service.ts comments say "D-1: structurally DISTINCT from suspend — not a shared helper with a flag"), which is correct design intent but leaves the authority-check logic shared by prose only.

**Fix:** Extract a private `assertActorAuthority(rawClient, actorId, appUserId, organizationId): Promise<{ actor: ActorRow; target: TargetRow }>` helper that runs the three-step check (actor fetch → guard → target fetch → hierarchy check) and throws `AuthError` on failure. Call it from both `suspendUser` and `reactivateUser`. `updateMemberRole` in `invite.service.ts` uses `InviteError` and a slightly different hierarchy path (role-grant bound rather than suspend bound) — it can share the DB query but needs its own error type, so a separate `assertInviterAuthority` helper is appropriate.

**Priority:** P2

**tenantImpact:** Low blast radius — a role-hierarchy bug affects only users with `brand_admin` or `owner` role. No cross-tenant leakage risk.

**Detection:** `critical-paths.test.ts` covers suspend; no alert fires on the dead `actorIdx` variable (TypeScript does not warn on unused variables by default if `noUnusedLocals` is off).

---

## Finding CQ-4

**Title:** `generateToken()` defined identically in `auth.service.ts` and `invite.service.ts`

**Severity:** Medium

**Category:** Duplication / Dead Code Risk

**evidenceRef:**
- `apps/core/src/modules/workspace-access/internal/application/auth.service.ts:85-90` (private `function generateToken()`)
- `apps/core/src/modules/workspace-access/internal/application/invite.service.ts:38-43` (identical private `function generateToken()`)

**Impact:** If the token size (currently 32 bytes → 64 hex) or hash algorithm needs to change for compliance, both copies must be updated independently. A change in one file will not be caught by TypeScript or linting until a test that crosses both files fails.

**Root Cause:** `invite.service.ts` imports `maskEmail` from `auth.service.ts` (line 25) but not `generateToken`, suggesting it was copied rather than shared. The two functions are byte-for-byte identical.

**Fix:** Export `generateToken` from `auth.service.ts` (or move it to a `token-utils.ts` utility module within the `workspace-access/internal` boundary) and import it in `invite.service.ts`. Since it is pure and has no side effects, there is no coupling risk.

**Priority:** P2

**tenantImpact:** None directly. A token-generation regression would affect all users equally.

**Detection:** No automated detection. Only a code search or a future PR reviewer would catch divergence.

---

## Finding CQ-5

**Title:** Multiple `new PgPool({ connectionString, max: 3 })` in `main.ts` and repull jobs omit `idleTimeoutMillis`/`statement_timeout`

**Severity:** Low

**Category:** Configuration Consistency / Resource Management

**evidenceRef:**
- `apps/stream-worker/src/main.ts:199` (`settlementMapPool = new PgPool({ connectionString: dbUrl, max: 3 })`)
- `apps/stream-worker/src/main.ts:243` (`syncClaimerPool = new PgPool({ connectionString: dbUrl, max: 3 })`)
- `apps/stream-worker/src/main.ts:263` (`dqPool = new PgPool({ connectionString: dbUrl, max: 3 })`)
- `apps/stream-worker/src/main.ts:294` (`ingestSchedulerPool = new PgPool({ connectionString: dbUrl, max: 3 })`)
- `apps/stream-worker/src/jobs/razorpay-settlement-repull/run.ts:99` (`new Pool({ connectionString: DB_URL, max: 5 })`)
- `apps/stream-worker/src/jobs/gokwik-awb-repull/run.ts:79` (`new Pool({ connectionString: DB_URL, max: 5 })`)
- `apps/stream-worker/src/jobs/meta-spend-repull/run.ts:72` (`new Pool({ connectionString: DB_URL, max: 5 })`)
- `apps/stream-worker/src/jobs/shopify-repull/run.ts:82` (`new Pool({ connectionString: DB_URL, max: 3 })`)

All of these omit `idleTimeoutMillis` and `statement_timeout`. By contrast, the infrastructure repositories (`LedgerWriter.ts:67-68`, `IdentityRepository.ts:45-46`, `BronzeRepository.ts:36-37`, `ConsentRepository.ts:59-60`) consistently set both.

**Impact:** Pools without `idleTimeoutMillis` keep connections open indefinitely, depleting the Postgres connection limit under sustained load. Pools without `statement_timeout` allow a stuck query (e.g., a long-running GUC or cursor lock contention) to hold a connection forever, which in the scheduler loop prevents graceful shutdown. Under heavy backfill + scheduled ingest simultaneously, the 8 pools × max=3–5 could open up to ~32 connections from stream-worker alone — many without a timeout floor.

**Root Cause:** Each repull job was written as a standalone script with a minimal pool config. The infrastructure-layer repositories are the "owned" pool abstraction; the per-job pools are one-off configurations not governed by the same discipline.

**Fix:** Add `idleTimeoutMillis: 30_000, statement_timeout: 15_000` to all bare `new Pool(...)` calls. Alternatively, export a `createWorkerPool(connectionString, max)` factory from `apps/stream-worker/src/infrastructure/pg/pool.ts` that always sets sensible defaults, and replace all bare `new Pool` calls with it.

**Priority:** P3

**tenantImpact:** Service-wide — connection exhaustion affects all tenants. A single slow query in one tenant's repull can block another tenant's sync if the pool is shared (not isolated per-brand, which it is not).

**Detection:** Postgres `max_connections` alarm (if configured) would surface connection exhaustion. No statement-timeout metric is currently collected; a stuck query would only appear in PG slow-query logs.

---

## Finding CQ-6

**Title:** `Promise.resolve().then(...)` at `auth.service.ts:254` is not `void`-prefixed — floating promise

**Severity:** Low

**Category:** Error Handling / Lint

**evidenceRef:**
- `apps/core/src/modules/workspace-access/internal/application/auth.service.ts:254` (`Promise.resolve().then(async () => { ... });`)

**Impact:** The intent is documented (MA-15 fire-and-forget to equalize timing). However, the returned Promise is not `void`-prefixed, meaning `@typescript-eslint/no-floating-promises` (if enabled) would flag this as an unhandled promise. If a future developer moves this block without reading the MA-15 comment, they may not realize the rejection is swallowed in the `.catch` inside the `.then`. In contrast, the `forgotPassword` fire-and-forget at line 1098 is correctly written as `void Promise.resolve(...)`.

**Root Cause:** The two fire-and-forget patterns in this file use inconsistent forms: line 254 uses `Promise.resolve().then(...)` (no `void`), while line 1098 uses `void Promise.resolve(...)`. The former was added in a different PR.

**Fix:** Change line 254 to `void Promise.resolve().then(async () => { ... });` to match the pattern at line 1098 and satisfy floating-promise linting. No behavioral change — the inner `.catch` still swallows errors.

**Priority:** P3

**tenantImpact:** None — the outer try/catch in `register()` is unaffected.

**Detection:** `@typescript-eslint/no-floating-promises` lint rule. Not currently reported because the rule may not be enabled for this file, or the `Promise.resolve().then()` form escapes the rule's detection pattern.
