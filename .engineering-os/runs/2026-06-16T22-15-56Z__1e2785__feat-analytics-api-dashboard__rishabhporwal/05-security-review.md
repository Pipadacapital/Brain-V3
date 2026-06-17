# Security Review — feat-analytics-api-dashboard

**Stage:** 4 · **Reviewer:** Security Reviewer · **Mode:** FULL
**Verdict:** PASS
**req_id:** `feat-analytics-api-dashboard`
**ts:** 2026-06-17T07:00:00Z
**Scope:** analytics module + BFF route + rawPgPool wiring + web card/client/hook/e2e (analytics slice only; spine already merged)

---

## Review surface

| File | Role |
|---|---|
| `apps/core/src/modules/analytics/internal/application/queries/get-revenue-metrics.ts` | Analytics use-case (sole computation path) |
| `apps/core/src/modules/analytics/internal/domain/metrics/revenue-snapshot.ts` | Value object + serializer |
| `apps/core/src/modules/analytics/index.ts` | Module boundary (D-8) |
| `apps/core/src/modules/analytics/tests/revenue-metrics.live.test.ts` | 20 live PG tests |
| `apps/core/src/modules/frontend-api/internal/bff.routes.ts:943-1013` | GET /api/v1/dashboard/realized-revenue |
| `apps/core/src/main.ts:314` | rawPgPool threading |
| `apps/web/lib/format/money-display.ts` | Display formatter |
| `apps/web/lib/api/client.ts:677-768` | dashboardApi.getRealizedRevenue() |
| `apps/web/lib/hooks/use-dashboard.ts:54-60` | useRealizedRevenue() hook |
| `apps/web/components/dashboard/realized-revenue-card.tsx` | Dashboard card |
| `apps/web/e2e/realized-revenue.spec.ts` | 4 Playwright e2e tests |

---

## Non-negotiable invariant checks

### 1. Sole read path (ADR-002): engine==BFF, no ad-hoc SUM

**CONFIRMED.**

- `get-revenue-metrics.ts` calls `computeRealizedRevenue` and `computeProvisionalRevenue` from `@brain/metric-engine` exclusively (lines 92-95). The only additional SQL is the `EXISTS(SELECT 1 FROM realized_revenue_ledger WHERE recognition_label='finalized')` existence check (lines 67-76) — not a value computation; explicitly permitted by D-2.
- Grep of `SUM(` in analytics module source (excluding tests) and bff.routes.ts analytics route block: **zero executable occurrences**.
- Live test 1 proves sole-read-path: `getRevenueMetrics(BRAND_A, today, {pool: appPool}).realized['INR'] === String(computeRealizedRevenue(BRAND_A, today, {pool: appPool}).get('INR'))` — exact bigint match. This test would fail if an ad-hoc SUM were used (the engine excludes provisional rows; a naive SUM would double-count them).
- Test 6 (structural) in the live test file performs an in-process grep scan of all `.ts` source files in the analytics module at test runtime and fails on any executable `SUM(amount_minor)`.
- **20/20 tests pass** under `pnpm --filter @brain/core exec vitest run`.

**Evidence:** `apps/core/src/modules/analytics/internal/application/queries/get-revenue-metrics.ts:92-95` (engine calls only).

### 2. Honest empty state (BRD/§8 heart): no_data never a bare 0

**CONFIRMED.**

- The route checks `EXISTS(finalized)` BEFORE calling the engine (get-revenue-metrics.ts:66-76). When `hasFinalized` is false, returns `{ state: 'no_data', realized: null, provisional: null }` (lines 80-87) without ever calling the engine.
- This neutralizes the `realized_gmv_as_of() ?? '0'` landmine at `realized-revenue.ts:71` — the engine's `0n` return for no-rows is never surfaced when no finalized rows exist.
- Live test 2: brand with only provisional rows → `state='no_data'`, `realized===null`. Explicitly asserts `realized !== { INR: '0' }`.
- Live test 2: brand with zero rows → same. Both variants pass.
- Web card: `if (!data || data.state === 'no_data')` at `realized-revenue-card.tsx:63` guards the render path, showing `EmptyState title="No data yet"`. The `realized-revenue-no-data` testid is present. The card never renders a fake 0.

