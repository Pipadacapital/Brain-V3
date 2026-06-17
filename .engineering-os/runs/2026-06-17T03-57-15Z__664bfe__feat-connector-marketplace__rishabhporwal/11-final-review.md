# Final Review — feat-connector-marketplace

**Stage:** 6 — Final Review (the last gate before the Stakeholder)
**Reviewer:** Engineering Advisor (final-reviewer) — independent go/no-go, verified at source
**Date:** 2026-06-17T10:30:00Z
**Branch:** `feat/connector-marketplace`
**Lane:** HIGH_STAKES (auth, connectors, money, multi_tenancy, outbound_channel, pii, schema_proto, secrets_auth_iam)
**Bounce history:** one round (backend HIGH-01 + 3 MED + LOW; frontend 9th-envelope regression + duplicate testid) — fully remediated; both parallel reviews PASS, 0 blocking.

---

## Recommendation: **APPROVE** (PASS → Stakeholder gate)

**One-line risk:** The only carried risk is SEC-CM-RES-01 — a single shared CMK means per-brand secret isolation rests on IAM/key-policy scoping rather than a per-brand cryptographic key; adjudicated acceptable for M1, tracked to M2.

---

## Verification summary (re-run + verified-at-source, this session)

| Check | Method | Result |
|---|---|---|
| Core typecheck | **Re-ran** `pnpm --filter @brain/core typecheck` | **EXIT 0** |
| Web typecheck | **Re-ran** `pnpm --filter @brain/web typecheck` | **EXIT 0** |
| Connector unit suite (catalog/KMS/health/callback) | **Re-ran** `vitest run src/modules/connector --exclude **/*.live.test.ts` | **35/35 PASS, EXIT 0** (incl. SecretRef KMS non-inert negative control "goes RED when KmsKeyId absent") |
| Backend full suite | Developer + QA captured | 189/189 PASS (DELTA: 70/70 connector incl. 4 new KMS) |
| Marketplace e2e | QA DELTA captured | **6/6 PASS** (38.1s) — incl. coming-soon negative control (POST=null) |
| Full-journey e2e | QA DELTA captured | 1/1 PASS — onboarding no-regression |
| Isolation (brain_app) | **Verified at source** (no DB client in sandbox) | Non-inert: asserts `current_user==='brain_app'` + Brand-B `count===0`, positive+negative controls, dual-pool (super seed / app query) |
| Real-store OAuth smoke | Captured (run brief) | **PASS** — live Shopify connect vs Boddactive: connector_instance Healthy, has_secret=true (token as ref, none in response), audit_log `connector.connected` written, sync_status=waiting_for_data (honest) |
| Deferred-boundary grep | **Re-ran** on diff added-lines | **CLEAN** — no detector/live-sync/health-event/volume-anomaly; only the 501 backfill gate references `backfill` |
| Paradigm (Tier-1) | **Re-ran** model-call grep on diff | **CLEAN** — zero model calls, $0/mo, no `@effort` paths (none needed) |
| Over-engineering | **Re-ran** abstraction grep on diff | **CLEAN** — no IConnector/BaseConnector/plugin-registry/connector_definition table; the two hits are comments documenting the avoidance |

**Sandbox limitation (not a quality gap):** the live DB-backed suite (isolation/forged-body/authz/audit) could not be re-executed here (no psql client / no `brain_app` role in this sandbox). Each was instead **verified at source for non-inertness** and all of them were captured green by the QA DELTA + the developer's 189/189 run; the real-store connect smoke is the strongest live evidence on the connect path. The three deterministic gates I could re-run all pass.

---

## Spot-checks at source (drift / spine / honesty / isolation)

- **D-1 (security spine):** `apps/core/src/main.ts` — the divergent inline callback that read `query['brand_id']` and 400'd-if-missing is **DELETED** (confirmed in diff as removed lines); replaced by `GET /api/v1/oauth/callback/:type` deriving `brand_id` **exclusively** from `consumeAndGetBrandId(state)`; the connect-audit writes `cbResult.brandId` (state-derived). Grep confirms **no surviving `query['brand_id']`/`body.brand_id`** read anywhere in `main.ts`. HMAC-first preserved (NN-4, unchanged Shopify callback). ✔
- **Token secrecy (D-3 / NN-2):** `AwsSecretsManager.ts` binds `KmsKeyId: this.kmsKeyId` (CMK) on both `CreateSecretCommand` calls (`:84` storeSecret, `:155` storeShopifyToken); `main.ts:363` prod-hard-fails if `CONNECTOR_SECRETS_KMS_KEY_ID` absent; `LocalSecretsManager` constructor throws in production. `MarketplaceTileSchema` carries **no** `secret_ref`/token; the marketplace GET handler builds `instance` field-by-field and never includes `secret_ref`. `secret_ref` appears only in the internal `ConnectorInstanceSchema` (ARN at rest) — never crosses the BFF. EncryptionContext-not-an-API-param correctly adjudicated; KmsKeyId-CMK adequate for M1 with SEC-CM-RES-01 to M2. ✔
- **Honest marketplace (§1/§8):** 3-layer coming-soon gate confirmed — HTML `disabled`+`aria-disabled` (marketplace-view), JS `if (isComingSoon) return` early-return, server `422 CONNECTOR_NOT_AVAILABLE` (`main.ts:595`, keys off `availability`, so even oauth-but-coming-soon like meta is rejected). Errored connector flagged (blocked/degraded safety → badge), not undercounted. Skip-For-Now first-class (`btn-skip-for-now`, zero-connection brand renders full grid). ✔
- **Isolation (the ONE invariant):** migration `0021` additive — 2 `ADD COLUMN IF NOT EXISTS`, provider CHECK widened (drop+recreate constraint only, additive in effect), 0006 untouched, RLS policy untouched (already two-arg FORCE), NN-1 one-arg-policy assertion carried forward. Live test asserts `current_user==='brain_app'` + cross-brand `count===0`. ✔
- **Authz (D-9):** connect/disconnect under `requireRole('manager')` scope (`main.ts:574`); backfill under `requireRole('brand_admin')` returning **501** (`:714`); analyst (below manager) → 403 on connect; marketplace read is `analyst+` (rendering ≠ connecting — correct). ✔
- **Envelope (D-10):** `connectorsApi.list()` (`client.ts:561`) now derives from `getMarketplace()` (`:562`), which unwraps `.data.tiles` via `mapTiles`; the old `raw.data.shopify` destructure survives only as an explanatory comment. No new mismatch introduced. ✔
- **Deferred boundary (D-12):** grep CLEAN — no detector/backfill-execution/live-sync/DQ-gating/`connector.health.changed` emit in the diff. ✔
- **Over-engineering / drift:** delivered set == plan (catalog 4 files, migration 0021, secrets seam, generic routes, contracts, web marketplace). No new deployable (core + web only). Catalog static (9 tiles, 7 categories). Health = 2 additive columns, not a table. ✔

