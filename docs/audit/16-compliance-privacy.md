# PASS 21 — Compliance & Privacy Audit (Board: compliance-privacy)

**Auditor:** Independent principal reviewer (Security/Compliance lane).
**Scope:** GDPR/DPDP/CCPA right-to-access, right-to-erasure (incl. identity-graph propagation), portability/export, residency (`region_code`), consent (D13 `consent_record`/`consent_tombstone` + `can_contact` I-ST05), PII data-flow, retention, audit-trail completeness, breach-notification readiness.
**Reference truth:** `.engineering-os/knowledge-base/COMPLIANCE.md`, `docs/data-collection-platform/13-security-privacy-and-roadmap.md`, migrations 0001/0017/0033/0034.

---

## Executive summary

The **consent capture + suppression spine is genuinely strong and production-grade**: `consent_record`/`consent_tombstone` (0033) are append-only-by-GRANT, RLS ENABLE+FORCE, fail-closed, idempotent; `can_contact()` (notification/internal/compliance/can-contact.engine.ts) is a real default-closed gate with no unknown→allow path; the CAPI retroactive-deletion request path (0034 + RequestCapiDeletionUseCase) records every block/deletion as immutable audit. These satisfy the **consent + outbound-suppression** half of DPDP.

The **erasure / right-to-be-forgotten / right-to-access / portability half does not exist in code.** COMPLIANCE.md §Controls "Erasure — crypto-shred" asserts an enforced erasure pipeline (`pii_erasure_log`, crypto-shred via `brand_keyring`, `surrogate_brain_id` re-projection, an erasure integration test as evidence). None of it is built. The platform's own doc 13 honestly marks every one of these as **Missing** and warns right-to-erasure "cannot be claimed end-to-end conformant" — but COMPLIANCE.md (the ratified Canon, the VETO surface) presents it as enforced. That gap between the ratified compliance Canon and the auditable code is the central finding of this pass.

---

## Findings

### F1 — No erasure pipeline exists; `pii_erasure_log`, crypto-shred orchestrator, and `surrogate_brain_id` are all absent
**Severity: Critical | Category: Right-to-erasure / DPDP §12 | Priority: P0**

**Evidence:**
- COMPLIANCE.md:110 (Controls, "Erasure — crypto-shred") claims an enforced sequence: "(1) destroy key material via `brand_keyring` … (2) tombstone `customer` node → opaque `surrogate_brain_id`; (3) re-project marts … (5) CAPI deletion signal. `pii_erasure_log` records the full sequence" with evidence "Erasure integration test … `vault_shredded=true` in `pii_erasure_log`."
- No `pii_erasure_log` table exists: `grep -rl "CREATE TABLE.*pii_erasure_log" db/migrations` → 0 results (37 migrations).
- No `surrogate_brain_id` column or re-point logic exists: `grep -rn surrogate_brain_id` → only unrelated `provenance_id`/`result_id` comments (0035/0036).
- No erasure consumer / orchestrator: `grep -rn "privacy.erasure|erasure.requested|ErasureConsumer|erasure.orchestrat"` → 0 results.
- The `identity_audit.action` CHECK permits `'erase'` (0017:256) but `'erase'` is never written by any production code path (`grep -rn "'erase'"` in apps/packages excluding tests → 0).
- The `brand_keyring.is_active` crypto-shred toggle (0001:133-134) is **never set to false** anywhere (`grep "SET is_active|UPDATE brand_keyring"` → 0). It is dead substrate.
- doc 13:72,73,182,188 independently confirm all of the above are **Missing**.

