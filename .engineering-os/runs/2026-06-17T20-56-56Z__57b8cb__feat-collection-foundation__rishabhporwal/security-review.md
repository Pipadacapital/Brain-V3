# Security Review — feat-collection-foundation (Phase 1, Collection Foundation)

| Field | Value |
|---|---|
| **req_id** | feat-collection-foundation |
| **Stage** | 4 — Security Review |
| **Mode** | FULL (first review of a high-stakes surface: multi-tenancy + PII + consent + outbound-edge) |
| **Reviewer** | Security Reviewer |
| **Model** | Opus 4.8 (1M) |
| **Verdict** | **PASS** (reconcile with QA) |
| **Diff** | `git diff master...feat/collection-foundation` (56 files) |

**Verdict: PASS — recommendation APPROVE.** 0 blocking; severity counts C0 / H0 / M0 / L2.

THE invariant under review: per-brand isolation (RLS FORCE), verified under `brain_app` (the dev superuser `brain` bypasses RLS — any check not under `brain_app` is INERT). PII/salt off the wire (ADR-2). Consent quarantine-not-drop (R3 / COMPLIANCE.md).

---

## Gate results (file:line evidence)

### R2 — THE keystone: server-side tenant-key derivation — PASS (non-inert)
- `ProcessEventUseCase.ts:120-157` — `brand_id` starts as `claimedBrandId` but is OVERWRITTEN by the DERIVED value only after token resolution. The Bronze row (`:167`) and the GUC (`BronzeRepository.ts:102`) are built from the derived `brand_id`, NEVER the client-stamped one. The claimed top-level `brand_id` is partition-only.
- Token absent/malformed/unresolved → `:125-132` quarantine (`tenant_unresolved`), 0 Bronze rows.
- Claimed ≠ derived → `:134-143` quarantine (`brand_mismatch`) + `audit_log pixel.brand_mismatch` under the TRUE token owner (`:212-242`). Idempotent on event_id (`:234`).
- Resolver `BronzeRepository.resolveBrandByInstallToken` (`:68-90`): UUID-regex pre-guard (`:74-78`) prevents `::uuid` cast throw; returns null → caller quarantines.
- Migration `0028`: `SECURITY DEFINER` + `STABLE` + `LANGUAGE sql` + `SET search_path=public` (`:45-48`), `GRANT EXECUTE TO brain_app` (`:57`), dispatch-only return `(brand_id)` (`:42-44`). Migration-time assertions enforce `prosecdef=true` + `search_path=public` + `brain_app EXECUTE` (`:59-120`) — drift fails the migration.
- **Non-inert proof:** `ingest-hardening.e2e.test.ts:248-322` — cross-brand (claim A, token B) → quarantined, 0 Bronze rows under brain_app for BOTH brands (`:263-264`), audit row asserted (`:267`), and `.quarantine` message ACTUALLY produced + consumed-back from Redpanda (`:270-322`). All reads go through `readBronzeAsApp` which calls `assertBrainApp(brainAppPool)` first (`:128`) — RLS truly enforced. Positive control + cross-brand-0 + no-GUC-0 in test #7 (`:439-457`). Un-wiring the derivation would make a cross-brand event write under the claimed brand → these assertions break. CONFIRMED non-inert.
- Connector/backfill lanes opt out correctly: `main.ts:104-108` `enforceTenantDerivation=false` (server-trusted brand, no install_token) — R2 browser-spoofing threat model does not apply.

### R3 — consent quarantine-not-drop + CI gate — PASS
- `ProcessEventUseCase.ts:146-153` — absent `consent_flags` → quarantined (`consent_absent`), not dropped, not Bronze-as-trusted. Proven `ingest-hardening.e2e.test.ts:378-390` (0 Bronze rows).
- Quarantine sink: `CollectorEventConsumer.ts:84-103` routes `quarantined` → `${topic}.quarantine` via the shipped DlqProducer, then commits offset (mirrors `.dlq`). Topic declared additively in `infra/redpanda/topics.yml`. Never Bronze under a claimed brand.
- Envelope: `consent_flags` is a first-class optional field (`sample.collector.event.v1.ts:89-96`); avsc additive-optional nullable union default null (FULL_TRANSITIVE) — back-compat safe.
- CI gate `consent-propagation.gate.test.ts` runs under vitest (build-failing): asserts the envelope carries `consent_flags` with the 4 COMPLIANCE booleans (`:57-96`) AND no-pii-schema-lint bans top-level raw-PII/salt fields (`:99-113`). Non-inert: a partial consent_flags is rejected by the live schema (`:87-95`); removing the field reds the gate.

### ADR-2 — no raw PII, no salt on the wire / in collector_spool — PASS
- SDK grep clean: no email/phone/name/salt/sha256/hmac/pepper anywhere in `packages/pixel-sdk/src/`. `capture.ts:60-87` emits only behaviour + anon-id + attribution. `consent.ts` transports booleans only. `transport.ts` POSTs the event object verbatim — no enrichment.
- SDK test asserts the wire body contains no email/phone/salt/name/first_name/last_name (`pixel-sdk.test.ts:215-223`).
- `collector_spool` never receives PII: the SDK sends none; the edge guard reads only `properties.install_token` (`edge-guard.ts:96`). Server-side hashing seam (`identity-core` + `SaltProvider.forBrand`) is NOT invoked in the collector edge or SDK — Phase 1 carries no known-user identifier. Negative guarantee structurally enforced by the no-pii-schema-lint gate.
- `document.cookie` read in `browser-entry.ts:28` is bootstrap-read only — confirmed NO Set-Cookie anywhere (grep clean; `pixel-asset.route.ts:130`, `edge-guard.ts:88`, `transport.ts:10` all assert stateless).