---

## Validity confirm (negative controls present, non-inert)

- **Tenancy:** RLS isolation negative control under `brain_app` — `count===0`, with an explicit `current_user==='brain_app'` assertion proving RLS is enforced, not superuser-masked. Non-inert. ✔
- **Auth/callback:** forged-body control — `OAuthCallbackInput` has no `brandId` field (structural), state-derived value used. ✔
- **Secrets:** SecretRef KMS control — "goes RED when KmsKeyId is absent" (re-ran, passes). ✔
- **UI gate:** coming-soon e2e control — disabled tile force-click → `firedRequest===null` (zero POSTs). ✔
- `validity_check --require-negative-control` → clean, EXIT 0 (QA + frontend DELTA).

No bypass-green, no inert probe, no tautological parity on any money/auth/tenancy path.

---

## Risks remaining (all tracked, none blocking)

| ID | Severity | Risk | Disposition |
|---|---|---|---|
| **SEC-CM-RES-01** | MED (tracked debt) | Single shared CMK across all brands; per-brand isolation rests on IAM/key-policy, not a per-brand key. A broad GetSecretValue+key-policy grant could decrypt any brand's secret. | Acceptable M1 if CMK key policy is scoped per IRSA/service-account. **M2:** evaluate per-brand CMK / KMS Grants. Document in ADR-CM-4 addendum. |
| **KNOWN-CM-01** | LOW (known limit) | `UNIQUE(brand_id, provider)` = one instance per provider; blocks multi-account (e.g. multiple Razorpay settlements). | No multi-account connector ships M1 (Razorpay is coming_soon). Widening later is itself additive. Documented. |
| **Scale-C4** | LOW (known limit) | `InProcessOAuthStateStore` is single-instance; horizontal scale breaks nonce lookup across pods. | M1 single-pod. `IOAuthStateStore` seam reserves the Redis path. Documented. |
| **Sec-C3** | INFO (non-goal) | Disconnect deletes from Secrets Manager only; no provider-side OAuth revocation (Meta/Google). | Explicit non-goal; per-connector revocation is a later slice. |
| Real Shopify token exchange in CI | INFO | Full token exchange needs a staging env; CI exercises the install-URL build. | Carried; the real-store Boddactive smoke covers the full exchange manually. |

Minor non-blocking notes (recorded, no action required to ship):
- Health-state literals normalized to no-space form (`RateLimited`/`TokenExpired`) vs the requirement's spaced text — consistent across migration + contract + entity + UI; cosmetic naming, not a defect.
- QA verdict `negative_control[0].path` points at `.../shopify/tests/connector-marketplace.live.test.ts`; the file actually lives at `.../connector/tests/connector-marketplace.live.test.ts`. Path-string inaccuracy in the JSON only; the test exists and is non-inert.

---

## Hard-rule deviation check

No dependency violation · no Single-Primitive violation (one secrets seam, one audit writer, one RBAC guard, one state store, one connector_instance table +2 cols, one catalog SoR, one OAuth callback path) · no compliance gap · no paradigm escalation beyond plan (Tier-1 deterministic, $0/mo) · no un-codified gate-skip. **No hard-rule deviation — auto-approve is in lane; nothing to surface to the Stakeholder beyond the tracked debt above.**

---

## Recurrence / auto-candidate rule

This run's root cause (a legacy client method — `connectorsApi.list()` — left reading the OLD `raw.data.shopify` shape after the backend endpoint was swapped to the marketplace envelope) is an instance of the envelope-`.data`-unwrap theme. That theme recurs across runs, **but it is already actively guarded**: every run carries an explicit "no Nth-envelope-mismatch" binding D-item, the Architect plans the `.data` unwrap at the call site, and QA holds a VETO on any flat read. The *distinct prior runs* sharing this run's precise mechanism number **2** (members-team-management, analytics-api-dashboard) — below the ≥3 threshold — and the broad pattern is mitigated procedurally, not un-codified. **No rule-proposal written** (adding a durable rule over an already-controlled risk would be process tax). See `14-retro.md`.

---

## Decision

**PASS → advance to the Stakeholder gate (Stage 7).** Blocking findings: **0**. The Stakeholder weighs the carried debt (SEC-CM-RES-01 [M2], KNOWN-CM-01, Scale-C4) and the branch merge. The orchestrator advances the gate and runs the commit — I do not commit here.