**Impact (production):** A DPDP/PDPL/GDPR data-subject erasure request cannot be fulfilled. There is no code that destroys a subject's PII, re-points ledgers to a surrogate, or records the erasure. The brand-controller is contractually told (DPA) Brain supports erasure; Brain cannot execute it. Regulatory non-compliance on a P0 statutory right.
**Root cause:** Erasure work was scoped to a later phase (doc 13 Phase ordering) but COMPLIANCE.md was ratified asserting it as enforced rather than deferred.
**Recommended fix:** Either (a) build the `pii_erasure_log` table + a `stream-worker` erasure consumer (destroy/disable DEK → hard-delete `contact_pii` plaintext → tombstone identity → CAPI deletion → write `pii_erasure_log`), or (b) correct COMPLIANCE.md to mark Erasure as DEFERRED with a tracked waiver and document the limitation in the DPA (doc 13:77,188 recommends exactly this). Do not ship with the Canon overclaiming an unbuilt statutory control.
**Tenant Impact:** Multi-tenant — every brand-controller is exposed; each is the DPDP controller relying on Brain (processor) for the erasure tool.
**Detection:** Would surface as a failed/blocked data-subject request or a regulator inquiry; no alert exists because the "Erasure integration test" cited as evidence does not exist.

---

### F2 — `contact_pii` vault stores plaintext only; no `pii_ciphertext` column, no DELETE grant — crypto-shred and hard-delete of PII are both impossible
**Severity: Critical | Category: PII minimization / encryption-at-rest / erasure | Priority: P0**

**Evidence:**
- `contact_pii` (0017:223-247) has columns `pii_value TEXT NULL` (plaintext) and `identifier_hash`. The comment says "prod: pii_ciphertext bytea" but **no `pii_ciphertext` column is ever defined** (`grep -rn pii_ciphertext db/migrations` → only the two comment lines in 0017, no column).
- COMPLIANCE.md:22 asserts "raw PII only in the KMS-encrypted vault"; COMPLIANCE.md:116 asserts "`contact_pii.pii_ciphertext` holds AES-256-GCM ciphertext." The column does not exist; PII is stored as cleartext `pii_value`.
- Grants are `SELECT, INSERT` only (0017:247) — **no DELETE**. The app role cannot hard-delete a subject's PII row. The crypto-shred fallback (destroy DEK) also cannot work because the data isn't encrypted with a DEK at all.
- doc 13:103 lists "prod `pii_ciphertext` KMS path" as net-new/unbuilt.

**Impact (production):** Raw email/phone/name sit in `contact_pii.pii_value` as plaintext, protected only by RLS (and an `app.role='send_service'` GUC). A DB-snapshot leak, backup exfiltration, or a read by any path that can set the GUC exposes cleartext PII for all subjects of a brand. And because there is no DELETE grant and no DEK-encryption, neither hard-delete nor crypto-shred can remove a subject's PII — compounding F1.
**Root cause:** The vault was built as a dev plaintext stand-in; the prod KMS-ciphertext column was deferred and never added; COMPLIANCE.md describes the intended end-state as the current state.
**Recommended fix:** Add `pii_ciphertext bytea` + KMS envelope-encrypt on write; drop the plaintext `pii_value` in prod; grant a scoped DELETE (or a `SECURITY DEFINER` erasure fn) so the erasure path can hard-delete. Until then, mark COMPLIANCE.md:22,116 as aspirational/deferred.
**Tenant Impact:** Multi-tenant — every brand's contact PII is cleartext-at-rest.
**Detection:** A snapshot/backup review or a SAST/data-classification scan of the column; no current alert.

---

### F3 — Right-to-access (DSAR) and data portability/export are not implemented at all
**Severity: High | Category: Right-to-access / portability (DPDP §11, GDPR Art.15/20) | Priority: P0**

**Evidence:**
- No DSAR/access surface: `grep -rln "DSAR|data.subject.request|right.to.access|subjectAccess"` apps/packages → 0.
- No export/portability surface: `grep -rln "export.*bundle|exportSubject|portability|signed.*bundle|machine.readable"` → 0.
- COMPLIANCE.md §compliance-engine reference and doc 13 describe "Export = signed machine-readable bundle"; no such code or route exists. The only `fastify.delete` in bff.routes.ts:427 is unrelated to subject deletion (it is a resource delete, not an erasure/DSAR endpoint).

