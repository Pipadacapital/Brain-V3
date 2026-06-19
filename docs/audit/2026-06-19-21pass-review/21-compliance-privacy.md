# Pass 21: Compliance & Privacy Audit (compliance-privacy)

**Date:** 2026-06-19
**Auditor:** Principal-Level Independent Reviewer
**Board:** Compliance & Privacy
**Scope:** GDPR/DPDP right-to-erasure/portability, CCPA, data residency, consent management, PII data-flow mapping, retention enforcement, audit-trail completeness, breach-notification readiness.

---

## Board Verdict

Brain's consent-capture and suppression machinery is its compliance standout: the fail-closed `can_contact()` engine, append-only consent SoR, identity-core hashed-identifier architecture, and per-brand salt all implement the DPDP §13.4 lawful-basis framework correctly. However, the single most consequential gap — the erasure (right-to-be-forgotten) sequence prescribed in COMPLIANCE.md Controls §Erasure and doc 08 §13 — has **zero implementation**: no `pii_erasure_log` table migration, no crypto-shred service, no erasure API endpoint, no Iceberg erasure-aware compaction job, and no surrogate_brain_id projection exist in the shipped code. This transforms a documented DPDP/PDPL compliance control into a design-intent-only artefact. Separately, the `consent/check` probe endpoint silently rejects the `advertising` purpose (making CAPI passback consent-gate probing impossible via the operator UI), the WORM audit-checkpoint S3 write job is referenced in COMPLIANCE.md but unimplemented in any CI/Argo job, and `contact_pii.pii_value` stores raw plaintext PII in dev with no migration guard preventing this column from being populated in prod environments that don't satisfy the `NODE_ENV=production` branch. These four findings represent High-to-Critical gaps between the documented compliance posture and the deployed code.

**Severity counts:** Critical: 1 | High: 2 | Medium: 1 | Low: 0

---

## Finding CP-1

**Title:** Right-to-Erasure (DPDP §13 / COMPLIANCE.md) Has Zero Implementation — No Table, No Service, No API

**Severity:** Critical
**Priority:** P0
**Category:** Right-to-Erasure / Crypto-Shred

**evidenceRef:**
- `db/migrations/` — no file creates `pii_erasure_log`. Confirmed via exhaustive grep: `grep -rn "pii_erasure_log" db/migrations/` returns zero results.
- `apps/core/src/modules/identity/index.ts:7` — the entire identity module internal is `.gitkeep`; no erasure service exists.
- `apps/core/src/modules/identity/internal/.gitkeep` — zero implementation files beyond the stub.
- `COMPLIANCE.md:110` — specifies: "(1) destroy key material via brand_keyring (KMS key deletion = crypto-shred of contact_pii ciphertext); (2) tombstone customer node → opaque surrogate_brain_id; (3) re-project marts onto surrogate; (4) Bronze stays immutable but non-identifying (erasure-aware compaction); (5) CAPI deletion signal. pii_erasure_log records the full sequence."
- `docs/requirements/08_Brain_Data_Model_and_Database_Schema.md:248` — defines `pii_erasure_log(erasure_id uuid PK, brand_id, brain_id, surrogate_brain_id uuid, …)` as the control evidence table.
- `db/migrations/0001_init.sql:133` — `brand_keyring.is_active BOOLEAN` exists, but no `erased_at` column, no KMS delete path, no migration alters this table for erasure.
- `db/migrations/0017_identity_graph.sql:39` — `customer.lifecycle_state CHECK (lifecycle_state IN ('anonymous','active','merged','split','erased'))` has the `erased` state, but no application code sets it.

**Impact:** A DPDP 2023 / UAE PDPL erasure request cannot be fulfilled. If a data subject or a regulatory authority demands erasure, Brain has no mechanism to (a) destroy the KMS key material for `contact_pii`, (b) tombstone the identity graph node with a surrogate, (c) reproject downstream marts, (d) trigger erasure-aware Iceberg compaction, or (e) record a `pii_erasure_log` row. The documented 5-step erasure sequence exists only in design documents. Any regulatory audit or DPDP enforcement action would find no evidence of a functional erasure capability despite the written control claim.

