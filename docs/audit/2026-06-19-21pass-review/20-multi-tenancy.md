# Pass 20: Multi-Tenancy Isolation Audit (.engineering-os/audit-passes)

**Date:** 2026-06-19  
**Auditor:** Principal-level audit pass (automated)  
**Board:** multi-tenancy  
**Scope:** Tenant isolation at rest / in transit / in queries; tenant key on every row/event/cache-key/log; RLS enforcement; cross-tenant access prevention; noisy-neighbor risk; tenant-level rate limits/quotas; onboarding safety; offboarding/deletion safety.

---

## Board Verdict

The Brain monorepo applies a consistently deep multi-tenancy isolation architecture. The core Postgres RLS pattern (two-arg `current_setting('app.current_brand_id', TRUE)::uuid` with FORCE ROW LEVEL SECURITY under the non-owner `brain_app` role) is applied to every brand-scoped table across 36 migrations, with migration-time DO-block assertions that enforce NN-1 compliance at deploy time. The GUC is always transaction-scoped (`is_local=true`), preventing cross-connection bleed. The `withBrandTxn` helper in `packages/metric-engine/src/deps.ts` enforces BEGIN→GUC→fn→COMMIT atomically on every analytics read. The StarRocks Silver tier injects `brand_id = ?` at the single `withSilverBrand` seam since StarRocks row policies are enterprise-only. Redis cache keys, dedup keys, and session keys are correctly tenant-prefixed via `buildDedupKey(brandId, eventId)` and `packages/tenant-context`. The collector's R2/R3 gate derives the authoritative brand_id server-side from `install_token` via a SECURITY DEFINER function, quarantining any browser-spoofed brand claim. Brand switching is DB-membership verified (`switchBrandContext`). However, four concrete gaps exist: (1) The Razorpay webhook replay-protection Redis key (`razorpay:dedup:<event_id>`) is NOT brand-prefixed, creating a cross-brand dedup collision vector that can suppress a legitimate event for brand B if brand A receives the same Razorpay event_id (a low-probability but real noisy-neighbor/tenant confusion risk, not a data leak). (2) The `audit_log` table has RLS explicitly disabled; app-layer isolation relies solely on `WHERE brand_id = $1` clauses in the `DbAuditWriter`, without any database-level enforcement backstop. (3) The `rateLimitKey` helper defined in `packages/tenant-context` (the sanctioned per-brand rate-limit builder) is imported **only** in isolation-fuzz tests — never in any production app code. All live rate-limiting uses user/IP keys only (`loginIpKey`, `loginFailKeySync`, `registerIpKey`), meaning there is no per-brand API quota enforcement preventing a single brand from exhausting shared collector/BFF capacity. (4) Brand offboarding/crypto-shred is represented only as a schema column (`brand_keyring.is_active`) and a DPDP concept in comments; no application code implements DEK deactivation or data purge across the brand's rows.

**Severity counts:** Critical: 0 | High: 1 | Medium: 2 | Low: 1

---

## Finding MT-1

**Title:** Razorpay webhook Redis dedup key is not brand-prefixed — cross-brand collision possible  
**Severity:** High  
**Priority:** P1  
**Category:** Cache / dedup key isolation  
**evidenceRef:** `apps/core/src/modules/connector/sources/payment/razorpay/infrastructure/RedisDedupAdapter.ts:16-26`  

**Impact:** The key is `razorpay:dedup:<event_id>` with no brand discriminator. If two brands happen to share the same Razorpay event_id (e.g. through Razorpay reusing IDs across accounts, or through a test/sandbox collision), brand A's Redis dedup claim will cause brand B's identical event_id to be rejected as a duplicate (409) and never written to the Bronze ledger. This is a noisy-neighbor tenant confusion issue: one brand's legitimate webhook is silently dropped. It is NOT a data-leak but it IS a tenant-isolation failure because one tenant's state corrupts another's event pipeline.

**Root Cause:** The `RedisDedupAdapter` in the Razorpay webhook path uses `private readonly keyPrefix = 'razorpay:dedup:';` and builds `razorpay:dedup:<eventId>` without a `brandId` segment. Contrast this with the stream-worker's correct `DedupPolicy.ts:24` which uses `dedup:${brandId}:${eventId}`.

**Fix:** Change the key to `razorpay:dedup:<brandId>:<event_id>`. The `brandId` is resolved server-side at Step 3 of the handler (from the SECURITY DEFINER fn) and is available before the dedup check at line 267. The `isDuplicate` method signature should accept `brandId` as a parameter:  
```typescript
// In RedisDedupAdapter.ts
private buildKey(brandId: string, eventId: string): string {
  return `razorpay:dedup:${brandId}:${eventId}`;
}
async isDuplicate(brandId: string, eventId: string): Promise<boolean> { ... }
```
Call site: `dedupAdapter.isDuplicate(brandId, eventId)` after `connectorRow.brand_id` is available.

