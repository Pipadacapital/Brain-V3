# Security Reviewer — Journal

> Append-only. See /Users/rishabhporwal/.claude/plugins/cache/engineering-os/engineering-os/2.3.1/docs/role-empowerment-model.md for entry shape.

## 2026-06-15T07:19:27Z — system — bootstrap
**Action:** Journal initialized by /eos-init on 2026-06-15T07:19:27Z.

## 2026-06-15T18:01:00Z — Security Reviewer — chore-platform-foundations-sprint0
**Stage:** 4 · **Mode:** DELTA · **Verdict:** BOUNCE
**Findings:** 0 CRIT / 0 HIGH (all prior HIGH fixed) / 1 new MED (M-03-B) / 0 LOW (all fixed)
**Scanners:** terraform fmt EXIT=0; terraform validate SUCCESS (eks/dev/staging); checkov 3.3.1 run — 3 pre-existing failures, 1 in delta scope (CKV_AWS_39 unsuppressed on dev). Secret grep clean.
**Reverified:** H-01=fixed; M-01=acceptable-pending; M-02=fixed; M-03=fixed (core); M-03-B=new OPEN MEDIUM; L-01=fixed
**Next:** platform-devops fixes envs/dev/main.tf:89 (CKV_AWS_130 → CKV_AWS_39 inline skip); security-reviewer DELTA re-review (M-03-B only)

## 2026-06-16T03:30:00Z — Security Reviewer — feat-access-onboarding-flow
**Stage:** 4 · **Mode:** FULL · **Verdict:** BOUNCE
**Findings:** 0 CRIT / 1 HIGH (SEC-AOF-H1: set-org missing 403 on non-member) / 3 MED / 1 LOW
**Scanners:** secret-grep clean on diff; RLS verified under brain_app NOBYPASSRLS role; migration columns verified in live DB; B-1 rotation + replay + family-wipe proven live; B-2 revoke-on-remove proven live (audit entries confirmed); rate-limit trip at attempt 6 verified; cross-org 403 on GET /members verified.
**Reverified:** MA-01/B-1=RESOLVED; MA-02/B-2=RESOLVED; MA-03=RESOLVED (FOR UPDATE confirmed); MA-04/MA-15=RESOLVED (fire-and-forget); MA-05=RESOLVED (needs_onboarding removed); MA-06=PARTIAL (GET /members 403 correct; PATCH/DELETE use jwt.workspace??query — MED fragility); MA-07=RESOLVED; MA-08=RESOLVED; MA-09=RESOLVED; MA-10=RESOLVED; MA-11=RESOLVED; MA-12=RESOLVED; MA-13=RESOLVED (re-mints cookie, returns enum); MA-14=RESOLVED (duplicate removed); MA-15=RESOLVED; MA-16=RESOLVED.
**BOUNCE reason:** SEC-AOF-H1: POST /bff/session/set-org does not return 403 when user is not a member of requested org_id — silently falls back to user's actual membership (AC-8 §B-7 violation; spec: verify membership exists, else 403). Architecture plan line 242 binding requirement not met.
**Next:** backend-developer adds explicit membership verification + 403 before calling refreshSession in set-org handler; security-reviewer DELTA re-review (SEC-AOF-H1 only).

