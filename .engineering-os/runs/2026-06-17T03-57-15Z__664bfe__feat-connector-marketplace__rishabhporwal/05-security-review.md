# Security Review — feat-connector-marketplace

**Stage:** 4 — Security + Compliance
**Reviewer:** security-reviewer
**Date:** 2026-06-17T00:00:00Z
**Mode:** FULL (first review of this surface, HIGH_STAKES lane)
**Branch:** feat/connector-marketplace
**Verdict:** BOUNCE

---

## Non-negotiable verification results

### D-1 / MED-CALLBACK-01: brand_id from signed state ONLY

**VERIFIED — PASS.**

- `main.ts:442` comment: "REPLACES the divergent main.ts:422 handler that read brand_id from query."
- The divergent inline callback that read `query['brand_id']` has been DELETED. No `brand_id`-from-query reference survives in `main.ts` — grep of `brand_id.*query|query.*brand_id` returns only the comment at line 442.
- `HandleOAuthCallbackCommand.ts:26-35` — `OAuthCallbackInput` has NO `brandId` field (compile-time structural proof).
- `HandleOAuthCallbackCommand.ts:96` — `brandId` is derived exclusively from `stateStore.consumeAndGetBrandId(state)`.
- `main.ts:462-466` — the callback route destructures only `connectorInstanceId`, `shopDomain`, `status` from `cbResult`; `secretRef` and `brandId` are NOT forwarded to the HTTP response.
- HMAC-first order confirmed at `HandleOAuthCallbackCommand.ts:80-86` — HMAC checked before state or DB work; `HmacValidationError` → 401 with no side effects (verified `main.ts:495-496`).

### Token secrecy (D-3/NN-2/I-S09)

**VERIFIED (storage path) — PASS for no-token-in-DB and no-token-in-response. BOUNCE on KMS EncryptionContext (see HIGH-01).**

- `0021_connector_health.sql` — no `*_token`, `*_ciphertext`, `*_key`, `*_secret` columns added. NN-1 assertion block at end of migration confirms existing policy uses two-arg `current_setting`.
- `0006_connector.sql:19-50` — existing `secret_ref` (ARN) column confirmed, no token column.
- `HandleOAuthCallbackCommand.ts:119` — "accessToken is now discarded — only secretRef (ARN) proceeds."
- `main.ts:486-493` — callback HTTP response contains `connector_instance_id`, `shop_domain`, `status` only. No `secret_ref`, no `arn`, no `access_token`.
- `main.ts:533` — marketplace tile response has "NN-2: NO secret_ref, NO token."
- `MarketplaceTileInstance` in `types.ts` confirmed no `secret_ref` / token fields.
- **HIGH-01 (BLOCKING):** `AwsSecretsManager.storeSecret` (lines 62-74) does NOT set `KMSKeyId` or `EncryptionContext` on `CreateSecretCommand`. The D-7 requirement — "per-brand KMS EncryptionContext: { brand_id, connector_type }" — appears only in a comment (line 66-67) and in `ISecretsManager.ts:38` (interface docstring) but is NOT implemented in the actual SDK call. Tags are metadata only; they do NOT enforce KMS-AEAD cross-brand decryption isolation. This is the stated security guarantee (D-7/D-3/ADR-CM-4) that is not realized in code.
- Note: `storeShopifyToken` (lines 124-160) also lacks `KMSKeyId` + `EncryptionContext` — same gap for the existing Shopify path.

### Isolation (I-S01)

**VERIFIED — PASS.**

- `0006_connector.sql:42-50` — `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` + policy `USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid)` on `connector_instance`. `brain_app`: SELECT, INSERT, UPDATE only (no DELETE, no BYPASSRLS).
- `0021_connector_health.sql` — additive only; RLS/GRANTs not weakened; 0006 untouched; NN-1 assertion block verifies two-arg policy remains.
- `getBrandId()` at `main.ts:397-403` — reads from `auth.brandId` (JWT), never from body/query; throws `NO_BRAND_CONTEXT` if null.
- Isolation test (describe 8) confirmed non-inert: negative control asserts `count === 0` under `SET ROLE brain_app` (NOSUPERUSER NOBYPASSRLS). Positive control also present. `current_user` = `brain_app` confirmed.

### Disconnect revokes (Sec-C3/C4)

**VERIFIED — PASS.**

- `DisconnectCommand.ts:46-51` — `instance.disconnect()` flips `health_state→Disconnected`/`safety_rating→blocked` + `connectorRepo.update()` + `secretsManager.deleteSecret(instance.secretRef)` — all three steps before event emit.
- `main.ts:678-687` — audit `connector.disconnected` written with `brand_id`, `actor_id`, `actor_role`; NO `secret_ref`, NO token in payload.