**Tenant Impact:** Multi-tenant blast radius. Any two brands sharing a Razorpay event_id will cause the second brand's event to be suppressed for 600 seconds.

**Detection:** Surfaces as spurious 409 responses on the `/api/v1/webhooks/razorpay` route with `outcome: 'duplicate'` for legitimate events. No existing alert covers this because the metric is only a counter without brand discrimination.

---

## Finding MT-2

**Title:** `audit_log` table has RLS disabled; isolation relies solely on application-layer `WHERE brand_id = $1`  
**Severity:** Medium  
**Priority:** P2  
**Category:** Database RLS / application-layer isolation gap  
**evidenceRef:** `db/migrations/0001_init.sql:105-109`, `packages/audit/src/index.ts:115-118`  

**Impact:** Any future caller that queries `audit_log` without the mandatory `WHERE brand_id = $1` will silently return all tenants' audit rows. The application package comment at `packages/audit/src/index.ts:115` acknowledges this: *"isolation is enforced by the mandatory WHERE brand_id filter in every SELECT."* There is no database backstop. A code path that issues `SELECT * FROM audit_log ORDER BY id DESC LIMIT 50` without a brand filter (e.g. a new diagnostic endpoint, a misconfigured admin query, a future join) would cross-brand expose the full audit log.

**Root Cause:** The migration comment at line 105 explains the intent: *"the audit log must record cross-brand system events."* However, enabling RLS in PERMISSIVE mode for app reads does not preclude a separate policy for admin/system writes. The disable is a broad architectural choice that creates a permanently NN-6-rule-reliant gap.

**Fix:** Enable RLS on `audit_log` with a PERMISSIVE policy `FOR SELECT TO brain_app USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid)` while adding a separate permissive `FOR INSERT` policy without a brand predicate (since INSERTs always supply brand_id explicitly). System jobs that need cross-brand reads should use the superuser or a SECURITY DEFINER function, as is the pattern for other cross-brand enumeration needs (migrations 0019, 0023). This eliminates the reliance on application-layer discipline alone for the audit SoR.

**Tenant Impact:** Multi-tenant blast radius. A single missing WHERE clause on any SELECT from audit_log exposes all tenants' audit history.

**Detection:** Only detectable via code review; no runtime metric or log covers this gap today.

---

## Finding MT-3

**Title:** `packages/tenant-context` `rateLimitKey` is defined but never wired — no per-brand API rate limiting enforced in production  
**Severity:** Medium  
**Priority:** P2  
**Category:** Per-tenant rate limiting / noisy-neighbor  
**evidenceRef:** `packages/tenant-context/src/index.ts:92-99`, `apps/core/src/modules/workspace-access/internal/infrastructure/rate-limiter.ts:63-81`, search result showing zero production imports of `@brain/tenant-context` in `apps/`  

**Impact:** The BFF and collector routes apply only user/IP-level rate limits (`loginIpKey`, `loginFailKeySync`, `registerIpKey`). There is no per-brand quota on analytics reads, AI (`/api/v1/ask`) calls, or ingest throughput. A single high-traffic brand can saturate the shared Postgres pool, Redis, or StarRocks connection limit, creating noisy-neighbor degradation for all other tenants. The architecture plan (doc 04 §AI gateway, §2226) explicitly specifies `ratelimit:{brand_id}:{window}` Redis keys; the infrastructure is built (`rateLimitKey` exported and tested in `tools/isolation-fuzz/src/redis.test.ts:131-138`) but never wired into production middleware.

**Root Cause:** The `rateLimitKey` helper was built as part of the tenant-context package (probably in parallel with the rate-limiter infrastructure) but the BFF and analytics routes were never updated to call it. The auth rate limiter (`rate-limiter.ts`) only addresses auth abuse (login floods), not ingest or read abuse by a legitimate but over-active tenant.

**Fix:** Add per-brand middleware in `bff.routes.ts` for at minimum: (a) `GET /api/v1/ask` — AI NLQ calls are expensive and unbounded; wire `rateLimitKey({ brandId: auth.brandId, resource: 'nlq', windowBucket })` against the existing `RateLimiter`. (b) Consider a per-brand ingest quota guard in the collector's accept path. The `rateLimitKey` utility already exists and is correct; the only work is plumbing it into the relevant preHandlers.

**Tenant Impact:** Multi-tenant blast radius — one brand can degrade service for all others via resource exhaustion.

**Detection:** Surfaced only when a brand generates enough traffic to cause Postgres/Redis saturation (p99 latency spike on analytics routes). No per-brand quota metric exists today.

