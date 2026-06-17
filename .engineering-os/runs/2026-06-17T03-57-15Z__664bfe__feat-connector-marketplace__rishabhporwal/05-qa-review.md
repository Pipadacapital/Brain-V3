# QA Review — feat-connector-marketplace

**Stage:** 5 — QA Review
**Agent:** QA Engineer
**Date:** 2026-06-17T06:05:00Z
**Mode:** FULL
**Verdict:** FAIL (BOUNCE)
**Blocking findings:** 2

---

## Test Results

| Suite | Result | Evidence |
|-------|--------|----------|
| Backend vitest (189 tests, 14 files) | PASS 189/189 | `Test Files 14 passed (14); Tests 189 passed (189); Duration ~560ms` — run 2026-06-17T05:19:19Z |
| @brain/core typecheck | PASS (exit 0) | `tsc --noEmit → EXIT_CODE:0` |
| @brain/web typecheck | PASS (exit 0) | `tsc --noEmit → EXIT_CODE:0` |
| Playwright e2e (6 tests) | FAIL 0/6 | All 6 fail at `onboardToDashboard()` step 3 — `btn-skip-integrations` never renders (60s timeout on all 6) |

---

## Real-Network Smoke (Corroborated)

DB corroboration via `docker exec brainv3-postgres-1 psql`:

```
connector_instance row:
  id:            e73e5d0e-b5f3-4cfd-b803-92df5710248c
  brand_id:      dfcc8b22-8435-48a1-b8cb-a32af371f955
  provider:      shopify
  status:        connected
  health_state:  Healthy
  safety_rating: safe
  shop_domain:   boddactive-com.myshopify.com
  connected_at:  2026-06-17 05:04:32.934+00
  secret_ref:    arn:aws:secretsmanager:us-east-1:000000000000:secret:brain/connector/shopify/...
```

Audit log:
```
audit_log rows: action=connector.connected, brand_id=dfcc8b22..., entity_type=connector_instance
  (3 rows: 2026-06-17 05:04:32, 05:04:30, 04:52:49)
```

NN-2 confirmed: no `*_token`, `*_ciphertext`, `*_key`, `*_secret` columns in `connector_instance`.

brain_app user: `usename=brain_app, usesuper=f, usebypassrls=f` (NOSUPERUSER NOBYPASSRLS — isolation tests are non-inert).

---

## Deferred-Boundary Grep Guard (criterion #13)

Command run on connector module + web + contracts:
```
grep -rn -E "(health-detector|backfill[^_]|live-sync|volume-anomaly|connector\.health\.changed|DQ-gat)" apps/core/src/modules/connector/ apps/web/components/ apps/web/lib/ packages/contracts/
```

Result: **0 hits** (only `backfill` in test comments + contract comments — 501 gate only, no execution body).

Status: CLEAN — criterion #13 PASS.

---

## Isolation / Forged-body / Authz Evidence (Backend live tests)

From `connector-marketplace.live.test.ts` (35/35 PASS):