**Root Cause:** The erasure sequence was fully architected and documented in Q2 2026 but assigned to a future implementation milestone. The identity module internal is a `.gitkeep` stub; the erasure service was scoped as post-M1. No migration was ever created for `pii_erasure_log`, and the COMPLIANCE.md control evidence table is never written.

**Fix:**
1. Create migration `0037_pii_erasure_log.sql`: table as per doc 08 §5.5, with RLS ENABLE+FORCE, SELECT+INSERT for `brain_app`, and add `erased_at TIMESTAMPTZ NULL` to `brand_keyring`.
2. Implement `ErasureUseCase` in `apps/core/src/modules/identity/internal/`: (a) validate brand+brain_id, (b) mark `brand_keyring.is_active=false` and `erased_at=NOW()` (triggers crypto-shred), (c) set `customer.lifecycle_state='erased'`, (d) deactivate all `identity_link` rows (`is_active=false`), (e) insert `pii_erasure_log` row with surrogate, (f) emit CAPI deletion signal.
3. Expose `POST /api/v1/identity/erase` (Owner/Brand Admin only), guarded by `validateSessionPreHandler` and RBAC check.
4. Register an Argo job for erasure-aware Iceberg compaction (rewrite affected partitions).
5. Add erasure integration test: post-erasure query on original `brain_id` must return no PII; `vault_shredded=true` in `pii_erasure_log`.

**Tenant Impact:** All tenants. Any brand receiving a DPDP/PDPL erasure request has no mechanism to comply, exposing Brain and the brand-controller to regulatory enforcement risk simultaneously.

**Detection:** No alert exists. Surfaces only when a data subject requests erasure, a regulator inquires, or an internal compliance audit discovers the gap. The CI gate referenced in COMPLIANCE.md ("Erasure integration test: post-erasure PII query returns nothing") does not exist.

---

## Finding CP-2

**Title:** Audit-Log WORM S3 Checkpoint Job Is Declared in COMPLIANCE.md But Never Implemented

**Severity:** High
**Priority:** P1
**Category:** Audit-Trail Completeness / WORM Integrity

**evidenceRef:**
- `COMPLIANCE.md:131` — "Hourly checkpoint: every hour, the current chain tip hash is written to S3 Object Lock (minimum retention = workspace-life legal requirement). This creates an external, immutable reference that cannot be altered even with database superuser access."
- `COMPLIANCE.md:115` — Control row: "Hourly checkpoint hash → S3 Object Lock (WORM, minimum 7-year retention)" as the enforcement mechanism.
- `infra/terraform/modules/s3-audit/main.tf:41` — S3 bucket with `object_lock_enabled = true` and 7-year COMPLIANCE mode retention exists.
- `infra/terraform/modules/s3-audit/main.tf:4` — bucket comment: "This bucket holds hourly audit-log hash checkpoints (the WORM anchor)."
- No file in `.github/workflows/`, `infra/argocd/`, `apps/core/src/`, or `apps/stream-worker/src/` implements a job that reads `audit_log` chain tip and writes to S3. Confirmed by: `grep -rn "checkpoint.*S3\|audit.*worm\|worm.*checkpoint\|hourly.*checkpoint" apps/ infra/ .github/` — zero application/workflow results.
- `packages/audit/src/index.ts:120-175` — `DbAuditWriter.append()` inserts rows with `entry_hash` but has no S3 write path.

**Impact:** The WORM anchor — the only external tamper-evidence mechanism — is not written. An attacker or insider with Postgres superuser access (`brain` role per MEMORY: dev-db-superuser-masks-rls) could alter audit rows without any external checkpoint catching the chain break. The quarterly chain-walk verification job also referenced in COMPLIANCE.md is therefore walking only an in-database chain with no independent external anchor. For regulatory purposes (DPDP §7, SOC2 CC7 readiness), the audit trail cannot be certified as tamper-evident without the S3 WORM anchor.