### Edge — rate-limit + origin allowlist reject-before-spool, no Set-Cookie — PASS
- `edge-guard.ts:81-104` is a Fastify `preHandler` scoped to `/collect` + `/v1/events` (`:83`), running BEFORE the spool insert. Origin allowlist rejects 403 (`:87-91`); per-install_token fixed-window rate-limit rejects 429 (`:97-103`). Bounded bucket memory under token-fuzzing (`:57-60`). Token-less bodies share a bucket (DoS bound) and quarantine downstream via R2. NO Set-Cookie on either rejection path.
- `/pixel.js` asset (`pixel-asset.route.ts`) serves with correct content-type + cache headers, NO Set-Cookie.

### R4 — observable dedup + malformed→DLQ — PASS
- `CollectorEventConsumer.ts:108-114` emits `collector_dedup_conflict_total{brand_id,layer,event_name}` on pk_conflict/dedup_hit (replaces the bare console.info). Labels bounded + PII-safe (`observability/src/index.ts:136-195`; brand_id UUID, layer∈{pg,redis}, event_name bounded enum).
- Malformed → `invalid` → `.dlq` (`:67-82`); proven `ingest-hardening.e2e.test.ts:364-375`.

### Traceability — PASS
- `correlation_id` required on the envelope (`sample.collector.event.v1.ts:44`), propagated into Bronze (`ProcessEventUseCase.ts:176` row) + the brand_mismatch audit payload (`:229`). Observability spans carry brand_id + correlation_id and drop PII-keyed attributes (`observability/src/index.ts:64-77,70-72`).

### Read-path (Track C BFF) — PASS
- `get-tracking-health.ts` + `get-recent-events.ts` read inside `withBrandTxn(deps.pool, brandId)` (RLS-scoped); SELECT only type/time + anonymized ids (brain_anon_id / hashed_session_id) + consent booleans — NEVER raw PII. Brand comes from `auth.brandId` (session), guarded `if (!auth.brandId)` (`bff.routes.ts:35,72`), never from request body (D-1). Cross-brand read = 0 under brain_app proven (`ingest-hardening.e2e.test.ts:439-457`).

---

## Scanners (FULL)
- Secret-grep on staged diff: clean (only journal/doc text references "secret"; no live credentials, keys, tokens).
- No new outbound channel introduced. Consent is capture-only this phase by design; enforcement (the Phase-5 can_contact() concern) is correctly NOT built here — a scope boundary, not a security gap.
- No new model/LLM call (deterministic tier-1 — paradigm honored).
- Note: container/SCA/Trivy/Grype scanner suite execution is the CI/Platform-DevOps gate (Stage 8); this review verifies code-level controls + secret-grep. No new third-party dependency of concern in the diff (pixel-sdk is first-party; pnpm-lock delta is the new workspace package).

## Verification-validity
- Every isolation read runs under `brain_app` with `assertBrainApp()` first (non-inert). Negative controls present: cross-brand→quarantined+0-rows, tenant-less→quarantined, malformed→DLQ, absent-consent→quarantined, no-GUC→0. QA confirmed RED on the cross-brand + consent gates (live.log 22:09:47Z). E2E fails-closed offline (suite ERRORS, does not exit 0).

---

## Findings

| id | severity | status | note |
|---|---|---|---|
| SEC-CF-01 | LOW | OPEN (non-blocking) | `ingest-hardening.e2e.test.ts` dedup-observability test (#6, `:418-431`) asserts the metric by calling `incrementCounter` directly rather than driving it through `CollectorEventConsumer.ts:108-114`. The consumer emission path itself is correct + present; the assertion does not exercise it end-to-end. Recommend tightening the test to spy through the consumer. Does not affect the shipped control. |
| SEC-CF-02 | LOW | NOTE | `audit_log` is queried in tests via the superuser pool (`countAudit`, `:158-164`) because audit_log is RLS-disabled by design (system-of-record). The write path (`DbAuditWriter` under brain_app) is correct; the test-read posture is acceptable for a forensic table. No leak. |

Zero blocking findings (severity counts C0 / H0 / M0 / L2). No compliance-regime violation. No traceability gap on any new path.

---

## Verdict

**[SECURITY] PASS** — the R2 keystone is correctly bound (brand_id derived server-side, client value never trusted, cross-brand quarantined + audited, non-inert under brain_app), R3 consent quarantine + CI gate are wired and non-inert, ADR-2 negative guarantee holds (no PII/no salt on the wire or in collector_spool), the edge rejects before spool with no Set-Cookie, and quarantine routes to the `.quarantine` topic never Bronze. Two LOW notes, neither blocking.

Controls Verified: server-side tenant-key derivation (0028 SECURITY DEFINER, search_path-pinned, brain_app EXECUTE) · RLS FORCE non-inert under brain_app · withBrandTxn on all reads · consent quarantine-not-drop + CI gate · no-pii-schema-lint · edge rate-limit + origin allowlist reject-before-spool · no Set-Cookie · correlation-id traceability · PII-safe metrics/spans.

Accepted by: Security Reviewer on 2026-06-18