## 2026-06-16T10:20:00Z — Security Reviewer — feat-multi-brand
**Stage:** 4 · **Mode:** FULL · **Verdict:** BOUNCE
**Findings:** 0 CRIT / 1 HIGH (SEC-MB-1) / 2 MED (SEC-MB-2, SEC-MB-3) / 1 LOW (SEC-MB-4) / 1 INFO (SEC-MB-5)
**Scanners:** isolation-fuzz 11/11 PASS (live Postgres, NOBYPASSRLS, negative controls confirmed); pg_policies confirmed 0013 live; secret-grep clean on diff; CSRF hook verified in main.ts; cookie flags verified in bff.routes.ts
**Reverified:** MA-01=PASS (direct mint, no fallback); MA-02=PASS (set-brand JWT-only); MA-02-create=FAIL (brand.routes.ts:43 body workspace_id — SEC-MB-1 HIGH); MA-03=PASS; MA-04=PASS (0013 live + NN-1 confirmed); MA-05=PASS; MA-06=PASS; MA-07=PASS; MA-09=PASS; MA-10=PASS; MA-11=PASS; MA-12=PASS; MA-13=PASS; AC-7=PASS; CSRF=PASS; cookie-flags=PASS; brand-create-role-enforcement=PASS (DB row, not JWT)
**BOUNCE reason:** SEC-MB-1 HIGH: POST /v1/brands uses workspace_id from request body (brand.routes.ts:43) instead of auth.workspaceId from JWT, breaking session-workspace binding. Fix: replace parsed.data.workspace_id with auth.workspaceId at brand.routes.ts:43. bounce_target=backend-developer.
**Next:** backend-developer fixes brand.routes.ts:43; security-reviewer DELTA re-review (SEC-MB-1 + diff regression only)

## 2026-06-16T11:00:00Z — Security Reviewer — feat-multi-brand (DELTA r2)
**Stage:** 4 · **Mode:** DELTA · **Verdict:** PASS
**Findings:** 0 CRIT / 0 HIGH (SEC-MB-1 resolved) / 0 MED (SEC-MB-2 resolved, SEC-MB-3 resolved) / 1 LOW open (SEC-MB-4, deferred) / 1 INFO (SEC-MB-5 resolved)
**Scanners:** delta-scope (not full suite re-run) — isolation-fuzz pg.test.ts 11/11 PASS live; pg_policies confirmed; secret-grep on bounce diff clean (test-only JWT literals in test files, pre-existing pattern); no new endpoints/migrations/tools in diff
**Reverified:** SEC-MB-1=RESOLVED (brand.routes.ts:58 auth.workspaceId; :34 MISSING_WORKSPACE guard; parsed.data.workspace_id grep clean); SEC-MB-3=RESOLVED (getActiveWorkspaceId removed, workspace_id not sent in body); SEC-MB-2=RESOLVED (toBeGreaterThan(0) assertion, connector_instance=0); SEC-MB-4=LOW open deferred; set-brand MA-01–MA-13 path unchanged (bff.routes.ts/auth.service.ts not in diff)
**Next:** reconcile with QA Engineer (PASS → QA re-review / reconcile); no bounce_target

## 2026-06-16T11:30:00Z — Security Reviewer — feat-multi-brand (DELTA-reconciliation c4d0f92)
**Stage:** 4 · **Mode:** DELTA-reconciliation · **Verdict:** PASS
**Findings:** 0 CRIT / 0 HIGH / 0 MED / 2 LOW open (SEC-MB-4 deferred; SEC-RECON-NOTE-1 informational)
**Scanners:** delta-scope — isolation-fuzz pg.test.ts 11/11 PASS live (NOBYPASSRLS, canary confirmed); pg_policies confirmed live (membership_isolation, membership_self_read, brand_isolation, brand_self_read); e2e 2/5 pass (3 failures = rl:register rate-limit exhausted — test-infra, not regression); secret-grep clean on c4d0f92 diff (2 files: brand.routes.ts + multi-brand.spec.ts)
**Reconciliation verdict:** SEC-MB-1 STILL CLOSED. organizationId = auth.workspaceId ?? body.workspace_id — JWT-wins branch structurally discards body when workspaceId non-null. Bootstrap fallback (workspaceId null) gated by DB membership check (brand.service.ts:68-70: owner/brand_admin in named org, parameterized SQL, independent RLS on membership table). Adversarial probe confirmed: non-member user supplying arbitrary org-id in body → 0 rows from findByUserAndOrg → 403. Cross-tenant create impossible.
**Next:** PASS → reconcile with QA Engineer / no bounce_target