**Root Cause:** The WORM checkpoint is an infrastructure-level job that was planned at architecture time but not implemented. The S3 bucket was provisioned, but no Argo CronJob, Lambda, or scheduled workflow was ever created to write to it.

**Fix:**
1. Implement an hourly Argo CronJob (or AWS Lambda scheduled) that: (a) queries `SELECT brand_id, MAX(id), entry_hash FROM audit_log GROUP BY brand_id ORDER BY MAX(id) DESC LIMIT 1 PER brand` (the chain tip per brand); (b) writes a JSON object `{brand_id, tip_id, entry_hash, checkpoint_at}` to the WORM S3 bucket with a key like `audit-checkpoints/{YYYY}/{MM}/{DD}/{HH}/{brand_id}.json`; (c) logs success/failure as a metric.
2. Register the CronJob manifest in `infra/argocd/`.
3. Add a CI gate that asserts the WORM bucket has received a write within the last 90 minutes (staging smoke test).

**Tenant Impact:** All tenants. Without the WORM anchor, audit log tamper-evidence is database-only, which is insufficient for regulatory certification.

**Detection:** No alert. Would only surface if the quarterly chain-walk job existed and failed to find a matching S3 checkpoint — but that job is also unimplemented. Invisible in production.

---

## Finding CP-3

**Title:** `consent/check` Probe Endpoint Silently Rejects `advertising` Purpose — CAPI Gate Is Unauditable via API

**Severity:** High
**Priority:** P1
**Category:** Consent Management / Compliance Surface

**evidenceRef:**
- `apps/core/src/modules/notification/internal/compliance/consent.routes.ts:236-238` — purpose validation: `body['purpose'] === 'transactional' || body['purpose'] === 'marketing' ? (body['purpose'] as ContactPurpose) : null`. The `advertising` purpose is never matched; `null` triggers a 422 rejection.
- `apps/core/src/modules/notification/internal/compliance/contact-types.ts:32` — `ContactPurpose` type includes `'advertising'`.
- `apps/core/src/modules/notification/internal/compliance/can-contact.engine.ts:163-165` — engine has an explicit `advertising` fast-path after consent check.
- `apps/core/src/modules/notification/internal/compliance/contact-types.ts:93-95` — `gatingCategoryForPurpose('advertising')` correctly returns `'advertising'` category.
- `apps/core/src/modules/notification/tests/can-contact.advertising.test.ts:1-130` — unit tests confirm the engine handles `advertising` purpose correctly.
- The `capi-passback.service.ts` calls `can_contact()` internally via the engine (not via this HTTP route), so the actual passback gate works. But the **probe endpoint** — the operator-facing compliance surface — cannot be used to verify the advertising consent gate.

**Impact:** An operator using `/api/v1/consent/check` to audit whether CAPI passback (advertising purpose) is gated correctly receives a 422 Validation Error instead of the gate decision. This means: (a) the consent compliance surface (`/settings/consent`) cannot show advertising gate activity via the probe; (b) operators cannot manually verify the CAPI consent gate before enabling passback; (c) any compliance audit that asks "demonstrate that advertising consent checks work" cannot be performed through the documented API. The structural gate in `CapiPassbackService` still works, but its observability path is broken.

**Root Cause:** The `purpose` field validator in `consent.routes.ts` was written to match only `transactional` and `marketing` (the Phase 1 channels). The `advertising` purpose was added later (Phase 6 / feat-capi-conversion-feedback) but the consent routes were not updated to accept it.

**Fix:**
In `apps/core/src/modules/notification/internal/compliance/consent.routes.ts`, update line 236:
```typescript
const purpose =
  body['purpose'] === 'transactional' || body['purpose'] === 'marketing' || body['purpose'] === 'advertising'
    ? (body['purpose'] as ContactPurpose)
    : null;
```
Add `advertising` to the `ConsentRoutesDeps`-level docs and add a test case in `consent.routes.test.ts` verifying `advertising` purpose returns a gate decision rather than 422.

**Tenant Impact:** All brands using CAPI passback (Phase 6). Operators cannot probe the advertising consent gate via the compliance surface.