**Impact (production):** A data subject (or controller acting for them) cannot obtain their data or a portable export. DPDP §11 right-to-access and the portability expectation are unmet. Manual fulfillment would require ad-hoc cross-table archaeology (no PII catalog-driven lookup exists).
**Root cause:** Feature not yet built; not flagged as a gap in the ratified Canon.
**Recommended fix:** Build a DSAR read path keyed on `subject_hash` walking the documented lineage (`contact_pii` → `identity_link`/`brain_id_alias` → ledgers → `consent_record`/`capi_passback_log`) producing a signed bundle; record the request in audit_log. Track in the Canon as deferred until shipped.
**Tenant Impact:** Multi-tenant — affects every brand's subjects.
**Detection:** First real access request; no alert/metric exists.

---

### F4 — Audit hash-chain has a read-then-insert race: concurrent appends fork the chain
**Severity: High | Category: Audit-trail integrity (tamper-evidence) | Priority: P1**

**Evidence:**
- `DbAuditWriter.append()` (packages/audit/src/index.ts:124-168) does `SELECT entry_hash … WHERE brand_id=$1 ORDER BY id DESC LIMIT 1` then a separate `INSERT`, with **no advisory lock, no SERIALIZABLE transaction, no FOR UPDATE** (`grep "pg_advisory|SERIALIZABLE|FOR UPDATE"` in audit → 0).
- Two concurrent appends for the same brand both read the same `prev_hash` and both insert rows claiming the same predecessor → the chain forks. COMPLIANCE.md:129-134 asserts the chain is the tamper-evidence ("`prev_hash` of row N equals `entry_hash` of row N−1"); a fork makes the quarterly chain-walk fail on legitimate concurrency, indistinguishable from tampering.

**Impact (production):** Under any concurrency (two operators, an operator + a system job for the same brand), the audit chain develops legitimate breaks. The tamper-evidence guarantee is undermined and the chain-verification job (itself unbuilt — see F5) would false-positive. Forensic/compliance value of the audit log is weakened.
**Root cause:** Per-brand chaining requires serialization of appends per brand; the implementation reads the tip without locking.
**Recommended fix:** Take `pg_advisory_xact_lock(hashtext('audit:'||brand_id))` (or a per-brand serialize) around the read+insert, or compute the chain in a trigger ordered by the serial `id`. Add a concurrency test.
**Tenant Impact:** Single-brand blast radius per fork, but affects every brand under concurrent writes.
**Detection:** The (currently nonexistent) chain-walk job; otherwise silent.

---

### F5 — Audit WORM anchor + chain-verification job claimed but not implemented
**Severity: High | Category: Audit-trail completeness | Priority: P1**

**Evidence:**
- COMPLIANCE.md:115,131,134 claim "Hourly checkpoint hash → S3 Object Lock (WORM)" and "a scheduled quarterly job walks the entire chain … Any break pages Security." `grep -rln "checkpoint|verifyChain|chain.walk|walkChain"` in apps/packages → no audit-chain checkpoint or verifier exists (matches are Shopify sync cursors). doc 13:103 lists "audit WORM anchor + chain-walk" as net-new/unbuilt.
- The s3-audit Terraform module and Object Lock infra exist (infra/terraform/modules/s3-audit), but nothing writes the hourly tip hash to it and nothing verifies the chain.

**Impact (production):** The audit log's external immutability anchor and its integrity-verification are absent. A DB-superuser tamper (the threat the WORM anchor is designed to detect) would go undetected; there is no evidence pipeline proving the chain is intact — the cited compliance evidence does not exist.
**Root cause:** Infra provisioned; the job that uses it deferred.
**Recommended fix:** Implement the hourly checkpoint writer (tip hash → S3 Object Lock) and the periodic chain-walk verifier with an alert on break; or mark these as deferred in the Canon.
**Tenant Impact:** Multi-tenant — all brands' audit integrity.
**Detection:** None today.

---

### F6 — Consent withdrawal/erasure does NOT propagate through the identity graph, ledgers, or Bronze
**Severity: High | Category: Right-to-erasure propagation / identity-graph | Priority: P1**