**Isolation (criterion #8, D-8):**
- Positive: brand A connector via superuser; query under brain_app `SET LOCAL app.current_brand_id=brandA` → `count > 0` — PASS
- Negative: brand A connector; query under brain_app `SET LOCAL app.current_brand_id=brandB` → `count === 0` (RLS FORCE enforced) — PASS
- User verify: `SELECT current_user` via appPool → `brain_app` (NOSUPERUSER NOBYPASSRLS) — PASS

**Forged-body (criterion #3, D-1/MED-CALLBACK-01):**
- `OAuthCallbackInput` has no `brandId` field — compile-time structural proof
- `HandleOAuthCallbackCommand` derives `brandId` exclusively from `stateStore.consumeAndGetBrandId(state)` — PASS
- Dedicated negative-control unit test: forged body `brand_id` ignored, state-derived value used — PASS

**Authz (criterion #7, D-9):**
- `isConnectable(getDefinition('meta'))` → `false` — coming_soon catalog gate — PASS
- Manager → `POST /connectors` → 200 oauth_url — PASS
- Analyst → `POST /connectors` → 403 — PASS
- `POST /api/v1/connectors/:id/backfill` → 501; requires brand_admin (manager → 402 or 403) — PASS

**Validity check exit code:** 3 (VETO triggered on e2e path — see finding QA-CM-02 below). Backend isolation tests have non-inert negative controls confirmed.

---

## Success Criteria Map

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | All 7 categories render | Backend PASS (catalog test) / E2E FAIL | vitest catalog.test; e2e broken |
| 2 | Coming-soon 422 server-side | PASS | live test — POST meta → 422 |
| 3 | Forged-body rejected / state-derived brand | PASS | unit+live test; OAuthCallbackInput has no brandId |
| 4 | Token never in Postgres/response | PASS | schema scan (0 rows); secret_ref only; NN-2 confirmed |
| 5 | 7-state health + safety on connect/disconnect | PASS | live test; DB row Healthy/safe confirmed |
| 6 | Full 7→3 safety mapping tested | PASS | healthSafety.ts; describe 12 in live test |
| 7 | Authz negative controls | PASS | analyst 403; manager connect; backfill brand_admin gate |
| 8 | Cross-brand isolation under brain_app | PASS | non-inert count===0 negative control; brain_app NOSUPERUSER confirmed |
| 9 | Audit log connect+disconnect | PASS | DB rows confirmed (3 connector.connected entries); sha256 hash-chain |
| 10 | Skip For Now first-class | BLOCKED (e2e broken) | Onboarding integrations step crashes; cannot reach marketplace |
| 11 | Envelope discipline | PASS | live test MarketplaceListResponseSchema.safeParse; negative control missing request_id fails |
| 12 | Playwright e2e 6/6 | FAIL (0/6) | All fail at btn-skip-integrations — onboarding step 3 crash |
| 13 | No detector/backfill/live-sync | PASS | grep — 0 hits in diff |

---

## Blocking Findings

### QA-CM-01 (BLOCKING — HIGH): Regression: onboarding wizard step 3 crashes — `connectorsApi.list()` broken

**Path:** `apps/web/lib/api/client.ts:552-554` + `apps/web/components/onboarding/onboarding-integrations-step.tsx:194`

**Root cause:** The new `GET /api/v1/connectors` backend endpoint now returns `{ request_id, data: { tiles: MarketplaceTile[] } }`. The old `connectorsApi.list()` function still calls `/v1/connectors` and passes the response to `mapConnectorList()`, which reads `raw.data.shopify` — but `raw.data.shopify` is now `undefined` (the response has `tiles`, not `shopify`/`meta`/`google`). This causes a runtime error in the onboarding integrations step, which prevents `btn-skip-integrations` from rendering, blocking all 6 Playwright tests.

**Evidence:** All 6 Playwright e2e tests fail at `onboard.ts:60` waiting for `getByTestId('btn-skip-integrations')` (60s timeout). The legacy `GetConnectorStatusQuery` still exists at `apps/core/src/main.ts:550-554` as `/api/v1/connectors/:id/status` — but `list()` calls bare `/v1/connectors`, not the `:id/status` path.

**Fix:** The frontend developer must fix `connectorsApi.list()` in `client.ts` to either: (a) route to the separate legacy endpoint `/v1/connectors/:id/status` which still returns the old shape (the `:id/status` route at `main.ts:550`), OR (b) rewrite `list()` to call `getMarketplace()` and map `MarketplaceTile[]` → `ConnectorListItem[]` using the wizard's needed fields (provider, instance, status). Option (b) is preferred — it removes the dual-endpoint confusion and makes the wizard consume the same marketplace data.

**Cross-runtime regression:** This is a green-before/red-now regression. The onboarding wizard worked before this feature was implemented. The new marketplace endpoint replaced the old endpoint without updating `list()`.

---

### QA-CM-02 (BLOCKING — validity_check exit 3): validity_check reports missing negative control on e2e path

**Command run:**
```
python3 /Users/rishabhporwal/.claude/plugins/cache/engineering-os/engineering-os/2.3.1/tools/validity_check.py \
  --paths apps/core/src/modules/connector/tests apps/web/e2e \
  --artifacts /dev/null --require-negative-control
EXIT: 3
```
**Output:** `MISSING NEGATIVE CONTROL: this is a high-stakes (tenancy/auth/money) change, but no probe proves the test FAILS when the protection is removed.`

**Status:** The backend isolation tests DO have non-inert negative controls (confirmed manually above — `count===0` assertion under brain_app). However, the e2e tests are all failing (0/6 pass), so the e2e negative-control path cannot be confirmed. This finding is contingent on QA-CM-01 being fixed; once e2e passes, the validity_check must be re-run and exit 0 on the e2e path, or a documented negative-control entry must be added.

**Fix:** Fix QA-CM-01 first. After e2e is green, add an explicit negative-control probe to `marketplace.spec.ts` (e.g., intercept route returning `{}` for the coming-soon tile, assert no POST fires) and re-run validity_check. Document in `negative_control[]` array.

---

## Non-blocking Observations

- The `connectorsApi.list()` `@deprecated` JSDoc comment was added but the function was not updated to route to the correct endpoint. Had the function been updated to use `getMarketplace()` internally (with a mapping shim), this regression would not exist.
- The onboarding integrations page (`onboarding-integrations-step.tsx`) was not updated to consume `useMarketplace()` — it still uses `useConnectorList()` which calls the broken `list()`.
- The `validity_check` tool correctly flagged the e2e gap. Backend tests have valid negative controls.

---

## Verdict

**FAIL / BOUNCE**

Blocking count: 2 (QA-CM-01 is the root cause; QA-CM-02 is contingent)

Bounce target: `@frontend-web-developer` (primary: fix `connectorsApi.list()` regression — client.ts + onboarding-integrations-step.tsx); re-run e2e; validity_check exit 0.

Backend verdict: All 35 live tests PASS. All isolation, authz, audit, forged-body, envelope, and deferred-boundary criteria MET. Real-network smoke (Boddactive Shopify) corroborated in DB. Backend is HOLD (do not re-open).

---

## DELTA Re-Review — 2026-06-17T07:30:00Z

**Mode:** DELTA (reasoning scoped to QA-CM-01 + QA-CM-02; full test suite re-run per lane rule)
**Verdict:** PASS
**Blocking findings:** 0 (was 2)

### Fix verification — QA-CM-01 (commit b9639d7)

`apps/web/lib/api/client.ts:561-592` — `connectorsApi.list()` no longer reads `raw.data.shopify`. It calls `connectorsApi.getMarketplace()` internally, maps `MarketplaceTile[] → ConnectorListItem[]`, and correctly unwraps the D-10 envelope via `mapTiles(raw.data.tiles)`. No residual `raw.data.shopify` reference.

### E2E results (6/6 PASS — was 0/6)

```
Running 6 tests using 1 worker
  ✓  1 marketplace renders all 7 categories with tiles (6.2s)
  ✓  2 shopify tile renders in storefront category with connect input (5.9s)
  ✓  3 coming-soon tile is present and is structurally un-connectable (7.9s)
  ✓  4 marketplace renders fully for a freshly onboarded brand with zero connections (6.1s)
  ✓  5 OAuth tile Connect button fires POST /api/bff/v1/connectors with type=shopify (5.9s)
  ✓  6 GET /api/bff/v1/connectors returns correct envelope with tiles (5.9s)
  6 passed (38.3s)
```

### Negative control — QA-CM-02 (Test 3)

Test 3 confirms `firedRequest === null` — `waitForRequest` (2000ms timeout) returns `null`; `expect(...).toBeNull()` passes. Zero POSTs fired on coming-soon disabled tile click. Control is non-inert: the POST interceptor would capture a request if the button fired one.

### Onboarding no-regression

```
Running 1 test using 1 worker
  ✓  1 full application journey — register to logout, the whole app (8.0s)
  1 passed (8.3s)
```

`btn-skip-integrations` path confirmed intact.

### Typecheck

`pnpm --filter @brain/web typecheck` → `tsc --noEmit` → exit 0.

### validity_check

`validity_check.py --paths apps/web/e2e --require-negative-control` → `validity_check: clean (12 files scanned)` → EXIT 0.

**QA-CM-01:** RESOLVED. **QA-CM-02:** RESOLVED. **VERDICT: PASS.**
