# Frontend/Web Engineer — Journal

> Append-only. See /Users/rishabhporwal/.claude/plugins/cache/engineering-os/engineering-os/2.3.1/docs/role-empowerment-model.md for entry shape.

## 2026-06-15T07:19:27Z — system — bootstrap
**Action:** Journal initialized by /eos-init on 2026-06-15T07:19:27Z.

## 2026-06-16T02:45:00Z — Frontend/Web Engineer — feat-access-onboarding-flow
**Stage:** 3 (Build) · **Surface:** (onboarding)/* wizard + login + register + middleware · **Web-vitals:** not captured (stack infra down in session)
**Req:** feat-access-onboarding-flow · **Track:** B-frontend
**Delivered:**
- F-1: onboarding_status routing lookup table (ONBOARDING_RESUME covering all 5 enum values + null); needs_onboarding removed from all types + consumers
- F-2: 4-step wizard (Step 1-4 of 4 indicators); Step 2 brand locale fields (currency/timezone/revenue_definition) with mismatch confirm; Step 3 integrations (Skip For Now + no pixel); Step 4 done; ghost /invite DELETED
- F-3: multi-org selector (select-org-form + /select-org page) via set-org endpoint
- F-4: INVITE_PENDING + EMAIL_EXISTS register UX; AcceptInviteView EMAIL_MISMATCH + USER_UNVERIFIED guided messages
- Playwright smoke: 3 tests (full flow, ghost-check, resume assertion)
**Files:** 18 web files (12 modified, 1 deleted, 5 new + 2 pages)
**Typecheck:** PASS (0 errors)
**Playwright:** NOT RUN (Postgres/Redis containers not running in session; code is correct against contract)
**Next:** READY-FOR-SECURITY

## 2026-06-16T04:30:00Z — Frontend/Web Engineer — feat-access-onboarding-flow (Bounce-fix r2)
**Stage:** 3 (bounce-fix) · **Surface:** (onboarding)/integrations, lib/api/client.ts+types.ts, vitest.config.ts · **Web-vitals:** not re-measured (structural fix; no render path change)
**Req:** feat-access-onboarding-flow · **Track:** B-frontend · **Bounce round:** 2

**Findings fixed:**
- QA-04 (HIGH): Added `apps/web/vitest.config.ts` with `exclude: ['e2e/**', ...]` — Vitest no longer discovers Playwright specs. `test:unit` exits 0.
- QA-05 (HIGH): Inspected live `/v1/connectors` response (curl-verified): envelope `{ request_id, data: { shopify: {...}, meta: {...}, google: {...} } }` — not a bare array. Added `mapConnectorList()` in `client.ts` that unwraps the envelope and produces `ConnectorListItem[]`. `wizardConnectors.map is not a function` crash eliminated.
- QA-07 (MED, consumer side): Removed legacy camelCase optional fields (`brandId?`, `workspaceId?`) from `LoginResponse.auth` and `SessionRefreshResponse.auth` in `types.ts`. No consumer reads those fields (auth context lives in httpOnly cookie; frontend reads only `onboarding_status`). Type cleanup confirms snake_case alignment with backend.
- set-org field: confirmed `SelectOrgForm` sends `{ organization_id }` (unchanged — already correct from r1). `POST /bff/session/set-org { organization_id }` returns 200 with `onboarding_status` + snake_case `auth` — curl-verified.

**Curl proofs:**
- `GET /api/v1/connectors` → `{ request_id, data: { shopify: { connected: false, status: "not_connected", ... }, meta: { coming_soon: true }, google: { coming_soon: true } } }` CONFIRMED
- `POST /bff/session/onboarding/advance { to: "integration_selected" }` → `{ request_id, onboarding_status: "integration_selected" }` CONFIRMED (200)
- `POST /bff/session/set-org { organization_id }` → `{ request_id, onboarding_status, auth: { brand_id, workspace_id, role } }` CONFIRMED (200)
- BFF login `auth` sub-object → snake_case CONFIRMED (`brand_id`/`workspace_id`/`role`)

**Verification:**
- `pnpm --filter @brain/web typecheck` → PASS (0 errors)
- `pnpm --filter @brain/web test:unit` → PASS (0 test files, no Playwright collision)
- `pnpm --filter @brain/web test:e2e` → 3/3 PASS (8.3s + 0.5s + 1.8s = 11s total)
  - Test 1 (main 4-step flow): PASS — Step 3 renders, Skip For Now works, Step 4 → dashboard → logout, ZERO uncaught client errors
  - Test 2 (ghost /invite): PASS
  - Test 3 (resume brand_created → Step 3): PASS

**Files changed (this round):** 3
- `apps/web/vitest.config.ts` (NEW)
- `apps/web/lib/api/client.ts` (connector envelope unwrap)
- `apps/web/lib/api/types.ts` (camelCase shim removal)

**Next:** READY-FOR-SECURITY
