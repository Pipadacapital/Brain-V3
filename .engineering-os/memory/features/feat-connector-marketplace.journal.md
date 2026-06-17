# Feature Journal — feat-connector-marketplace

## 2026-06-17 — Stage 2 Architecture (Architect) — GO for builders
**Lane:** HIGH_STAKES (auth, connectors, money, multi_tenancy, outbound_channel, pii, schema_proto, secrets_auth_iam). **Paradigm:** Tier-1 deterministic ($0/mo, 0 tokens/day).
**What ships:** connector catalog (static TS SoR) + category-organized Integration Marketplace UI + generic connect/callback/disconnect seam (Shopify registered, not rewritten) + 7-state health model (2 additive cols) + secrets seam generalization + server-side authz + audit writes.
**Migration:** 0021_connector_health.sql (additive: health_state + safety_rating cols + widened provider CHECK). 0006 untouched.
**Key bindings:** brand_id from signed state ONLY (D-1; DELETES the divergent main.ts:422 query-brand_id callback); NO token column (secret_ref/ARN only, NN-2/I-S09); UNIQUE(brand_id,provider) kept for M1 (KNOWN-CM-01); authz manager+ connect/disconnect, brand_admin+ backfill (501 gate), analyst 403; {request_id,data} envelope; auditWriter (real sha256, L-02 closed) on connect+disconnect.
**Tracks:** A @backend-developer (lead, owns A0 contract+catalog freeze) ∥ B @frontend-web-developer (starts post-A0). COMMIT PER SLICE. Branch feat/connector-marketplace.
**Out of slice (D-12):** detector, backfill execution, live-sync, DQ gating, connector.health.changed emit, provider-side revocation, deep connectors, GCC, DB-backed catalog, plugin registry.
**Artifacts:** 01-requirement.md, 02-cto-advisor-review.md, 03-architecture-plan.md.
**Next:** Stage 3 — @backend-developer + @frontend-web-developer (parallel).

## 2026-06-17 — Stage 4 Security Review — BOUNCE
**Verdict:** BOUNCE (1 HIGH blocking). **Mode:** FULL.
**Blocking:** HIGH-01 — AwsSecretsManager does not set KMSKeyId + EncryptionContext on CreateSecretCommand; D-7/ADR-CM-4 per-brand KMS isolation guarantee not implemented (Tags ≠ EncryptionContext).
**Non-blocking:** MED-01 secretRef in OAuthCallbackResult; MED-02 error body in token exchange error chain; MED-03 brand_id in AwsSecretsManager error messages; LOW-01 report typo 402 vs 403.
**All other checks PASS:** D-1 brand-from-state (divergent callback deleted, OAuthCallbackInput has no brandId, structural + unit test); HMAC-first (NN-4); token not in DB or response (NN-2); RLS FORCE + non-inert isolation test (brain_app NOSUPERUSER); authz server-side requireRole; disconnect deletes secret + health flip + audit; {request_id,data} envelope; no deferred code in diff (D-12 clean).
**Next:** backend-developer fixes HIGH-01 (KMSKeyId+EncryptionContext on CreateSecretCommand); security-reviewer DELTA re-review.
