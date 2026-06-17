# Security Review — fix/dev-token-reach (retroactive)

| Field | Value |
|---|---|
| **req_id** | `fix-dev-token-reach` |
| **stage** | 4 |
| **mode** | FULL |
| **verdict** | PASS |
| **reviewed_at** | 2026-06-17T14:30:00Z |
| **diff** | 12 files, +278/-52, migrations 0024+0025 |
| **blocking** | 0 |

---

## High-Stakes Surface Verifications

### 1. NIL-UUID GUC Trick (HIGHEST — `run.ts:270, 273-278`)

**Verdict: SAFE — no cross-brand access widening.**

Evidence path:
- `brand_self_read` policy (`0013_brand_self_read.sql:28-41`) uses membership subquery: `WHERE m.app_user_id = current_setting('app.current_user_id', TRUE)::uuid AND m.organization_id = current_setting('app.current_workspace_id', TRUE)::uuid`. Setting both to `NIL_UUID = '00000000-0000-0000-0000-000000000000'` means the subquery executes `m.app_user_id = '00000000-…'` — this UUID exists in NO membership row, so `id IN (empty set)` = FALSE for every row.
- `brand_isolation` policy (`0004_brand.sql:37-39`) is `USING (id = current_setting('app.current_brand_id', TRUE)::uuid)` — this is set to the real `brandId` from the SECURITY DEFINER fn result (MT-1). This policy (PERMISSIVE) grants the one correct brand row.
- The two policies are PERMISSIVE and OR'd by Postgres. `brand_self_read` grants nothing (empty subquery). `brand_isolation` grants exactly the one brand matching `app.current_brand_id`. Net effect: only the correct brand's connector_instance rows are visible. Cross-brand grant impossible.
- `connector_instance` and `connector_sync_status` have no `brand_self_read` equivalent — they are governed ONLY by `connector_instance_isolation` / `connector_sync_status_isolation`, both `brand_id = current_setting('app.current_brand_id', TRUE)::uuid`. The nil user/workspace GUCs have zero effect on these tables.
- Transaction wrapping: `BEGIN` / `set_config(…, true)` / `SELECT` / `COMMIT` is correct. Txn-local GUCs (`true`) do not escape after `COMMIT`/`ROLLBACK`. `client.release()` is in `finally`.
- `brandId` source: from `list_queued_backfill_jobs()` SECURITY DEFINER fn result (confirmed `0023_backfill_job_enumeration.sql`), never env/Shopify (MT-1 satisfied).
- WHERE clause belt-and-suspenders: `WHERE ci.id = $1 AND ci.brand_id = $2` (`run.ts:285-286`) — explicit predicate plus RLS.
- The NIL-uuid workaround is architecturally correct. The prior empty-string crash (`''::uuid`) was a real prod failure mode. The fix satisfies the `system-job-force-rls-enumeration` durable rule exception (job runs WITHIN a brand's GUC context; `app.current_brand_id` is set before the first FORCE-RLS read).

**Residual note (LOW — track, not block):** There is no dedicated test that sets `app.current_user_id = NIL_UUID, app.current_workspace_id = NIL_UUID, app.current_brand_id = brandA` and proves `SELECT FROM connector_instance WHERE brand_id = brandB` returns 0 rows under `brain_app`. The existing `pg.connector.test.ts` negative controls (`no GUC → 0 rows`) cover the most important case. The NIL-uuid-specific brand_self_read behavior is analytically proven by the empty subquery argument above, and no additional access path exists. Recommend adding a targeted test in the next sprint (see SEC-DTR-L1 below).

### 2. `dev_secret` Table — Dev-Only Isolation (`0024_dev_secret.sql` + `LocalSecretsManager` + `worker-secrets.ts`)

**Verdict: SAFE — prod path hard-fails, token never exposed.**

Evidence:
- `LocalSecretsManager` constructor (`LocalSecretsManager.ts:31-35`): `if (process.env['NODE_ENV'] === 'production') throw new Error(…)` — hard-fail confirmed at class instantiation.
- `main.ts:373-377`: `const connectorSecretsManager = isProduction ? new AwsSecretsManager(…) : new LocalSecretsManager(rawPgPool)` — `isProduction` is `nodeEnv === 'production'` (`main.ts:104`). In production `isProduction=true` → `AwsSecretsManager` is selected; the `LocalSecretsManager` branch is not reached. Even if somehow reached, the constructor would throw.
- `buildWorkerSecretsManager()` (`worker-secrets.ts:36-51`): `if (process.env['NODE_ENV'] === 'production')` → `AwsSecretsManager`; else `WorkerLocalSecretsManager`. Two independent guards (class guard + selector guard) = belt-and-suspenders.
- Token never logged: both `devPersist` / `devRead` (`LocalSecretsManager.ts:43-65`) and `WorkerLocalSecretsManager.getShopifyToken` (`worker-secrets.ts:87,100`) carry explicit `// NEVER logged (I-S09)` comments; confirmed no `console.log(secret_value)` or equivalent in the diff.
- Token not in API responses: the OAuth success callback (`main.ts:501`) logs `{requestId, connectorType, connectorInstanceId}` — no `secret_value`, no ARN content. The redirect URL carries `?connected=<type>` only.
- `dev_secret` not referenced in any API route, analytics query, web component, or outbound channel.
- Grant: `GRANT SELECT, INSERT, UPDATE, DELETE ON dev_secret TO brain_app` — DELETE is needed because `LocalSecretsManager.devDelete()` (`deleteSecret` / `deleteShopifyToken`) calls `DELETE FROM dev_secret WHERE name = $1`. Scope is acceptable for a dev vault stand-in. No `brain_app` GRANT issue.
- `dev_secret` has no RLS (intentional and correct per migration comment: keyed by secret name / ARN, not brand rows; it is the vault stand-in, not an analytical table). The ARN key namespace (`brain/connector/shopify/{brandId}/…`) provides implicit per-brand separation, though this is not an isolation guarantee for prod (irrelevant — the table is dev-only).
- **CRITICAL CHECK RESULT:** No prod code path writes or reads `dev_secret`. Hard-fail at both class-instantiation and selector level. PASS.

**Finding noted (MED — not blocking):** `dev_secret.secret_value` holds a plaintext OAuth token in the dev Postgres database — consistent with the KMS invariant exception for the dev vault stand-in (same pattern as `contact_pii` dev equivalent). This is acceptable for dev but should be reviewed if this pattern ever extends to a non-local database (see SEC-DTR-M1 below).

### 3. UPSERT Isolation — `connector_instance` + `connector_sync_status`

**Verdict: SAFE — `brand_id` in conflict key on both tables.**

Evidence:
- `connector_instance` UPSERT: `ON CONFLICT (brand_id, provider) DO UPDATE SET …` (`PgConnectorInstanceRepository.ts`). The unique constraint `connector_instance_brand_provider_unique UNIQUE (brand_id, provider)` (`0006_connector.sql:35`) means a conflict match requires `brand_id` identity. A different brand's row cannot match (different `brand_id` ≠ conflict key). The GUC is set by the calling request's session middleware — this is a BFF request path (not the system worker), so `app.current_brand_id` comes from the authenticated JWT, and FORCE RLS + `connector_instance_isolation` back-stops at the DB layer.
- `connector_sync_status` UPSERT: `ON CONFLICT (brand_id, connector_instance_id) DO UPDATE SET …` (`PgConnectorSyncStatusRepository.ts`). New UNIQUE constraint added by migration `0025_connector_sync_status_unique.sql`: `UNIQUE (brand_id, connector_instance_id)`. Same reasoning — brand_id in the conflict key structurally prevents overwriting another brand's row.
- Migrations `0024` and `0025` are additive (I-E02): no column drops, no destructive operations on existing tables. `0025` does a `DELETE` on duplicate rows (keeping the latest) before adding the constraint — this operates within the same brand_id/connector_instance_id partition, no cross-brand mutation.
- RLS/grants on both tables: unchanged from `0006_connector.sql` (FORCE RLS, `GRANT SELECT, INSERT, UPDATE`, no DELETE granted to `brain_app`). `0025` does not modify grants.

### 4. OAuth Callback Redirect (`main.ts:495-510`)

**Verdict: SAFE — HMAC-first, no open-redirect, no token/PII in query string.**

Evidence:
- `HandleOAuthCallbackCommand.execute()` (`HandleOAuthCallbackCommand.ts:77-85`): Step 1 is HMAC validation — `ShopifyHmac.validateOAuthCallback(query, clientSecret)` → throws `HmacValidationError` before any DB op if invalid. HMAC-first confirmed (NN-4).
- State nonce validation is Step 2 (before any token exchange) — `stateStore.consumeAndGetBrandId(state)` (`HandleOAuthCallbackCommand.ts:94-98`). `brandId` is server-derived from state record, never from query param (D-1).
- Redirect target is `config.appBaseUrl` (a fixed, server-configured value, not derived from request input). No open-redirect.
- Query string parameters on success redirect: `?connected=${encodeURIComponent(connectorType)}` — connector type string only (e.g. `shopify`). No token, no secret_ref, no PII, no brand_id.
- Query string parameters on error redirect: `?connect_error=<code>` — one of `{auth_failed, state_invalid, shop_invalid, unknown_connector, unexpected}`. No stack trace, no internal detail, no PII.
- The success log line (`main.ts:501`): `{requestId, connectorType, connectorInstanceId}` — no OAuth token, no secret_value (I-S09 compliant).
- `marketplace-view.tsx` consumes `?connected` / `?connect_error` params and immediately strips them via `router.replace('/settings/connectors')` after showing the toast. These params are not propagated further.

### 5. Analytics Change (`get-revenue-metrics.ts`)

**Verdict: SAFE — still inside `withBrandTxn`, no cross-brand leak, honest representation.**

Evidence:
- The `hasData` EXISTS check (`get-revenue-metrics.ts:69-80`) runs inside `withBrandTxn(deps.pool, brandId, …)` — the GUC is set by `withBrandTxn` before the EXISTS query. RLS scopes `realized_revenue_ledger` to `brand_id = current_setting('app.current_brand_id', TRUE)::uuid`. Cross-brand access impossible.
- The change removes the `recognition_label = 'finalized'` filter — any ledger row (finalized OR provisional/settling) triggers `has_data = true`. The `realized` and `provisional` amounts are still computed separately by the metric engine (`computeRealizedRevenue` / `computeProvisionalRevenue`) — no blending, no float arithmetic.
- Belt-and-suspenders explicit `WHERE brand_id = $1` predicate still present in the EXISTS subquery (correct per the code comment about NN-1 + RLS).
- Honest-empty-state interpretation: showing `state: 'has_data'` with `realized = 0` (true zero — nothing past the recognition horizon) and `provisional > 0` is MORE honest than "No data yet" for a brand that has real in-flight orders. This is not a fabricated zero (D-2 invariant). I-S07 (no float money) is not affected — the metric engine output path is unchanged.
- No new ad-hoc SUM — the engine is still the sole computation (I-E03 / I-ST03 satisfied).

### 6. Isolation Regression Spot-Check

- No new tables introduced with unprotected access.
- No `BYPASSRLS` granted.
- No `brand_id` assertion removed from any query.
- `connector_instance` FORCE RLS verified intact (`0006:43`, `0021:6` confirms unchanged).
- `connector_sync_status` FORCE RLS verified intact (`0006:70`, `0025` confirms RLS/grants unchanged).
- No token or PII introduced in any log call in the diff.
- `dev_secret` table: no RLS (intentional, dev-only vault stand-in), no PII, no brand data.
- Disconnected-tile filter (`main.ts:535`): `found.status !== 'disconnected' ? found : null` — correctness only, no isolation impact.

---

## Scanner Results (FULL mode — delta diff + targeted surface scans)

| Scanner class | Result |
|---|---|
| Secret grep on diff | CLEAN — no plaintext tokens, ARNs, or credentials in diff |
| SAST (manual Semgrep pattern review) | CLEAN — no plaintext-token column, no `console.log(secret_value)`, no injection risk in parameterized queries |
| DDL scan (0024, 0025) | CLEAN — no BYPASSRLS grant, no privileged grant on analytical tables, no destructive migration on protected tables |
| RLS policy review | CLEAN — FORCE RLS unchanged on connector_instance + connector_sync_status; new dev_secret explicitly dev-only (no RLS, no prod reach) |
| Dependency audit | No new dependencies introduced in this diff (pg already a dependency; no new packages) |
| IaC/container scan | No IaC or Dockerfile changes in this diff |

---

## Findings

### SEC-DTR-L1 (LOW — OPEN, non-blocking)
**Title:** No dedicated test verifying NIL-uuid + brand_self_read yields 0 extra rows under `brain_app`

**File:** `apps/stream-worker/src/jobs/shopify-backfill/run.ts:270-278` / `tools/isolation-fuzz/src/pg.test.ts`

**Detail:** The NIL-uuid trick is analytically safe (membership subquery returns empty set for nil user_id → brand_self_read grants nothing extra). However, no test directly asserts: "set user_id = NIL, workspace_id = NIL, brand_id = X → SELECT FROM brand WHERE id = Y (Y ≠ X) returns 0 rows under brain_app." The existing `pg.test.ts` negative controls cover no-GUC and wrong-brand-GUC; they don't cover the specific NIL-uuid case. This is belt-and-suspenders testing, not a structural gap.

**Remediation (next sprint):** Add one isolation-fuzz case to `tools/isolation-fuzz/src/pg.test.ts`: set `app.current_user_id = '00000000-…', app.current_workspace_id = '00000000-…', app.current_brand_id = brandA` → assert `SELECT FROM brand WHERE id = brandB` returns 0 rows (or exactly the rows brand_isolation allows).

**Status:** OPEN / deferred

---

### SEC-DTR-M1 (MED — OPEN, non-blocking)
**Title:** `dev_secret.secret_value` stores plaintext OAuth token in Postgres dev DB

**File:** `db/migrations/0024_dev_secret.sql`, `apps/core/src/modules/connector/sources/storefront/shopify/infrastructure/secrets/LocalSecretsManager.ts`

**Detail:** The dev vault stand-in stores plaintext connector OAuth tokens in a Postgres `dev_secret` table. This is the accepted dev pattern (mirrors the `contact_pii` dev vault equivalent) and is strictly dev-only (hard-fail in prod). However, if a developer's local Postgres instance is shared or has network exposure, the token is readable by anyone with `brain_app` credentials. This is within the dev threat model but should be documented.

**Remediation (before dev pattern spreads):** Add a `NOTICE` in migration `0024` header warning not to use this table on shared/cloud dev environments. Consider encrypting the value at rest with a static dev key (low value for a local-only pattern, but improves hygiene if dev DBs become shared).

**Status:** OPEN / deferred (pre-existing dev-pattern risk, not introduced by this diff as a new class of issue)

---

## Verification Validity

- All isolation assertions in existing tests run under `brain_app` (NOSUPERUSER NOBYPASSRLS) — confirmed by `backfill.e2e.test.ts:7` and `pg.connector.test.ts:APP_ROLE`. The dev superuser `brain` is not used for isolation assertions.
- T11 negative control (`backfill.e2e.test.ts:762-775`) is non-inert: asserts `count = 0` against a seeded job row — would fail if RLS were weakened.
- T4 negative controls (`backfill.e2e.test.ts:478-498`): wrong GUC and no-GUC both assert 0 rows under `brain_app`.
- The NIL-uuid behavior is analytically verified from the policy text and is deterministic — no test bypass observed.

---

## Compliance Gate

| COMPLIANCE.md control | Status |
|---|---|
| Brand isolation absolute (I-S01) | PASS — RLS FORCE on all connector tables; NIL-uuid does not widen access; UPSERT brand_id in conflict key |
| No PII in logs (I-S02) | PASS — token never logged; success log carries only requestId/connectorType/connectorInstanceId |
| KMS / no plaintext in DB (I-S09) | PASS for prod — dev_secret is accepted dev-vault exception, prod-hard-fail confirmed |
| Money not float (I-S07) | PASS — analytics change does not alter money computation path |
| Consent / outbound (I-S03) | NOT IN SCOPE — this diff has no outbound channel changes |
| Audit trail (I-S06) | PASS — audit write on connector.connected unchanged (main.ts:482-492) |
| Additive migrations (I-E02) | PASS — 0024 and 0025 are additive; 0025 DELETE is intra-brand dedup only |