### Authz (D-9)

**VERIFIED — PASS.**

- `main.ts:563` — `requireRole('manager')` on POST /api/v1/connectors and DELETE /api/v1/connectors/:id.
- `main.ts:703` — `requireRole('brand_admin')` on backfill 501 gate.
- `main.ts:513` — `requireRole('analyst')` on read routes.
- `rbac.ts:44-53` — role check is server-side via JWT claims; 403 on insufficient role.
- `getBrandId` called from authenticated context only (session preHandler runs before role guard).
- Note: developer report line 74 says "402 for manager" on backfill — actual code returns 403. Correct behavior; report contains a typo.

### Envelope / PII

**VERIFIED — PASS.**

- All new routes return `{request_id, data}` envelope confirmed.
- Audit payloads explicitly exclude `secret_ref`/token (comments at `main.ts:477`, `main.ts:686`, `HandleOAuthCallbackCommand.ts:159`).
- `OAuthCallbackResult.secretRef` (ARN) is returned from the command but NOT forwarded to the HTTP response (`main.ts:462-466` destructures only `connectorInstanceId`, `shopDomain`, `status`).
- No PII-shaped fields in log messages reviewed.

### Deferred boundary (D-12)

**VERIFIED — PASS.**

- Scope-creep grep of `apps/core/src` for `backfill`, `live.sync`, `health.detector`, `volume.anomaly`, `connector\.health\.changed`: only one hit — `main.ts:700` backfill 501 gate comment and `main.ts:705` backfill route (501 stub, brand_admin gated). No execution code.
- No detector, live-sync, DQ-gating, or `connector.health.changed` emit found in diff.

### Verification-validity

**CONFIRMED.** The isolation test uses the real `brain_app` pool (NOSUPERUSER NOBYPASSRLS) with a non-inert negative control (`count === 0`). The forged-body test is structural (compile-time: `OAuthCallbackInput` has no `brandId` field) + unit test. The HMAC negative control proves `HmacValidationError` fires first with no repo calls. These are not bypass-green or inert probes.

---

## Findings

### HIGH-01: AwsSecretsManager.storeSecret and storeShopifyToken do NOT set KMSKeyId + EncryptionContext — stated D-7 guarantee not implemented

**Severity:** HIGH
**File:** `apps/core/src/modules/connector/sources/storefront/shopify/infrastructure/secrets/AwsSecretsManager.ts:62-74` (storeSecret), `lines:132-145` (storeShopifyToken)
**Status:** OPEN — BLOCKING

**Detail:** D-7 binding and ADR-CM-4 state: "every storeSecret write uses EncryptionContext: { brand_id, connector_type } for per-brand KMS decryption isolation. Even if an ARN leaks, decryption without matching EncryptionContext fails." This guarantee is stated in comments and interface docstrings but is NOT enforced in the actual `CreateSecretCommand` call. The SDK call sets only `Tags` (metadata), not `KMSKeyId` (customer-managed key) or `EncryptionContext` (cryptographic AEAD binding). Without `KMSKeyId` pointing to a customer-managed key, AWS Secrets Manager uses the AWS-managed default key (no per-brand isolation, no EncryptionContext enforced). An attacker with SecretsManager:GetSecretValue IAM access to any brand's ARN could retrieve any brand's secret — the cross-brand KMS decryption isolation guarantee is not structurally enforced.

**Remediation:** Add `KMSKeyId: process.env['CONNECTOR_SECRETS_KMS_KEY_ID']` and `SecretString` encrypted with `EncryptionContext: { brand_id: brandId, connector_type: connectorRef.connectorType }` to both `CreateSecretCommand` calls. The `GetSecretValueCommand` and `DeleteSecretCommand` callers must supply the same EncryptionContext. Update `AwsSecretsManager` constructor to accept a `kmsKeyId` parameter injected from the composition root. The composition root in `main.ts` must validate the env var is present in production; throw if absent.

---

### MED-01: OAuthCallbackResult exposes secretRef (ARN) to caller — low-value but unnecessary exposure

**Severity:** MEDIUM
**File:** `apps/core/src/modules/connector/sources/storefront/shopify/application/commands/HandleOAuthCallbackCommand.ts:163-169`
**Status:** OPEN — non-blocking (ARN not in HTTP response)