**Evidence:**
- A withdrawal/erasure (consent-write.ts withdraw(), or the ConsentSuppressorConsumer) writes only `consent_record` + `consent_tombstone`. It does **not** touch `brain_id_alias`, `identity_link`, `contact_pii`, `realized_revenue_ledger`, or `bronze_events`.
- The only production effect of an "erasure"-reason event beyond suppression is the CAPI deletion *request* (RequestCapiDeletionUseCase) — and in dev that is `would_delete_dev` (nothing sent). There is no propagation to the identity graph (`brain_id_alias`) or the ledgers.
- doc 13:77 explicitly notes old identifier hashes persist in `bronze_events` until an Iceberg-compaction step that does not exist; doc 13:70 says the erasure state-machine seam exists "but orchestration does not."

**Impact (production):** "Erasure" today = suppression of future contact + a recorded CAPI deletion intent. The subject's hashed identifiers and (per F2) plaintext PII remain in `contact_pii`, `identity_link`, `brain_id_alias`, and `bronze_events`. This is suppression, not erasure — it does not satisfy DPDP §12/GDPR Art.17 "forget the subject."
**Root cause:** Erasure orchestration (F1) unbuilt; the consent path only models consent state, not data destruction.
**Recommended fix:** As F1 — an erasure orchestrator that walks the lineage (identity graph + vault + ledgers-to-surrogate + Bronze). Until then, the DPA must describe the current capability as "outreach suppression + ad-platform deletion request," not erasure.
**Tenant Impact:** Multi-tenant.
**Detection:** A post-withdrawal query for the subject's identifiers still returns them; no test asserts otherwise.

---

### F7 — Data residency is single-region by default but has no application-layer region routing/enforcement; GCC path absent
**Severity: Medium | Category: Residency (DPDP/UAE-PDPL/KSA-PDPL) | Priority: P2**

**Evidence:**
- IaC defaults to `ap-south-1` on data stores (infra/terraform/bootstrap/main.tf:31, network:36, redpanda:41) — good for the India-only Phase-1 default.
- `region_code` exists on `organization`/`brand` (repositories.ts:492-646) and defaults to `'IN'` (`CURRENCY_TO_REGION` in onboarding.service.ts:132). But COMPLIANCE.md:104 claims "Brand-region mismatch is a hard error at onboarding" and "`organization.region` field gates which regional deployment the brand's data flows to." There is **no code that routes data by region or rejects a region mismatch** — `region_code` is a stored attribute only; there is a single ap-south-1 deployment.
- The Checkov region-tag IaC gate that COMPLIANCE.md:103 says "rejects any data-store resource without the approved region tag" is not present in `.checkov.yaml`'s check list (the configured checks are encryption/object-lock/IAM, not a region-tag policy; `policy/checkov/` contains only S3-prefix, IRSA-wildcard, object-lock checks).

**Impact (production):** For Phase-1 (India-only) the single ap-south-1 deployment is residency-correct by construction, so real exposure is low *now*. But the claimed enforcement mechanisms (region routing, mismatch hard-error, region-tag IaC gate) do not exist, so the moment GCC/UAE/KSA onboarding is attempted there is no structural guard preventing UAE/KSA data landing in ap-south-1 — a cross-border residency violation. The Canon overstates current enforcement.
**Root cause:** GCC region is a future phase; the enforcement seams were documented as present but only the stored attribute exists.
**Recommended fix:** Before any non-IN brand onboards: add the brand-region/deployment-region mismatch hard-error and a Checkov/OPA region-tag gate; until then correct COMPLIANCE.md:104 to mark GCC enforcement as deferred (it is gated per doc 13:185).
**Tenant Impact:** Multi-tenant once GCC activates; none while India-only.
**Detection:** Would surface at GCC onboarding; no gate currently fails.

---

### F8 — Breach-notification readiness is documentation-only; no runbook, no scoping tooling, no PII catalog asserted in CI
**Severity: Medium | Category: Breach notification (DPDP 72h / UAE-KSA PDPL) | Priority: P2**