**Detection:** Returns HTTP 422 to a caller that supplies `purpose: 'advertising'`. No alert; surfaces only when an operator tries to probe the advertising consent gate manually.

---

## Finding CP-4

**Title:** `contact_pii.pii_value` Stores Raw Plaintext PII With No Migration Guard Against Prod Population

**Severity:** Medium
**Priority:** P2
**Category:** PII Minimization / Encryption at Rest

**evidenceRef:**
- `db/migrations/0017_identity_graph.sql:228` — column definition: `pii_value TEXT NULL, -- dev plaintext stand-in (prod: use pii_ciphertext)`.
- `db/migrations/0017_identity_graph.sql:230` — `pii_ciphertext` column is NOT defined in the migration — only `pii_value TEXT NULL` and `identifier_hash TEXT`.
- `apps/stream-worker/src/infrastructure/pg/IdentityRepository.ts:319-322` — production code path: `INSERT INTO contact_pii (brand_id, brain_id, pii_type, pii_value, identifier_hash) VALUES ($1, $2, $3, $4, $5)` where `$4 = pii.raw_value` — raw email/phone directly.
- `packages/identity-core/src/index.ts:286-287` — comment: "The real PII lives in contact_pii (KMS-encrypted in prod, send_service role only)." But the actual DB column is `pii_value TEXT`, not `pii_ciphertext BYTEA`.
- `COMPLIANCE.md:111` — control claim: "contact_pii RLS additionally requires app.role='send_service' — no other role may read plaintext PII". The RLS is correct, but "plaintext" is the actual storage format even outside dev.
- `docs/requirements/08_Brain_Data_Model_and_Database_Schema.md:85` — claims `contact_pii` uses `Postgres (KMS)` encryption; the migration column is `TEXT NULL` (plaintext), not `BYTEA` (ciphertext).

**Impact:** In any deployment (including staging and any production environment where `NODE_ENV` is not exactly `'production'`), raw email addresses and phone numbers are stored in `contact_pii.pii_value` as unencrypted plaintext text. The `pii_ciphertext BYTEA` column promised by doc 08 does not exist in the schema. The RLS `send_service` gate limits reads, but plaintext PII at rest contradicts the KMS-at-rest encryption claim in COMPLIANCE.md and doc 08. A DB-level compromise (e.g., RDS snapshot exfiltration, log query capture, or a postgres superuser connection — as noted in MEMORY: dev-db-superuser-masks-rls) exposes raw PII without requiring key-decryption.

**Root Cause:** The KMS-encrypted `pii_ciphertext BYTEA` path was deferred. The schema was designed with the plaintext column as a dev stand-in, but the application code always writes to `pii_value` regardless of environment. No guard prevents this in prod. The `pii_ciphertext` column was never added to the migration.

**Fix:**
1. Add migration `0037+_contact_pii_encryption.sql` (or fold into `0037_pii_erasure_log.sql`): `ALTER TABLE contact_pii ADD COLUMN IF NOT EXISTS pii_ciphertext BYTEA NULL`.
2. Implement a `ContactPiiEncryptionService` that wraps KMS `Encrypt` using the brand's `wrapped_dek` from `brand_keyring` before writing to `pii_ciphertext`.
3. Update `IdentityRepository.writeOutcome()` to: (a) in prod (`NODE_ENV === 'production'`), encrypt via KMS and write to `pii_ciphertext`, leave `pii_value` NULL; (b) in dev, write to `pii_value` as today.
4. Update `contact_pii` reads in `MatchPiiPort` to decrypt `pii_ciphertext` in prod.
5. Add a CI migration assertion that `pii_value IS NULL` for all rows when `NODE_ENV === 'production'`.

**Tenant Impact:** All tenants. Any brand that has had identity resolution run (email/phone collected) has those identifiers in plaintext in `contact_pii`. The elevated RLS policy limits exposure to `send_service`-role queries, which reduces but does not eliminate the risk.

**Detection:** Invisible at runtime. Would surface via a DB-level audit query (`SELECT COUNT(*) FROM contact_pii WHERE pii_value IS NOT NULL`), a penetration test, or a data breach investigation. No existing alert covers this.