**Detail:** `OAuthCallbackResult.secretRef` exposes the AWS Secrets Manager ARN to the caller. While `main.ts` does not forward it to the HTTP response (verified), the ARN is in the in-process return value. The ARN reveals the secret namespace path `brain/connector/shopify/<brand_id>/...` which could assist privilege escalation if process memory is inspected. Low-impact in current state (ARN is not a credential), but violates the principle of least knowledge at the command return boundary.

**Remediation:** Remove `secretRef` from `OAuthCallbackResult`. The interface consumer (`main.ts`) does not use it; the ARN is already persisted to the DB by `connectorRepo.save(instance)`.

---

### MED-02: Token exchange error body logged to caller-visible error chain — potential Shopify error PII disclosure

**Severity:** MEDIUM
**File:** `apps/core/src/modules/connector/sources/storefront/shopify/application/commands/HandleOAuthCallbackCommand.ts:190-193`
**Status:** OPEN — non-blocking

**Detail:** On a failed token exchange, the Shopify API response body (`const body = await response.text()`) is included verbatim in the thrown `Error.message`. Shopify's error body for an expired/invalid code may include shop context. This error message propagates up to the Fastify error handler, which may log it. If the logger ships to a log aggregator, this body is captured. Shopify error bodies are not typically PII-containing, but the practice violates the "strip tokens from error paths" principle.

**Remediation:** Log the HTTP status code only; redact the Shopify response body from the thrown error: `throw new Error(\`[HandleOAuthCallbackCommand] Token exchange failed (${response.status})\`)`. Emit the body only at DEBUG level via a structured logger (never plain string concat), and confirm the log shipper redacts it if needed.

---

### MED-03: Error message in AwsSecretsManager includes brand_id in plain text

**Severity:** MEDIUM
**File:** `apps/core/src/modules/connector/sources/storefront/shopify/infrastructure/secrets/AwsSecretsManager.ts:76-78`
**Status:** OPEN — non-blocking

**Detail:** On a `CreateSecret` failure, the error message includes `brand ${brandId} connector ${connectorRef.connectorType}`. If this error propagates to application logs, `brand_id` appears in error log lines. `brand_id` is a UUID (not direct PII), but its presence in logs should be avoided per COMPLIANCE.md no-PII-in-logs control (structural: UUIDs are linked identifiers). Consistent with the compliance engine's "name+value combo = never co-logged" principle.

**Remediation:** Replace the brand_id in the error message with a truncated hash or omit it: `throw new Error(\`[AwsSecretsManager] Failed to store secret for connector ${connectorRef.connectorType}\`)`. Log the brand_id at DEBUG level separately with structured logging if needed for debugging.

---

### LOW-01: Report typo "402 for manager" on backfill — actual code returns 403

**Severity:** LOW (documentation only — code is correct)
**File:** `04-developer-report-backend.md:74`
**Status:** OPEN — non-blocking

**Detail:** Developer report line 74 states "`POST /api/v1/connectors/:id/backfill` returns 501; requires `brand_admin+` (402 for manager)." The actual `requireRole('brand_admin')` in `main.ts:703` returns 403 (FORBIDDEN) for a manager, which is correct. The "402" (Payment Required) in the report is a typo. No code fix needed; report update only.

---

## Scanners

**Mode: FULL — scanner suite assessment against diff**

- Secret grep on diff: No plaintext tokens, credentials, or ARNs found in source files. `LocalSecretsManager` correctly stores in-process Map only.
- SAST (Semgrep): Not run directly (no CI tooling in this review context). Manual review of all new TypeScript paths confirms no `eval`, `innerHTML`, unsafe SQL concatenation, or hardcoded secrets. The `EncryptionContext` gap is a logical/configuration defect, not a SAST-catchable pattern.
- DDL scan: `0021_connector_health.sql` — no `*_token`/`*_ciphertext`/`*_key`/`*_secret` columns. NN-1 assertion block present. Provider CHECK widened additively. RLS not weakened.
- Dependency audit: Not re-run (no new packages introduced per developer reports; no new `package.json` changes declared).
- IaC/container: No new Terraform or Docker changes in this slice (I-E05 — no new deployable).

---

## Compliance check

- Brand isolation (I-S01): PASS — RLS FORCE + NOBYPASSRLS confirmed.
- No raw PII in events/logs (I-S02): PASS — audit payloads are IDs only; no contact PII in connector flows.
- Secrets never in DB (I-S09): PASS for no-token-in-DB. HIGH-01 (KMS EncryptionContext missing) partially undermines the per-brand isolation guarantee but tokens ARE in Secrets Manager (not plaintext in DB).
- Audit trail (I-S06): PASS — `auditWriter.append()` called on connect and disconnect; real sha256 hash-chain confirmed.
- Additive migration (I-E02): PASS — 0021 adds columns with defaults; 0006 untouched.
- Contract-first (I-E01): PASS — Zod contracts in `connector.api.v1.ts` committed before route handlers.
- Simplicity-first (I-E05): PASS — no new deployable, no new service.
- No outbound channel in this slice: no consent/window-check obligation triggered. TCCCPR/DLT compliance gates not relevant to this surface.
- PCI SAQ-A (I-S10): PASS — no card data columns.

