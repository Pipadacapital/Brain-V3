# COMPLIANCE — Brain regulatory regime

**Product:** Brain — AI-native commerce OS for DTC brands.
**Author:** Security Reviewer (Engineering OS Foundation phase).
**Date:** 2026-06-15.
**Status:** Ratified — supersedes any prior draft. Engineering Advisor must merge SOC2 TODO below into the tech-debt backlog.

> **Regime summary:** Brain operates as a DATA PROCESSOR (brands are controllers). Enforced now: DPDP 2023 (India) + UAE PDPL + KSA PDPL. Communication rules: TCCCPR/DLT + NCPR/DND (India). Tax obligations on Brain's own fee: GST (India), VAT (UAE), ZATCA (KSA). PCI: SAQ-A boundary — out of scope. SOC2: deferred to enterprise phase.

> See `engineering-os-blueprint/08-technical-governance.md §5` for the OS/Canon split.

---

## Applicable regime

### 1. Data protection (enforced now)

**DPDP 2023 (India) — Digital Personal Data Protection Act + Rules 2025**
Brain processes personal data of Indian data subjects on behalf of DTC brand controllers. Obligations running through to Brain as processor:
- Lawful basis / consent: the brand must hold valid consent before Brain may use personal data for marketing or personalization. Brain enforces consent categories at capture and suppresses non-consented paths.
- Purpose limitation: Brain uses data only for the purposes the brand collects it for (analytics, measurement, lifecycle decisions). No secondary use.
- Minimization: hashed identifiers in all operational tables; raw PII only in the KMS-encrypted vault (doc 08 §6 `contact_pii`).
- Retention and erasure: per-class retention matrix (§13 doc 08); erasure = crypto-shred (destroy key material + tombstone). See Controls table below.
- Breach notification: Brain notifies the brand-controller within 72 hours of awareness so the brand can meet the DPDP notification window to the Data Protection Board.
- Consent Manager compatibility: the consent model is designed to be compatible with the forthcoming Consent Manager framework (~Nov 2026) — `source` field in `consent_record` is forward-compatible with `source='consent_manager'` (doc 08 §5.5).
- DPA: Brain ships a Data Processing Agreement and a current sub-processor list. These are the brand's compliance instruments; Brain is not the DPA issuer.

> ASSUMPTION: The DPDP Rules 2025 that govern the Consent Manager regime are assumed to take effect ~Nov 2026. Until then, Brain's own consent capture (four-category model) is the enforced mechanism. If Rules finalize earlier or later, the consent-manager path's `source` field accommodates both.

**UAE PDPL (Personal Data Protection Law)**
Applies to GCC expansion (Phase 1 data residency is India; GCC = sequenced). UAE customer data must remain in the UAE when the GCC region is activated.
- Processor obligations mirror DPDP structure: lawful basis, purpose limitation, minimization, retention, breach notification (to the UAE PDPC within 72h), and cross-border transfer restrictions.
- GCC region activation is a compliance gate: all data stores (OLTP, Bronze/Iceberg, StarRocks, Redpanda) must be provisioned in the GCC region before the first UAE data subject is onboarded.

**KSA PDPL (Personal Data Protection Law)**
Same processor posture as UAE PDPL. ZATCA Arabic+English invoice requirement applies to Brain's own fee invoiced in KSA (§ Tax below).

> ASSUMPTION: UAE PDPL and KSA PDPL are enforced with the same processor controls as DPDP. Jurisdiction-specific divergences (e.g., exact breach-notification windows, data-residency exemptions) are tracked as open legal decisions (BRD §23.3) and will be incorporated when confirmed by legal counsel. This file will be updated at that point; the Engineering Advisor owns the update trigger.

---

### 2. Communication rules (enforced now — India)

**TCCCPR 2018 (Telecom Commercial Communications Customer Preference Regulations) + DLT (Distributed Ledger Technology) registry**
- Sender IDs (headers) and message templates must be pre-registered on the DLT platform under the brand's own entity before any commercial SMS/voice send.
- Brain never commingles sender registrations across brands.
- Only DLT-approved templates may be sent for marketing/transactional SMS. Template approval is a per-brand, per-purpose gate checked before every send.