**Evidence:** `apps/core/src/modules/analytics/internal/application/queries/get-revenue-metrics.ts:80-87`; `apps/web/components/dashboard/realized-revenue-card.tsx:63-90`.

### 3. Brand isolation: rawPgPool, F-SEC-02 not regressed, brain_app NOBYPASSRLS

**CONFIRMED — P0 PASS.**

- `main.ts:314`: `registerBffRoutes(app, authService, pool, config.cookieSecret, rateLimiter, rawPgPool)` — `rawPgPool` (a fresh `pg.Pool`) is threaded as the sixth argument.
- `bff.routes.ts:66`: `rawPool?: PgPool` parameter; `bff.routes.ts:1006`: `getRevenueMetrics(auth.brandId, asOf, { pool: rawPool })` — rawPool is the raw pg.Pool, not the DbPool wrapper. No double-GUC.
- `packages/metric-engine/src/deps.ts:48`: `await client.query("SELECT set_config('app.current_brand_id', $1, true)", [brandId])` — `is_local=true` (transaction-scoped). F-SEC-02 carry-in fix is present and not regressed.
- Brand comes from session: `bff.routes.ts:1006` uses `auth.brandId` — the session-bound identity, never from request body.
- Live test 3 (isolation negative-control under `brain_app`):
  - Asserts `current_user='brain_app'` AND `is_superuser=false` before any RLS assertion (proves the test is not running under the dev superuser which bypasses RLS).
  - Seeds BRAND_A via superPool; queries BRAND_B via appPool → `state='no_data'`, `realized===null`.
  - BRAND_A's value (`777000n`) does NOT appear in BRAND_B's result.
  - **PASSES under real RLS** (non-bypassed context).

**Evidence:** `apps/core/src/main.ts:314`; `bff.routes.ts:66,1006`; `packages/metric-engine/src/deps.ts:48`; test 3 lines 285-332.

### 4. No floats / no blend: money is minor-unit strings, never summed

**CONFIRMED.**

- BFF response: `bigint → String(v)` via `serializeMoneyMap` (revenue-snapshot.ts:60-62). Values are decimal strings throughout.
- `formatMoneyDisplay` (money-display.ts): uses `BigInt(minorString)` → bigint integer division for major/minor parts → composes decimal string → `Number(decimalString)` for Intl.NumberFormat. The `Number()` conversion is display-only and does not feed back into any computation. ESLint `no-float-money` rule passes (no variables named `*_minor/*_amount/etc.` are typed as `number`; no float arithmetic on money identifiers).
- No `/100`, no `parseFloat` in any functional code path (grep confirms — all matches are in JSDoc comments).
- `realized` and `provisional` are rendered in separate card blocks (`realized-revenue-card.tsx:109-139` and `:141-169`). No arithmetic between the two. The type `RevenueSnapshot` discriminated union enforces both fields are null on `no_data` and separate `MoneyRecord` objects on `has_data`.
- Live test 4: seeds `FINALIZED_AMOUNT=500000n` and `PROVISIONAL_AMOUNT=75000n`. Asserts `realized['INR'] === '500000'` (NOT `'575000'` — no blend); `provisional['INR'] === '75000'`.

**Evidence:** `apps/core/src/modules/analytics/internal/domain/metrics/revenue-snapshot.ts:58-64`; `apps/web/lib/format/money-display.ts:40-70`; test 4 lines 357-398.

### 5. Route auth: session+CSRF, no PII, as_of → 400, no new ADR/migration

**CONFIRMED.**

- `bff.routes.ts:946`: `preHandler: [bffProtectedPreHandler]` — validates httpOnly session cookie + delegates to session validator. The analytics route is a GET; CSRF enforcement in `main.ts:194` is conditional on `isMutation` (POST/PUT/PATCH/DELETE), so GET is not subject to the double-submit CSRF check (this is standard and correct for read-only routes — CSRF tokens protect state-changing actions, not reads). Session authentication IS enforced for all GET routes via `bffProtectedPreHandler`.
- Response payload: `{ request_id: uuid, data: { state, as_of, realized, provisional } }`. No user PII — only aggregate monetary amounts and state enum. `auth.brandId` (a UUID) is used internally to key the query but is not echoed in the response.
- `as_of` validation: Fastify JSON schema at `bff.routes.ts:947-957` validates pattern `^\d{4}-\d{2}-\d{2}$` with `additionalProperties: false`. `attachValidation: true` triggers `bff.routes.ts:968-973` to return 400 `INVALID_DATE` on schema failure.
- No new ADR, no new migration (read-only feature), no new deployable (analytics module is in `apps/core`, card in `apps/web`).