---

## Summary

| Finding | Severity | Status |
|---|---|---|
| HIGH-01: KMSKeyId + EncryptionContext absent from AwsSecretsManager | HIGH | OPEN — BLOCKING |
| MED-01: secretRef in OAuthCallbackResult | MEDIUM | OPEN — non-blocking |
| MED-02: Token exchange error body in error chain | MEDIUM | OPEN — non-blocking |
| MED-03: brand_id in AwsSecretsManager error messages | MEDIUM | OPEN — non-blocking |
| LOW-01: Report typo 402 vs 403 | LOW | OPEN — non-blocking |

**Blocking:** 1 (HIGH-01)
**VETO exercised on HIGH-01.**


---

## DELTA re-review — 2026-06-17T10:45:00Z — Mode: DELTA — Verdict: PASS

**Bounce-fix commits reviewed:** e812c4f (HIGH-01), d01fdd9 (MED/LOW), 04167a4 (report).
**Delta scope:** HIGH-01 + MED-01/02/03 + LOW-01. Regression check on changed lines only. Unchanged surfaces (D-1, HMAC-first, RLS isolation, authz, envelope, deferred boundary) not re-reviewed — all carried from FULL PASS.

### HIGH-01 — CLEARED-WITH-RESIDUAL

**Adjudication:** The dev's claim is verified and correct. AWS Secrets Manager's `CreateSecret` and `GetSecretValue` APIs do NOT accept a caller-supplied `EncryptionContext` parameter — the service manages its own internal encryption context keyed to the secret ARN. This is a real AWS API constraint; the original finding's reference to `EncryptionContext` reflected the D-7 design intent (per-brand AEAD binding) but the Secrets Manager API surface does not expose that parameter to callers.

**What the fix provides:** `KmsKeyId: this.kmsKeyId` is now set on both `CreateSecretCommand` calls (`AwsSecretsManager.ts:84` in `storeSecret`, `:155` in `storeShopifyToken`). This binds each secret to the customer-managed CMK. The CMK key policy and IAM are the structural per-brand isolation boundary — a caller without permission on the CMK cannot call `GetSecretValue` even with the ARN. The composition root at `main.ts:363-369` throws a FATAL error at startup if `CONNECTOR_SECRETS_KMS_KEY_ID` is absent in production. `SecretRef.test.ts` contains four tests proving CMK binding: three assert `cmd.input.KmsKeyId === KMS_KEY_ID` on the actual SDK call; the negative-control test (`:157-172`) is non-inert and goes RED if the field is dropped.

**Residual (tracked as MED debt, not a block):** A single shared CMK across all brands means the CMK key policy and IAM are the per-brand isolation boundary, not a per-brand key. A service account with broad `kms:Decrypt` on the CMK could cross-decrypt. This is acceptable for M1 under correct key policy configuration (IRSA role scoped to the workload, not per-brand). Defer to M2: evaluate per-brand KMS Grants or per-brand CMK aliases. Document rationale in ADR-CM-4 addendum. Tracked as `SEC-CM-RES-01`.

### MED-01 — RESOLVED

`OAuthCallbackResult` interface (`HandleOAuthCallbackCommand.ts:37-45`) has no `secretRef` field. Return object at `:163-169` returns `{connectorInstanceId, brandId, shopDomain, status}` only. Confirmed.

### MED-02 — RESOLVED

On `response.ok === false`, `HandleOAuthCallbackCommand.ts:189-194` throws `Error` containing only `response.status`. No `response.text()` call present in the failure path. Body is discarded. Confirmed.

### MED-03 — RESOLVED

`AwsSecretsManager.ts:93-96` (`storeSecret` error): no `brandId` in message — only `connectorType`. Line `:165-169` (`storeShopifyToken` error): `'Failed to store Shopify token'` — no `brandId`. Confirmed.

### LOW-01 — RESOLVED

`04-developer-report-backend.md:74` reads `"403 for manager"`. Confirmed.

### Regression check

No new endpoints, tools, migrations, secrets, or IaC introduced in the bounce-fix diff. No plaintext credentials or ARNs detected in changed lines.

**Blocking count: 0. Verdict: PASS.**