**NCPR/DND (National Customer Preference Register / Do-Not-Disturb)**
- Two-layer suppression: Brain's own consent/opt-out list PLUS the NCPR/DND scrub for every number before any commercial send attempt.
- A number on the NCPR must never receive a commercial communication regardless of internal consent state.

**Permitted hours window — India (enforced at the queue, not the dialer/sender)**
- Commercial messages: 9:00 AM to 9:00 PM IST (Asia/Kolkata).
- Out-of-window contacts sit in a `pending_window` queue and flush when the window opens. Zero out-of-window sends is a structural guarantee, not a runtime hope.

> ASSUMPTION: Phase-1 communication channels are email (primary alert channel) and WhatsApp (Scheduled Delivery Channel — Morning Brief / Daily Summary). SMS/voice are Phase-3+ channels. The TCCCPR/DLT rules above are pre-built into the compliance engine so Phase-3 channels slot in without a compliance redesign. The 9am–9pm window applies to all windowed channels when activated.

> ASSUMPTION: WhatsApp Business API compliance (Meta BSP, template approval) follows the same pattern as DLT — per-brand, pre-approved templates, consent-gated. The compliance engine's `sender_registered` and `template_approved` checks generalize to this channel.

---

### 3. Tax obligations on Brain's own fee (noted, not a processor compliance matter)

These are Brain's own tax obligations as a vendor, not data-subject protection obligations:

- **India GST:** Brain's fee is subject to GST at the applicable rate (SAC code TBD — open decision, BRD §23.3). E-invoicing / IRN generation applies above the threshold. Invoice lines carry `sac_hsn_code` and `tax_rate_bps` (doc 08 §9 `invoice_line`).
- **UAE VAT:** Brain's fee in the UAE is subject to VAT. Invoices are issued in English + Arabic.
- **KSA ZATCA Phase 2:** Brain's KSA invoices must comply with ZATCA e-invoicing (Arabic + English, QR code). The exact Phase-2 scope for a SaaS fee is an open legal decision (BRD §23.3).

> ASSUMPTION: The SAC code applicable to Brain's platform fee and the IRN/e-invoicing threshold applicability are open decisions (BRD §23.3). Until confirmed by legal counsel, Brain will invoice with a placeholder SAC code and apply IRN generation above the current ₹5Cr turnover threshold as a conservative default.

---

### 4. PCI-DSS — explicitly OUT OF SCOPE (SAQ-A boundary)

Brain stores gateway tokens only (`payment_method.gateway_token` — doc 08 §9). Brain never stores, transmits, or processes PANs, CVVs, raw bank account numbers, or full UPI secrets. Payment processing is delegated entirely to PCI-compliant payment gateways. Brain's SAQ-A posture is maintained by construction:
- The `payment_method` table holds `gateway_token text` and `provider text` only.
- The no-card-data invariant is a CI lint gate (any column named `pan`, `cvv`, `card_number`, `full_account` fails the build).

Any change that would bring card data into Brain's perimeter requires a Security Reviewer VETO and a full PCI-DSS scoping review before proceeding.

---

### 5. SOC2 — explicitly DEFERRED

SOC2 Type II is deferred to the enterprise phase (Phase 5, BRD §22). It is not an enforced gate in Phase 1.

**TODO-with-owner:** Security Reviewer owns the SOC2 readiness backlog entry. At enterprise-phase kickoff, the Security Reviewer will:
1. Initiate a SOC2 Type II scoping exercise (Trust Services Criteria: Security, Availability, Confidentiality at minimum).
2. Map existing controls (audit log, RLS, KMS, incident response, change management) to TSC criteria.
3. Select a qualified auditor and define the observation period.
4. Report SOC2 readiness status to the Engineering Advisor at the Phase 4→5 gate.

The existing controls in this file (audit log, encryption, access control, incident response) are designed to be SOC2-compatible so the deferred audit does not require rebuilding controls.

---

## Controls (each becomes an enforced rule + a Security VETO surface)