---

## Findings

### LOW-SEC-001: Semantic date validation gap — month 13 returns 500 not 400

**Severity:** LOW
**File:** `apps/core/src/modules/frontend-api/internal/bff.routes.ts:953` + `apps/core/src/modules/analytics/internal/application/queries/get-revenue-metrics.ts:61`
**Timing:** SAFE-TO-DEFER (not a security defect; no data loss; not exploitable)

The regex `^\d{4}-\d{2}-\d{2}$` accepts semantically invalid dates such as `2026-13-01` (month 13) or `2026-02-30` (Feb 30). For month 13, `new Date('2026-13-01T00:00:00Z')` produces an Invalid Date; `asOf.toISOString()` at `get-revenue-metrics.ts:61` throws `RangeError: Invalid time value`. The global error handler returns 500 `INTERNAL_ERROR` instead of 400 `INVALID_DATE` (the D-9 contract). Feb 30 silently overflows to Mar 2 (no error, but unexpected semantics).

**Security impact:** NONE. No PII is leaked. No data is corrupted. Not exploitable. The global error handler strips stack traces in production (confirmed: `main.ts:242 statusCode >= 500 → 'Internal server error'`).

**Remediation (deferred):** After `isNaN(asOf.getTime())` check at `bff.routes.ts:1003`, return 400 `INVALID_DATE` if the date is invalid after construction.

---

## Verification-validity check

Tests ran under `brain_app` (NOBYPASSRLS), not the dev superuser `brain`. Test 3 explicitly asserts `current_user='brain_app'` and `is_superuser=false` before any RLS assertion — the negative-control test cannot be inert. The engine==BFF test (test 1) would fail if an ad-hoc SUM were substituted (engine excludes provisional rows; SUM would not). The honest-empty test (test 2) explicitly asserts `realized !== { INR: '0' }` — cannot be inert. All isolation tests have a positive control (BRAND_A sees its data) paired with the negative control (BRAND_B does not).

---

## Scanner results

- **Ad-hoc SUM grep (analytics module + BFF route):** CLEAN — zero executable `SUM(amount_minor)` lines.
- **Secret scan (analytics slice):** CLEAN — no hardcoded credentials, tokens, or connection strings in new source files.
- **PII in logs:** CLEAN — analytics route does not log any PII. The global logger has PII redaction.
- **No-float-money lint:** PASS — `pnpm exec eslint apps/web/lib/format/money-display.ts apps/web/components/dashboard/realized-revenue-card.tsx apps/web/lib/api/client.ts` exits clean.
- **Import boundary:** CLEAN — `analytics/index.ts` is the sole public surface; no cross-module imports from `./internal/`.
- **No new migrations:** CONFIRMED — no `.sql` files newer than the feature branch.

---

## Findings summary

| ID | Severity | Title | Status |
|---|---|---|---|
| LOW-SEC-001 | LOW | Semantic date validation gap: month=13 returns 500 not 400 | OPEN-DEFERRED |

**Blocking findings:** 0
**CRIT/HIGH findings:** 0

---

## Verdict

**PASS**

All non-negotiable invariants confirmed:
- Sole-read-path (engine==BFF exact-bigint, no ad-hoc SUM): CONFIRMED
- Honest empty state (no_data never a bare 0): CONFIRMED
- Brand isolation under brain_app NOBYPASSRLS (F-SEC-02 not regressed): CONFIRMED
- No float/no blend (bigint strings, display-only Number(), separate fields): CONFIRMED
- Route auth (session-gated, no PII, as_of 400, no new ADR/migration): CONFIRMED

One LOW finding (LOW-SEC-001) safe-to-defer per the finding-severity-rubric: not a security/compliance/data-loss defect, no exploitability, named in backlog for future hardening.
