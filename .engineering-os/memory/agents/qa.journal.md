# QA Engineer — Journal

> Append-only. See /Users/rishabhporwal/.claude/plugins/cache/engineering-os/engineering-os/2.3.1/docs/role-empowerment-model.md for entry shape.

## 2026-06-15T07:19:27Z — system — bootstrap
**Action:** Journal initialized by /eos-init on 2026-06-15T07:19:27Z.

## 2026-06-16T03:05:00Z — QA Engineer — feat-access-onboarding-flow
**Stage:** 5 · **Mode:** FULL · **Verdict:** BOUNCE
**Smoke:** FAIL (1/3 Playwright tests failed — Step 3 page Runtime TypeError + advance endpoint 404) · **Parity:** n/a · **Validity:** RLS negative controls PASS; unit test validity_check EXIT 3 (no tests on new auth paths)
**Suite:** typecheck PASS 34/34; unit FAIL (web: Vitest/Playwright collision); lint PASS 18/18
**Critical flows proven:** refresh-rotation YES, replay-family-wipe YES, revoke-on-remove YES
**Critical flows broken:** set-org (field drift workspace_id vs organization_id), advance (endpoint not registered)
**Bounce findings:** QA-01 (CRITICAL: advance 404), QA-02 (HIGH: set-org field drift), QA-03 (HIGH: BFF login not rate-limited), QA-04 (HIGH: web unit suite fails), QA-05 (HIGH: Step 3 crash), QA-06 (HIGH: 0 unit tests on auth paths), QA-07 (MED: camelCase drift)
**Artifacts:** qa-review.md, qa-review.verdict.json
**Next:** BOUNCE → backend-developer (QA-01,02,03,06,07), frontend-web-developer (QA-04,05)

## 2026-06-16T10:26:00Z — QA Engineer — feat-multi-brand
**Stage:** 5 · **Mode:** FULL · **Verdict:** FAIL (blocking)
**Smoke:** Executed manually against live :3001 + docker Postgres — all wire paths PASS (set-brand→A, set-brand→B with role=analyst, brand-summary active_brand_id=B, 4 negative paths). NOT automated/repeatable in repo — VETO QA-1.
**Parity:** N/A (no cross-runtime metric engine in this feature).
**Validity:** Negative controls confirmed — NOSUPERUSER NOBYPASSRLS isofuzz_app + policy-removal proof (policy_on=0, policy_off=1). No bypass-green tests found.
**Tests run:** 43 unit (PASS) + 11 isolation-fuzz (PASS) + 4 live wire smokes (PASS) + 4 live wire negative-paths (PASS). Total: 62 probes.
**Blocking findings:** QA-1 (HIGH, missing automated smoke test) + QA-2 (MED, 0% unit coverage on switchBrandContext).
**Non-blocking findings:** QA-3 (MED, correlationId not in audit_log), QA-4 (LOW, tautological >=0 assertion), QA-5 (INFO, Playwright E2E not run).
**Next:** BOUNCE → backend-engineer (Track A). Required: switch-brand.live.test.ts integration test + switchBrandContext unit tests. Re-handoff to QA when tests are green.

## 2026-06-17T03:05:29Z — QA Engineer — feat-analytics-api-dashboard
**Stage:** 5 · **Mode:** DELTA (reasoning scoped to QA-F-001; full e2e suite re-run) · **Verdict:** PASS
**Smoke:** 4/4 e2e passed (23.5s); test 2 confirmed ₹1,234 rendered — real-number M1 reconciling path verified · **Parity:** PASS (unchanged from FULL) · **Validity:** negative-controls confirmed (unchanged from FULL) · **Next:** Reconcile with Security Reviewer
**Fix verified:** commit 709cb2c — `app_user_org_membership` → `membership` at realized-revenue.spec.ts:38; zero residual matches; migration confirms table + columns

## 2026-06-17T06:05:00Z — QA Engineer — feat-connector-marketplace
**Stage:** 5 · **Mode:** FULL · **Verdict:** BOUNCE
**Smoke:** PASS (Boddactive Shopify OAuth real-network corroborated in DB: status=connected, health_state=Healthy, safety_rating=safe, secret_ref=arn:..., no token in DB) · **Parity:** n/a · **Validity:** backend negative controls CONFIRMED (count===0 under brain_app NOSUPERUSER); e2e validity_check EXIT 3 (tests broken — cannot confirm)
**Suite:** backend vitest 189/189 PASS; core typecheck EXIT 0; web typecheck EXIT 0; Playwright e2e 0/6 FAIL
**Critical flows proven:** forged-body rejected (OAuthCallbackInput no brandId; state-derived only); isolation non-inert (brain_app NOSUPERUSER count===0); authz (analyst 403, manager 200, backfill 501 brand_admin gate); audit (connector.connected rows in DB); health/safety (Healthy/safe on connect; 7→3 mapping tested); NN-2 (0 token/ciphertext columns); deferred-boundary clean (0 grep hits); envelope (MarketplaceListResponseSchema safeParse; negative request_id missing fails)
**Critical flows broken:** e2e 0/6 — connectorsApi.list() regression: GET /v1/connectors now returns {tiles:MarketplaceTile[]} but mapConnectorList() reads raw.data.shopify (undefined); onboarding wizard step 3 crashes; btn-skip-integrations never renders
**Bounce findings:** QA-CM-01 (BLOCKING: connectorsApi.list() regression — client.ts:552 + onboarding-integrations-step.tsx); QA-CM-02 (BLOCKING: validity_check exit 3 contingent on CM-01)
**Next:** BOUNCE → frontend-web-developer (QA-CM-01, QA-CM-02); backend HOLD

## 2026-06-17T07:30:00Z — QA Engineer — feat-connector-marketplace
**Stage:** 5 · **Mode:** DELTA (reasoning scoped to QA-CM-01 + QA-CM-02; full e2e suite re-run) · **Verdict:** PASS
**Smoke:** 6/6 marketplace e2e PASS (38.3s); 1/1 full-journey PASS (8.3s) · **Parity:** n/a · **Validity:** negative-control CONFIRMED (Test 3 firedRequest===null; validity_check EXIT 0, 12 files clean) · **Next:** Reconcile with Security Reviewer
**Fix verified:** commit b9639d7 — connectorsApi.list() derives from getMarketplace(); maps MarketplaceTile[]→ConnectorListItem[]; raw.data.shopify no longer referenced; D-10 envelope unwrapped correctly
**Typecheck:** pnpm --filter @brain/web typecheck → exit 0

{"ts":"2026-06-17T07:30:00Z","actor":"qa-agent","type":"review","req_id":"feat-connector-marketplace","stage":5,"verdict":"PASS","mode":"DELTA"}