| Control | Requirement | How enforced | Evidence (CI gate / audit record) |
|---|---|---|---|
| **Data residency — India** | Indian customer data stored in ap-south-1 (AWS) by default. No cross-region copy without a sub-processor registry entry. | Terraform `aws_region = "ap-south-1"` on every data store (RDS, S3/Iceberg Bronze, ElastiCache, MSK/Redpanda). IaC policy gate (Checkov/OPA) rejects any data-store resource without the approved region tag. | IaC scan artifact per deploy; sub-processor list in the DPA (versioned in repo). |
| **Data residency — GCC** | UAE/KSA customer data stays in the GCC region (exact AWS region TBD at GCC launch). Cross-border transfer only via approved mechanisms listed in the DPA. | GCC region is a separate deployment with its own data stores. The `organization.region` field (`IN` / `GCC`) gates which regional deployment the brand's data flows to. Brand-region mismatch is a hard error at onboarding. | IaC scan for GCC deployment; region-tag CI gate; DPA sub-processor list. |
| **Consent — capture (four categories)** | Consent must be recorded before personal data is used for analytics, marketing, personalization, or AI processing. Categories: `analytics`, `marketing`, `personalization`, `ai_processing`. Capture fails closed (no consent = no processing). | `consent_record` table (doc 08 §5.5): append-only, PK `(brand_id, brain_id, category, effective_at)`. The Collector enforces consent at capture (§7.4.5 BRD). `consent_flags` on the universal event envelope (doc 07 §4). A non-consented event is quarantined, not silently dropped. | CI gate: consent-propagation test (every customer-domain event carries `consent_flags`; a missing flag fails the build). Schema-lint: events without `consent_flags` on customer-domain topics fail the no-PII gate. |
| **Consent — withdrawal (retroactive, <15min propagation)** | Withdrawal must suppress all pending and future outreach within 15 minutes. Retroactive: already-passed-back conversion data must be deleted from ad platforms. Marketing consent withdrawal is not a transactional-message block (transactional continues where legally permissible). | `consent_tombstone` table (doc 08 §5.5): written immediately on withdrawal. `consent-suppressor` consumer group (doc 07 §23): fast-path, fail-closed, <15min SLA. The `pending_window` queue checks the tombstone before flushing. CAPI-deletion consumer triggers ad-platform deletion. | Consent-withdrawal integration test: a `consent.withdrawn` event must result in suppression of all pending sends within 15 minutes (measured in staging). Non-zero suppressed-outreach-post-withdrawal = SLO violation (§ Compliance SLOs below). |
| **Consent — non-consented contact structurally impossible** | A send to a `withdrawn` or `never` consent customer must be impossible by construction, not a runtime check. | The compliance engine's `can_contact()` check is hard-coded into every outbound path (email, WhatsApp, push, CAPI passback). Bypass of this check is a Security VETO surface. `opt-out overrides all marketing` is a hard rule — no feature flag can disable it. | Isolation test: a send attempt against a `withdrawn`-consent customer must fail (blocked by the compliance engine) with zero exceptions. Runs in CI on every PR touching the notification or send paths. |
| **Retention — Bronze raw events** | 24-month rolling retention for raw Bronze (Iceberg) events. | Iceberg partition expiry by `days(occurred_at)` — partition pruning deletes partitions older than 24 months. Argo compaction job enforces TTL. | Retention-compliance job run log (Argo) per weekly cycle; S3 lifecycle policy as a backstop. |
| **Retention — ledger / audit / billing** | Ledger, audit log, billing records, and Decision Log survive for workspace life (legal retention). Erasure requests do NOT delete these; they operate via surrogate (see Erasure below). | No `DELETE` grant on `realized_revenue_ledger`, `audit_log`, `invoice`, `decision_log` for the app role (INSERT+SELECT only per doc 08 §4). | DB grant audit: quarterly automated check that no `DELETE`/`UPDATE` grant exists on these tables for the app role. |
| **Erasure — crypto-shred** | A DPDP/PDPL erasure request must result in the person being forgotten while math (ledger, audit) still reconciles on a surrogate. | Erasure sequence (doc 08 §13): (1) destroy key material via `brand_keyring` (KMS key deletion = crypto-shred of `contact_pii` ciphertext); (2) tombstone `customer` node → opaque `surrogate_brain_id`; (3) re-project marts onto surrogate; (4) Bronze stays immutable but non-identifying (erasure-aware compaction rewrites partitions so old Iceberg snapshots don't resurrect identifier hashes); (5) CAPI deletion signal. `pii_erasure_log` records the full sequence (doc 08 §5.5). | Erasure integration test: post-erasure, a query for the original `brain_id` must return no PII; the ledger row must still carry the `surrogate_brain_id` with correct amounts. `vault_shredded=true` in `pii_erasure_log`. |
| **PII minimization — hashed identifiers** | Raw PII never outside the `contact_pii` vault. All operational tables, events, marts, and logs carry `sha256(per-brand-salt ‖ normalized value)` only. | `identity_link.identifier_value` is hash-only (doc 08 §6). `contact_pii` RLS additionally requires `app.role='send_service'` — no other role may read plaintext PII (doc 08 §6). No-PII schema-lint CI gate (doc 07 §26, gate 6): rejects any event schema field with a PII-typed name. | CI: no-PII schema-lint on every PR touching `packages/contracts` or `packages/events`. Log-grep gate: a sample of production log lines must not contain `email=`, `phone=`, `name=` or similar literal PII strings (run nightly in staging). |
| **PII minimization — no PII in logs** | PII must never appear in application logs, structured log fields, error messages, or SIEM streams. | Logger middleware redacts PII-shaped values at the logger AND at the log-shipping layer before reaching the log store. `ai_provenance.question_redacted` (doc 08 §5.5) — NLQ queries are stored in redacted form only. `audit_log.payload` carries references (IDs, hashes), not PII values. | Nightly log-scan in staging: grep for `@.*\.com`, `[6-9][0-9]{9}`, `pan_` and similar patterns — zero hits required. Any hit pages Security. |
| **No PII in events** | Events on the bus carry only hashed identifiers and vault references. Raw email/phone/name never in any Avro payload field. | Schema-lint gate (doc 07 §26 gate 6): CI rejects a schema with a field typed as direct PII (e.g. `email text`, `phone text`, `full_name text`). The `contact_pii` vault is the only authorized store; marts reference it by `pii_vault_reference`. | CI: schema-lint artifact per PR. Replay compat test also validates historical Bronze schemas never had raw PII (gate 4, doc 07 §26). |
| **Brand isolation — absolute and structural** | A cross-brand data leak is P0 (SLO = 0). Isolation is structural, not a setting — enforced at every layer. | Four layers (doc 08 §3): (1) Postgres RLS `USING (brand_id = current_setting('app.current_brand_id')::uuid)` on every brand-scoped table; non-owner role (no BYPASSRLS); middleware asserts non-null before any query. (2) Iceberg Bronze: per-brand S3 prefix + per-brand KMS DEK. (3) StarRocks: per-brand row policies + `DISTRIBUTED BY HASH(brand_id,…)`; Analytics API is the sole reader. (4) Redis: keys built via the single `tenant-context.brandKey()` helper; raw keys are lint-banned. | CI isolation-fuzz: a synthetic cross-brand query at each layer (Postgres, StarRocks, MCP) must return nothing, not another brand's data. Runs on every PR touching a data-access path. |
| **Audit trail integrity** | The audit log must be tamper-evident, append-only, and WORM-anchored. No row may be altered after insertion. | Hash-chain: `entry_hash = sha256(prev_hash ‖ canonical(row))` per `(brand_id, seq)`. App role: INSERT+SELECT only (no UPDATE/DELETE grant). Hourly checkpoint hash → S3 Object Lock (WORM, minimum 7-year retention). | Hourly checkpoint job run log. Quarterly chain-integrity verification job (walks the hash chain and asserts no breaks). |
| **KMS / secrets — no plaintext in DB or logs** | Vendor credentials, OAuth tokens, connector secrets, and per-brand DEKs must never be stored in plaintext in any DB column, log line, or environment variable visible in CI. | `connector_instance.secret_ref` holds a reference to AWS Secrets Manager (not the ciphertext). `brand_keyring.wrapped_dek` holds the KMS-wrapped DEK (not the plaintext key). `contact_pii.pii_ciphertext` holds AES-256-GCM ciphertext; the DEK is never exported. | Secret scanner (gitleaks + TruffleHog) on every PR diff. CI SAST (Semgrep) with secret-detection rules. No `oauth_token` column may hold a plaintext token — enforced by a Semgrep rule that flags string columns named `*_token` without a `_ref` or `_hash` suffix on the model. |
| **Money representation** | All monetary values are `*_minor BIGINT` (integer minor units) + `currency_code CHAR(3)` (INR / AED / SAR). No float arithmetic on money. | Lint rule: any column named `*_amount`, `*_value`, `*_fee`, `*_cost`, `*_revenue` that is typed `float`, `double`, `numeric` (without explicit usage in a ratio context) fails the build. The metric engine is the only place that emits computed money values; it always returns integer minor units. | CI: money-lint gate on every PR touching schema files or metric definitions. |
| **AI honesty — no invented numbers** | The LLM layer narrates and recommends only. All numeric values in recommendations and NLQ responses must trace to deterministic metric engine output. Asserting a figure not present in `ai_provenance.metric_binding` or `value_minor` is a P0 honesty violation. | `ai_provenance` table (doc 08 §5.5): every AI response is linked to a `metric_binding` (the metrics that grounded the answer) and a `snapshot_id`. The NLQ resolution gate (BRD §22 Phase 1) checks that every number in the LLM output is present in `metric_binding` before the response is surfaced. The LLM is never given a query or write tool; it receives only a structured context derived from certified metrics. | NLQ resolution eval gate (CI): a golden set of queries whose answers contain numbers — each number must appear in the `metric_binding` of the `ai_provenance` row. A hallucinated number fails the gate. |
| **AI — no data modification** | The AI/LLM layer must never issue database queries, change model weights, alter eligibility rules, or modify any data store. It is read-only and narration-only. | The MCP server is read-only (no write tools registered). The `ai` module receives structured metric context only; it has no DB credentials and no write-path. Agentic execution (Phase 4) is a separate module with its own guardrail chain — not the AI/LLM layer. | MCP tool registry audit: every registered MCP tool must have `read_only: true` in its schema. A write tool in the MCP registry is a Security VETO. |

---

## Audit-trail integrity

The audit log (`audit_log`, doc 08 §5.2) is the tamper-evident record for all sensitive actions including consent changes, erasure requests, AI/MCP queries, auto-execute toggles, exports, and billing mutations.

**Mechanism:**
- Append-only: the app role holds INSERT+SELECT only — no UPDATE or DELETE grant at the PostgreSQL GRANT level.
- Hash-chain: each row carries `prev_hash` (the `entry_hash` of the preceding row in the brand's sequence) and `entry_hash = sha256(prev_hash ‖ canonical(row))`. A tampered row breaks every subsequent hash in the chain.
- Per-brand sequence: `PK(brand_id, seq)` — each brand has its own monotonically increasing chain; `seq` gaps are detectable.
- WORM anchor: every hour, the current chain tip hash is written to S3 Object Lock (minimum retention = the workspace-life legal requirement). This creates an external, immutable reference that cannot be altered even with database superuser access.
- PII-free: `audit_log.payload` carries resource IDs, hashed identifiers, and action metadata — never raw PII values (enforced by the no-PII-in-logs gate).

**Chain verification:** a scheduled quarterly job walks the entire chain for every brand and asserts: (a) `entry_hash` recomputes correctly for every row; (b) `prev_hash` of row N equals `entry_hash` of row N−1; (c) every hourly checkpoint hash matches the S3 Object Lock object for that window. Any break pages Security and is a P0 incident.

> ASSUMPTION: The S3 Object Lock retention period for the WORM checkpoint is set to the longest applicable legal retention requirement across all regions. For Phase 1 (India), this is assumed to be 7 years (aligned with typical financial record requirements). If DPDP Rules or ZATCA specify a shorter or longer period, the Object Lock policy will be updated accordingly.

---

## Evidence-as-you-build

Controls map to CI gates whose green records ARE the compliance evidence — not reconstructed before an audit.

| Control | CI gate | Gate record IS evidence of |
|---|---|---|
| Brand isolation | `isolation-fuzz` test suite (cross-brand query at Postgres / StarRocks / MCP layers) | Structural isolation at every data layer |
| No PII in events | `no-pii-schema-lint` (gate 6, doc 07 §26) | PII never entered the event bus or Bronze |
| No PII in logs | Nightly `log-pii-grep` in staging | PII never reached the log store |
| Consent propagation | `consent-propagation-test` (every customer event carries `consent_flags`) | Consent state travels with every data unit |
| Money representation | `money-lint` gate | No float money anywhere in the codebase |
| Secret detection | `gitleaks` + `TruffleHog` pre-commit + CI | No plaintext credentials in the repo or diff |
| SAST | `Semgrep` on every PR | No hardcoded secrets, weak crypto, or plaintext-token columns |
| SCA + container | `Trivy` + `Grype` + `OSV-Scanner` on every image build | No CRITICAL/HIGH CVE in shipped dependencies |
| IaC compliance | `Checkov` on `infra/` | No misconfigured cloud resource (region, encryption, public access) |
| AI honesty | NLQ resolution eval gate (golden query set) | LLM output never invents a number |
| Erasure completeness | Erasure integration test (post-erasure PII query returns nothing) | Crypto-shred removes all PII for the subject |
| Audit chain integrity | Quarterly chain-walk job | Audit log has not been tampered with |
| No-card-data | `pan-cvv-column-lint` in CI | PCI SAQ-A boundary maintained |
| MCP read-only | MCP tool registry audit (CI) | No write tool ever registered on the MCP path |

**Retention of gate records:** CI run artifacts are retained for 90 days in the CI system. The quarterly chain-walk and nightly log-grep reports are archived to S3 (WORM-adjacent, versioned) for the full legal retention period. These artifacts serve as the evidence corpus for any regulatory inquiry without requiring a bespoke audit-preparation exercise.

---

## Compliance SLOs (all must be zero — a non-zero reading is a rule violation, not a metric)

| SLO | Meaning | Measured by |
|---|---|---|
| `suppressed_outreach_post_withdrawal = 0` | Zero contacts delivered after a consent withdrawal within the <15min propagation window | `consent-suppressor` consumer lag metric + send audit log |
| `out_of_window_send_attempts = 0` | Zero commercial messages sent outside 9am–9pm IST (or applicable regional window) | Queue flush log: all flushes timestamped within the permitted window |
| `cross_brand_data_leaks = 0` | Zero confirmed cross-brand data exposures | Isolation-fuzz CI + incident log |
| `pii_in_logs_incidents = 0` | Zero confirmed PII-in-logs events | Nightly log-grep + SIEM alert |
| `non_consented_sends = 0` | Zero sends to a `withdrawn` or `never` consent subject for a marketing purpose | Compliance engine block log |

---

## Open decisions and escalation path

- Legal/tax: SAC code for Brain's fee + IRN threshold + KSA ZATCA Phase-2 SaaS scope. Owner: Engineering Advisor + legal counsel. Deadline: before first KSA invoice.
- DPDP Rules 2025 finalization date and Consent Manager API spec. Owner: Security Reviewer (monitors). Action: update `consent_record.source` enum when spec is final.
- UAE/KSA PDPL breach-notification windows and cross-border transfer mechanism (adequacy decision vs SCCs equivalent). Owner: Engineering Advisor + legal counsel. Deadline: before GCC region activation.
- GCC AWS region selection. Owner: Platform/SRE. Deadline: before GCC onboarding.

A compliance decision that cannot be resolved within the Engineering team escalates to the Engineering Advisor, who logs it as a Stakeholder decision in the pending-stakeholder-attention register.