---

## Finding MT-4

**Title:** Brand offboarding/crypto-shred has no implementation — `brand_keyring.is_active` column exists but is never set to `false` by any code  
**Severity:** Low  
**Priority:** P3  
**Category:** Offboarding / deletion safety  
**evidenceRef:** `db/migrations/0001_init.sql:133-134` (`is_active BOOLEAN NOT NULL DEFAULT TRUE`), no TypeScript file in `apps/` references `brand_keyring` or `is_active` for DEK deactivation  

**Impact:** If a brand is removed (e.g. for non-payment, breach, DPDP erasure request), there is no code to: (a) flip `brand_keyring.is_active = false` (crypto-shred — the KMS-wrapped DEK reference becomes inert), (b) delete or tombstone the brand's rows across the 30+ RLS-protected tables, or (c) notify downstream systems. The `customer.lifecycle_state = 'erased'` enum value exists in the schema (`db/migrations/0017_identity_graph.sql:39`) but no service transitions it. This means brand data persists indefinitely; there is no "erase this tenant" workflow. For DPDP §13 compliance, individual subject erasure is handled via the `consent_tombstone` + `RequestCapiDeletionUseCase` path, but full brand deletion is absent.

**Root Cause:** Billing module is a stub (`apps/core/src/modules/billing/index.ts` is a placeholder). Without an implemented billing lifecycle, the brand deletion/suspension workflow has no trigger. This is an expected M1 gap but must be tracked as a pre-prod P3.

**Fix:** Before GA, implement a `BrandOffboardingJob` that: (1) marks `brand_keyring.is_active = false` (prevents future decryption), (2) transitions `customer.lifecycle_state` to `erased` for all brand customers, (3) issues CAPI deletion requests for all subjects. Document which tables are NOT purged (audit_log rows are immutable by design). Add a migration-time-enforced runbook link to the `brand_keyring.is_active` column comment.

**Tenant Impact:** Single-tenant — affects only the offboarded brand's data persistence, not cross-brand leakage.

**Detection:** Only discoverable via billing lifecycle audit or a DPDP compliance review. No automated signal exists.

---

## Positive Controls Verified

The following isolation controls were confirmed to be correctly implemented:

1. **RLS with FORCE on all brand-scoped tables** — All 36 migrations apply `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` with the two-arg `current_setting('app.current_brand_id', TRUE)::uuid` pattern. Migration-time DO-block assertions catch any one-arg regressions at deploy time (`db/migrations/0001_init.sql:182-199`).

2. **Non-owner app role without BYPASSRLS** — `brain_app` role is created with NOLOGIN and an active migration-time assertion verifies `rolbypassrls = false` (`db/migrations/0001_init.sql:44-53`).

3. **GUC transaction-scoping via `withBrandTxn`** — `packages/metric-engine/src/deps.ts:39-60` wraps every analytics read in BEGIN→GUC(is_local=true)→fn→COMMIT, preventing GUC bleed across pool connections.

4. **StarRocks seam-level brand predicate** — `packages/metric-engine/src/silver-deps.ts:114-130` injects `AND brand_id = ?` at the seam, making a per-call forget impossible. A mutation-negative-control test (`__unsafeDisableBrandPredicate`) proves the predicate is non-inert.

5. **Collector R2 tenant-key derivation** — `apps/stream-worker/src/application/ProcessEventUseCase.ts:121-156` derives brand_id from `install_token` via a SECURITY DEFINER fn and quarantines any mismatch. Browser-spoofed `brand_id` is never trusted.

6. **Redis dedup key is brand-prefixed (collector lane)** — `apps/stream-worker/src/domain/bronze/DedupPolicy.ts:24`: `dedup:${brandId}:${eventId}`. (Razorpay lane is the exception — see MT-1.)

7. **Brand switching verified against DB membership** — `apps/core/src/modules/workspace-access/internal/application/auth.service.ts:775-778` performs a DB membership check before issuing a new JWT; `workspaceId` always comes from the JWT, never the body (MA-02).

8. **SECURITY DEFINER functions are minimal scope + pinned search_path** — Migrations 0019, 0023, 0026, 0028 create cross-tenant enumeration functions with `SET search_path = public` and migration-time assertions verifying `prosecdef=true` and EXECUTE grants.

9. **`audit_log` SELECT is scoped** — `packages/audit/src/index.ts:192`: every `getRecentEntries` call includes `WHERE brand_id = $1` (NN-6 rule). The gap (MT-2) is the absence of a DB-level backstop.

10. **`collector_spool` intentionally has no RLS** — correctly documented: brand_id is not known at accept time; isolation occurs downstream after brand derivation from install_token.