## 2026-06-17T00:00:00Z — Security Reviewer — feat-connector-marketplace
**Stage:** 4 · **Mode:** FULL · **Verdict:** BOUNCE
**Findings:** 0 CRIT / 1 HIGH (HIGH-01: KMSKeyId+EncryptionContext absent from AwsSecretsManager) / 3 MED (MED-01: secretRef in result; MED-02: error body leak; MED-03: brand_id in errors) / 1 LOW (LOW-01: report typo)
**Scanners:** secret-grep on diff clean; DDL scan 0021 — no token columns, NN-1 assertion present, RLS untouched; manual SAST review clean; no new deps/IaC.
**Verified PASS:** D-1 (divergent callback DELETED; brand_id from state only; OAuthCallbackInput has no brandId field; forged-body test structural); HMAC-first (NN-4 confirmed, HmacValidationError fires before any DB op, 401 with no side effects); token-not-in-DB (NN-2: no *_token/*_ciphertext columns in 0021; ARN-only in secret_ref); token-not-in-response (main.ts:486-493 omits secretRef/ARN); disconnect-revokes (deleteSecret+health flip+audit confirmed); isolation (RLS FORCE NOBYPASSRLS, non-inert negative control count===0 under brain_app); authz (requireRole server-side at route scope; analyst→403; manager+backfill→403; brand_admin→501 stub); audit (auditWriter.append on connect+disconnect, sha256 confirmed); envelope {request_id,data}; deferred boundary clean (no detector/backfill-exec/live-sync/DQ/health.changed).
**BOUNCE reason:** HIGH-01: AwsSecretsManager.storeSecret and storeShopifyToken call CreateSecretCommand without KMSKeyId or EncryptionContext. D-7 binding ("per-brand KMS EncryptionContext: {brand_id, connector_type}") stated in comments and interface docstring but not implemented in SDK call. Tags set instead — Tags are metadata only, not cryptographic binding. Per-brand cross-brand decryption isolation guarantee is not structurally enforced. bounce_target=backend-developer.
**Next:** backend-developer adds KMSKeyId + EncryptionContext to both CreateSecretCommand calls (storeSecret + storeShopifyToken); validates KMS key ARN env var at composition root; security-reviewer DELTA re-review (HIGH-01 + MED-01/02/03 if co-fixed; regression check on changed lines only).

## 2026-06-17T10:45:00Z — Security Reviewer — feat-connector-marketplace (DELTA r1)
**Stage:** 4 · **Mode:** DELTA · **Verdict:** PASS
**Findings:** 0 CRIT / 0 HIGH (HIGH-01 CLEARED-WITH-RESIDUAL → tracked MED SEC-CM-RES-01) / 3 MED resolved / 1 LOW resolved
**Scanners:** delta-scope only — no full suite re-run. Regression grep on changed lines: no new endpoints/tools/migrations/secrets/IaC in e812c4f + d01fdd9. Secret scan on diff clean.
**Reverified:** HIGH-01=CLEARED-WITH-RESIDUAL (KmsKeyId:this.kmsKeyId on both CreateSecretCommand calls confirmed at AwsSecretsManager.ts:84,:155; prod-hard-fail at main.ts:363-369 confirmed; SecretRef.test.ts non-inert — 3 positive assertions + 1 negative control goes RED if KmsKeyId dropped; AWS API constraint verified: Secrets Manager does not accept caller EncryptionContext; single-CMK isolation adequate for M1, flagged as M2 debt SEC-CM-RES-01); MED-01=RESOLVED (OAuthCallbackResult has no secretRef field); MED-02=RESOLVED (token exchange error contains status code only, no body); MED-03=RESOLVED (no brand_id in AwsSecretsManager error strings); LOW-01=RESOLVED (04-developer-report-backend.md:74 reads 403).
**Next:** PASS → reconcile with QA Engineer / no bounce_target. Residual debt SEC-CM-RES-01 (MED, M2) tracked in verdict.json.