**Evidence:**
- COMPLIANCE.md:24,32 commit to 72-hour breach notification to the controller/PDPC. `docs/runbooks/` and `docs/playbooks/` contain only `README.md` stubs — no breach/incident runbook exists (`find … | xargs grep -il breach` → only README).
- The compliance-engine skill calls for a "field-level PII catalog versioned in repo, asserted in CI" to make breach-scope a lookup; no such catalog file or CI assertion exists in the repo (no PII-catalog artifact found under packages/contracts or policy/).
- Breach scope today would be manual archaeology across `contact_pii`, `identity_link`, `bronze_events`, etc.

**Impact (production):** On a real breach, Brain cannot rapidly compute notification scope (which fields × stores × tenants) to meet the 72h window. The obligation is asserted in the Canon but unsupported operationally.
**Root cause:** Incident/breach operational tooling deferred; no PII catalog built.
**Recommended fix:** Author a breach runbook (detect → scope via lineage map → notify controllers within 72h → post-mortem) and commit a CI-asserted field-level PII catalog so scope is a lookup.
**Tenant Impact:** Multi-tenant.
**Detection:** A real incident; no proactive surface.

---

### F9 — `subject_hash` region inconsistency: consent/contact hashing omits `regionCode`, risking cross-path hash mismatch for non-IN brands
**Severity: Low | Category: Consent-match correctness | Priority: P3**

**Evidence:**
- `hashIdentifier(value, type, salt, regionCode='IN')` (identity-core/src/index.ts:219-229) — phone normalization (E.164) is region-dependent.
- can-contact.engine.ts:114 and consent-write.ts:72 call `hashIdentifier(recipient, idType, saltHex)` **without** `regionCode` (defaults 'IN'). RequestCapiDeletionUseCase.ts:127 passes `regionCode` explicitly (from the event). For a non-IN brand, the CAPI-deletion subject_hash (region-aware phone) could differ from the consent_record/suppression subject_hash (defaulted to IN) → a deletion or suppression keyed on a hash that never matches the stored consent hash.
- For email and for IN brands the default makes them equal, so impact is latent until non-IN phone subjects exist.

**Impact (production):** For a future non-IN (GCC) brand using phone identifiers, consent suppression and CAPI retroactive-deletion could silently target the wrong/no subject hash — a fail-to-suppress or fail-to-delete. Email-based and India phone flows are unaffected today.
**Root cause:** `regionCode` plumbed inconsistently across the consent/contact paths.
**Recommended fix:** Thread the brand's `region_code` into `hashIdentifier` on every consent/contact/suppression call so all paths agree; add a cross-path hash-equality test for a non-IN phone subject.
**Tenant Impact:** Single-brand (per non-IN brand) once GCC activates.
**Detection:** A non-IN phone withdrawal that fails to suppress; no current test.

---

## Verdict

Brain's **consent + outbound-suppression engine is real, fail-closed, append-only, and well-isolated** — the I-ST05 `can_contact()` gate, the 0033/0034 consent SoR, and the CAPI deletion-request audit are production-grade and faithfully implement the DPDP consent/communication half of the regime. However, the **erasure / access / portability half of the privacy regime is largely unbuilt**, and — critically — `COMPLIANCE.md` (the ratified VETO surface) **asserts as ENFORCED several controls that do not exist in code**: the crypto-shred erasure pipeline (`pii_erasure_log`, `surrogate_brain_id`, the keyring `is_active` shred), the prod `pii_ciphertext` KMS vault (PII is stored as plaintext with no DELETE grant), the audit WORM anchor + chain-walk verifier, DSAR/export, and region-routing enforcement. The platform's own doc 13 is admirably honest that these are Missing and gated to later phases; the defect is that the Canon overclaims them as live, and that "erasure" today is functionally suppression-plus-CAPI-deletion-request, not data destruction. **This pass cannot PASS as-is** (2 Critical + 4 High). The cleanest remediation is dual-track: (1) reconcile COMPLIANCE.md to mark Erasure/DSAR/export/WORM/region-routing as DEFERRED with tracked waivers and reflect the true capability in the DPA, and (2) prioritize the `pii_ciphertext` KMS vault + a real erasure orchestrator before onboarding any subject who can lawfully demand erasure.
