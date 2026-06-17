# 13 — Security & Privacy + Implementation Roadmap (D13 + D14)

**Scope:** D13 Security & Privacy (PII, hashing, encryption, key mgmt, consent, retention, right-to-erasure, crypto-shred, IN/UAE/KSA residency, privacy boundaries, security controls, auditability). D14 Implementation Roadmap (8 phases, each EXTENDING shipped work and independently shippable through the Engineering OS pipeline).

**Grounding:** `.engineering-os/knowledge-base/{COMPLIANCE.md,INVARIANTS.md,STACK.md}`, `db/migrations/0001_init.sql`, `0015–0018`, `0017_identity_graph.sql`, `0024_dev_secret.sql`, `0026/0027`, `packages/identity-core/src/index.ts`, `apps/core/src/modules/notification/internal/notification.service.impl.ts`, `packages/contracts/src/dq`.

**Hard-constraint posture:** every recommendation below extends an existing seam (table / module / package / event / consumer-group). **Zero new deployables.** Anything that would add an app, a topic, a second consent model, a second hasher, or a bespoke RLS variant is tagged **Reject** with the reason. Tags: **Present** (shipped, file ref), **Equivalent** (a seam exists in coarse/stub form — extend it), **Missing** (genuine net-new, with the exact seam to extend), **Raw-Only** (captured raw in Bronze, modeled later by design), **Reject** (drift / duplication / unnecessary).

---

# D13 — Security & Privacy

## 13.1 Tenant isolation (THE invariant — I-S01)

| Capability | Tag | Evidence / Seam |
|---|---|---|
| Postgres RLS `ENABLE + FORCE` on every brand-scoped table, NN-1 two-arg fail-closed `USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid)` | **Present** | `0001_init.sql:55-73,169-173`; replicated on `bronze_events` (0016), `customer/identity_link/...` (0017), `realized_revenue_ledger` (0018), `connector_*` (0006/0021), `pixel_installation` (0007). Each migration carries the NN-1 assertion DO-block (`0001:182-199`). |
| Non-owner app role `brain_app` NOLOGIN, BYPASSRLS asserted FALSE at migration time | **Present** | `0001_init.sql:35-53`. |
| GUC context builder, UUID-validated, `SET LOCAL`, reset-all on checkout | **Present** | `packages/db/src/index.ts`; `packages/db/src/rls.test.ts`. |
| Isolation verified under role `brain_app` (NOT superuser) | **Present** | many `*.live.test.ts` `SET ROLE brain_app`. **Memory caveat:** dev connects as superuser `brain` which bypasses RLS — every isolation test MUST `SET ROLE brain_app` or it proves nothing (MEMORY: dev-db-superuser-masks-rls). |
| Sanctioned cross-tenant enumeration without GUC (live-connector dispatch) | **Present** | `SECURITY DEFINER` fns owned by superuser, `SET search_path=public`, dispatch-only return cols (`0026`, `0027`). The only sanctioned RLS-bypass path; migration-time `prosecdef`/`search_path`/`EXECUTE` guards. |
| `collector_spool` deliberately NO RLS (pre-brand-validation) | **Present** | `0015_collector_spool.sql`. **Reject** adding RLS — breaks accept-before-validate (brand_id parsed only by the drainer; isolation enforced downstream at `bronze_events`). |
| `audit_log` / `brand_keyring` deliberately RLS-disabled (cross-brand SoR / key-mgmt writer) | **Present** | `0001_init.sql:105-109,144-148`. **Reject** enabling RLS — documented design. |
| StarRocks per-brand row policies + Analytics-API-as-sole-reader (I-ST01) | **Missing (gated)** | StarRocks/Silver not yet in repo (M1 Bronze = Postgres `bronze_events`). Lands with the Silver tier (Phase 4/7). Until then there is no second read path to isolate. |

**No new RLS pattern is permitted.** Any new table reuses the NN-1 two-arg `PERMISSIVE FOR ALL TO brain_app` template verbatim + the NN-1 assertion. A one-arg form or a new GUC name is **Reject** by construction (`0001:182-199` fails the build).

## 13.2 PII handling & hashing strategy (I-S02)

| Capability | Tag | Evidence / Seam |
|---|---|---|
| Single boundary hasher `sha256(per-brand-salt ‖ normalized)`, real `node:crypto`, E.164 phone (D-6), pinned conformance vector | **Present** | `packages/identity-core/src/index.ts:34,117,156,206`. **The only sanctioned hasher.** **Reject** any second hashing util — drift/leak vector. |
| Per-brand salt with hard-crash-on-miss (D-2) | **Present** | `brand.identity_salt_ciphertext` (0017); `apps/stream-worker/.../SaltProvider.ts` throws on miss/wrong-length. |
| Operational stores carry 64-hex only; raw PII only in `contact_pii` vault | **Present** | `identity_link.identifier_value` hash-only; `bronze_events.payload` documented no-raw-PII. |
| **Client-side hashing at the SDK boundary** for browser-captured identifiers | **Missing** | No producer-side hasher today (only the synthetic fixture hard-codes a fake hash). **Seam:** when the brain.js SDK lands (Phase 1 roadmap), it must NOT ship raw PII to `/collect`; client hashes email/phone via a port of `identity-core` normalize+sha256 before POST. **Risk flagged:** the per-brand salt must NEVER reach the browser (it would let any visitor reverse-correlate). **Decision:** SDK sends a *coarse* client identifier (anon-id, hashed email with a *public* per-brand pepper distinct from the secret salt) and re-hashing to the canonical salt happens server-side in `stream-worker` from `bronze_events.payload`. This keeps I-S02 intact and the secret salt server-only. |
| No PII in events / marts / caches (schema-lint gate) | **Equivalent** | The rule is canon (COMPLIANCE §Controls "No PII in events"); the `no-pii-schema-lint` CI gate is referenced but I did not confirm the gate file is wired. **Action:** verify/land the schema-lint gate on `packages/contracts` + `packages/events` before SDK ships (it is the structural guard that the SDK can't smuggle raw PII through `payload`). |
| No PII in logs (logger redaction + nightly staging grep) | **Missing** | Logger-redaction middleware + nightly `log-pii-grep` are canon-specified (COMPLIANCE §Controls) but not confirmed present. **Seam:** add to the shared logger package + a staging cron (Argo), not a new service. |

## 13.3 Encryption & key management (I-S05, I-S09; ADR-005/007)

| Capability | Tag | Evidence / Seam |
|---|---|---|
| Per-brand wrapped DEK substrate (KMS-wrapped, `is_active` crypto-shred toggle) | **Present** | `brand_keyring` (`0001:123-148`); SELECT-only for app role; key-mgmt job writes. |
| Secrets by reference only — `connector_instance.secret_ref` → AWS Secrets Manager; no plaintext-token columns (NN-2) | **Present** | `0006/0021/0027`; semgrep DDL scan. **Reject** any `*_token/*_secret/*_ciphertext` column on a connector table — secret_ref ARN only. |
| Dev stand-ins (documented, prod-swap is intent): `contact_pii.pii_value` plaintext → `pii_ciphertext` (KMS AES-256-GCM); `dev_secret` table → AWS Secrets Manager | **Equivalent** | `0017` (`contact_pii`), `0024_dev_secret.sql`; `LocalSecretsManager` hard-fails in prod. **Seam:** the prod ciphertext column + KMS `GenerateDataKeyWithoutPlaintext` wiring is documented-intent — land as an additive column + KMS adapter, no new store. |
| **Prod KMS encryption-at-rest for `contact_pii`** (`pii_ciphertext` AES-256-GCM path) | **Missing** | Additive column on the existing `contact_pii` table + DEK-derivation via `brand_keyring`. No new table. |
| **Crown-jewel restore drill** (quarterly `brand_keyring` DEK restore — loss = unrecoverable shred) | **Missing** | I-S05 mandates it. Argo scheduled job + runbook; no new service. |

**Reject:** a new secrets store (the `dev_secret` → Secrets Manager + `brand_keyring` topology is locked, I-S09).

## 13.4 Consent management (I-S03, I-S04)

| Capability | Tag | Evidence / Seam |
|---|---|---|
| Coarse two-flag consent capture (`ai_processing_consent`, `resolution_consent`, default FALSE) | **Equivalent** | `customer` table `0017:40-41`. This is a stand-in, NOT the mandated model. |
| `can_contact()` chokepoint exists as a **pass-through stub** | **Equivalent** | `notification.service.impl.ts:168-172` (`return true`; "Phase 3 will add real consent checks, DND, DLT"). The single chokepoint seam (I-ST05) exists; enforcement does not. |
| **`consent_record` table** — append-only, 4 categories (`analytics/marketing/personalization/ai_processing`), PK `(brand_id, brain_id, category, effective_at)`, `source` forward-compatible with `consent_manager` | **Missing** | New additive migration (mirror `identity_audit` append-only-by-GRANT discipline). The single canonical consent SoR. **Reject** retrofitting the coarse `customer` booleans into a parallel scheme — one SoR only. |
| **`consent_tombstone` table + `consent-suppressor` consumer** (fast-path, fail-closed, <15 min withdrawal SLA) | **Missing** | New table; new consumer *group* off the **existing** `dev.collector.event.v1` / a `privacy.consent.*` event on the **existing** topic family — **not a new deployable**, a consumer inside `stream-worker`. |
| **`consent_flags` on the universal event envelope** (every customer-domain event carries it; missing flag → quarantine, not drop) | **Missing** | Additive-optional field on `collector.event.v1.avsc` (FULL_TRANSITIVE). **Reject** a new envelope. |
| **Real `can_contact()` enforcement** (consent + NCPR/DND + DLT template-approval + 9am–9pm IST window + `pending_window` queue) | **Missing** | Replace the stub in the **existing** notification module; build the compliance-engine machinery inside it. No new service. Phase-3 channel (WhatsApp/CAPI) slots in without redesign because the chokepoint already exists. |
| **CAPI-deletion consumer** (retroactive ad-platform conversion deletion on withdrawal — I-S04) | **Missing** | New consumer in `stream-worker` off `privacy.consent.withdrawn`. |

**Benchmark:** Triple Whale / Northbeam treat consent as a tracking-toggle at the pixel. Brain's four-category append-only `consent_record` + retroactive CAPI-deletion is stricter and DPDP-correct — keep it; do not regress to a boolean toggle.

## 13.5 Retention & right-to-erasure / crypto-shred (I-S05, I-E02)

| Capability | Tag | Evidence / Seam |
|---|---|---|
| Append-only-by-GRANT on Bronze/ledger/audit (no UPDATE/DELETE grant; corrections = new signed rows) | **Present** | `bronze_events` (0016), `realized_revenue_ledger` (0018, assertion-2), `audit_log` (0001). I-E02 destructive-migration ban. |
| Erasure represented as `lifecycle_state='erased'` + `identity_audit.action='erase'` | **Equivalent** | `0017:38-39,256`. State-machine seam exists; orchestration does not. |
| Crypto-shred substrate (`brand_keyring.is_active` toggle) | **Present** | `0001:133-134`. |
| **`pii_erasure_log` + crypto-shred erasure job sequence** (destroy DEK → tombstone `customer` to `surrogate_brain_id` → re-project marts → erasure-aware Iceberg compaction → CAPI deletion → `vault_shredded=true`) | **Missing** | New `pii_erasure_log` table + an erasure orchestrator **inside `stream-worker`** (consumer off a `privacy.erasure.requested` event on the existing topic family). No new deployable. |
| **`surrogate_brain_id` re-pointing** (ledger/audit survive on surrogate; math reconciles, person forgotten) | **Missing** | Additive column + re-point logic in the existing `IdentityRepository` write path. Mirror `brain_id_alias` re-pointing discipline (0017 §5). |
| **24-month Bronze Iceberg TTL** (partition expiry by `days(occurred_at)` + Argo compaction) | **Missing (gated)** | Gated on the Iceberg Bronze landing (Phase-3 storage flip). M1 Postgres `bronze_events` has no TTL job. **Raw-Only** until then — correct posture. |
| **Quarterly DELETE-grant audit job** (assert no UPDATE/DELETE grant on ledger/audit/invoice) | **Missing** | Argo scheduled check; no new service. |

**Highest-risk seam in D13.** Erasure must destroy PII while keeping immutable Bronze/ledger reconciling. Because M1 Bronze is Postgres (not yet Iceberg), the "erasure-aware Iceberg compaction" step (I-S05 step 4) **cannot be exercised end-to-end today** — old hashes would persist in `bronze_events` until the Iceberg migration. **Recommendation:** ship `consent_record`/`consent_tombstone` and the crypto-shred-of-`contact_pii` path now (they fully satisfy DPDP for *plaintext PII*), and gate the Iceberg-compaction step explicitly on the Phase-3 storage flip, documented as a known limitation in the DPA. Do not claim full I-S05 conformance until Iceberg lands.

## 13.6 Auditability (I-S06)

| Capability | Tag | Evidence / Seam |
|---|---|---|
| Hash-chained, append-only `audit_log` (prev_hash/entry_hash, INSERT+SELECT only, idempotency_key UNIQUE) | **Present** | `0001:73-116`; writer `packages/audit/src/index.ts`. Per-brand `identity_audit` (0017). |
| **WORM anchor** (hourly checkpoint hash → S3 Object Lock, 7-yr) + **quarterly chain-walk verification** | **Missing** | Hash-chain columns exist; the S3 Object Lock checkpoint + verification job do not. Argo scheduled jobs + `BlobAdapter` (S3 Object Lock) — no new service. |

## 13.7 Regional compliance (IN now; UAE/KSA gated — ADR-014 RegionAdapter)

| Capability | Tag | Evidence / Seam |
|---|---|---|
| Residency posture declared: `brand.region_code` DEFAULT 'IN'; `ap-south-1` IaC tag + Checkov gate | **Present** | `0004_brand.sql`; COMPLIANCE §Controls; `.checkov.yaml`, `policy/`. |
| RegionAdapter seam built, India binding only active | **Present** | STACK ADR-014. |
| **GCC (UAE/KSA) data-residency deployment gate** (`organization.region` IN/GCC gating; all stores provisioned in-region before first UAE subject; brand-region mismatch = hard error at onboarding) | **Missing (Phase-5 amendment)** | Extends the RegionAdapter seam + an `organization.region` gate at onboarding. **Reject** building GCC stores now — STACK phasing freezes multi-region to Phase 5; the seam (not the deployment) is the Phase-1 obligation. |
| PCI SAQ-A boundary (gateway-token-only; `pan/cvv/card_number/full_account` column lint) | **Equivalent** | I-S10 / COMPLIANCE §4. `payment_method` table not yet in migrations; the lint gate must be confirmed wired before any payment-method work. **Reject** any card-data column (Security VETO surface). |

## 13.8 Privacy boundaries (the AI/data-access guardrails)

- **One Analytics API read path (I-ST01)** — no NLQ/MCP/export/dashboard touches StarRocks/Iceberg directly. **Present** as invariant; enforced when Silver lands.
- **AI is read-only / no invented numbers (I-S08)** — MCP write-tool = Security VETO; every number traces to `metric_binding`. **Present** as invariant; enforced when the AI layer lands (Phase 8 inputs).
- **NLQ stored redacted only** (`ai_provenance.question_redacted`). **Missing** — lands with the AI layer; capture redacted form only (**Reject** raw query PII).

## 13.9 D13 net-new (Missing) summary

`consent_record` · `consent_tombstone` + `consent-suppressor` consumer · `consent_flags` envelope field · real `can_contact()` compliance engine · `capi-deletion` consumer · `pii_erasure_log` + crypto-shred orchestrator · `surrogate_brain_id` re-pointing · prod `pii_ciphertext` KMS path · audit WORM anchor + chain-walk · client-side SDK hashing (public-pepper, salt stays server-side) · no-PII log redaction + nightly grep · Bronze Iceberg 24-mo TTL (gated) · GCC residency gate (Phase 5). **All extend existing seams; zero new deployables.**

---

# D14 — Implementation Roadmap

**Sequencing principle:** each phase EXTENDS shipped work and is independently shippable through the Engineering OS pipeline (one `feat-*` run → contract → migration → consumer/module → live test under `brain_app` → deploy). Phases map onto the as-built run history (`.engineering-os/runs/`). The four deployables (collector · stream-worker · core · web) + Argo jobs are fixed — **no phase adds a deployable** (I-E05).

### Phase 1 — Collection Foundation (browser capture SDK)
- **Status:** edge→spool→drainer→Redpanda→Bronze backbone **shipped** (`feat-data-plane-ingest-spine`). Gap = brain.js SDK.
- **Scope:** extend `packages/pixel-sdk` (currently `export {}`): anon-id + 30-min session, click-ID/UTM/_fbc/_fbp capture, offline queue, consent-at-capture, client-side hashing (public pepper — §13.2), serve versioned `/pixel.js` on the per-tenant CNAME, POST to **existing** `/collect` with the **existing** `collector.event.v1` wire shape (event_type+payload, additive-only).
- **Dependencies:** none new — reuses spool, drainer, Bronze, envelope.
- **Acceptance:** real browser-origin `/collect` E2E (not just the Node fixture); no raw PII on the wire (no-PII schema-lint green); Bronze receives SDK events idempotently `(brand_id,event_id)`.
- **Risks:** salt-in-browser leak (mitigated: server-side re-hash); envelope shape fork (mitigated: reuse Avro/Bronze shape). **Reject:** new SDK package, new deployable, new topic, new envelope.
- **Success metric:** `events_captured_count` from real storefronts > 0; zero raw-PII gate failures.

### Phase 2 — Commerce Truth (revenue ledger)
- **Status:** **shipped** (`feat-realized-revenue-ledger`, `feat-shopify-live-connector`, `feat-razorpay-settlement-connector`). Orders/settlements/refunds/RTO/chargebacks modeled; `realized_gmv_as_of()` no-double-count.
- **Scope (residual):** broaden settlement/fee coverage as new payment connectors onboard via the existing connector framework + mappers.
- **Acceptance:** RTO = signed reversal row, original untouched; idempotent replay produces no new ledger rows (I-ST04); money = BIGINT minor + currency_code (I-S07).
- **Risk:** multi-currency per brand — single-currency BEFORE-INSERT trigger already guards.
- **Success metric:** ledger reconciles vs connector source on replay (parity).

### Phase 3 — Identity
- **Status:** **shipped & live** (`feat-identity-graph`). Deterministic mint/link/merge, `brain_id_alias` re-pointing, phone-guard, full RLS graph; `IdentityBridgeConsumer` on the live lane.
- **Scope (residual):** wire `anonymous_id` read/write from SDK events (today the resolver never reads it); consume `hashed_session_id` (inert envelope field).
- **Acceptance:** anon→known backward-merge deterministic; no probabilistic merge (D-5). **Reject:** ML/fuzzy merge; new identifier authority.
- **Risk:** over-stitching from promoting schema-reserved weak identifier types — keep strong-only.
- **Success metric:** merge correctness on golden fixtures; zero cross-brand hash correlation.

### Phase 4 — Journey (sessionize → silver.touchpoint)
- **Status:** **Missing** — no session/touchpoint modeling exists (HLD §36/54/96/98 defines the intended shape).
- **Scope:** sessionize in **stream-worker** (HLD pipeline step) writing to **silver.touchpoint**, a DERIVED Silver layer **OWNED BY the existing attribution module** — never a service/deployable/OLTP table. First/last-touch ordering per brain_id; UTM/click-id capture (fed by the Phase-1 SDK) + **cart-stitch** (webhook parser in the existing Shopify order handler + `shopify-mapper`; project `stitched_anon_id/click_ids/utms` into identity — additive migration mirroring `connector_razorpay_order_map`).
- **Dependencies:** **gated on the Silver tier (StarRocks/dbt/Iceberg) landing** — not yet in repo (M1 Bronze = Postgres). Also depends on Phase-1 SDK (UTM/click capture) + Phase-3 identity.
- **Acceptance:** touchpoints reproducible from Bronze (replay); deterministic cart-stitch (read brain_anon_id back, not infer). **Reject:** touchpoint table in Postgres OLTP; journey microservice; probabilistic stitch.
- **Risk:** journey is blocked until the analytics storage tier exists — sequence the StarRocks/dbt landing as a sub-track here.
- **Success metric:** journey timeline coverage % of identified orders; stitch hit-rate.

### Phase 5 — Attribution
- **Status:** **Missing** — `apps/core/src/modules/attribution` is an `export {}` stub.
- **Scope:** attribution credit over `silver.touchpoint`; `attribution_credit_ledger` append-only; `attribution_confidence` as a first-class output. Computed in the **TypeScript metric engine** (I-E03/I-E04) — never in a prompt/dbt macro.
- **Dependencies:** Phase 4 (journey) + revenue truth (Phase 2).
- **Acceptance:** parity oracle green (TS engine vs SQL recompute); every number traces to `metric_version` + snapshot.
- **Risk:** confidence semantics — bind to METRICS.md `attribution_confidence`, don't invent floats.
- **Success metric:** attributed revenue reconciles to realized revenue within tolerance.

### Phase 6 — Conversion Feedback (CAPI passback)
- **Status:** **Missing** — passback through the **single notification/consent chokepoint** (I-ST05).
- **Scope:** CAPI passback as a channel adapter **behind `can_contact()`** in the existing notification module; consent-gated, retroactive-deletion-capable (depends on D13 `capi-deletion` consumer).
- **Dependencies:** real `can_contact()` (D13 §13.4) + consent model + attribution.
- **Acceptance:** zero non-consented passback (compliance SLO = 0); retroactive deletion on withdrawal within 15 min.
- **Risk:** bypassing the chokepoint — structurally banned (I-ST05). **Reject:** any direct send path.
- **Success metric:** `non_consented_sends = 0`; CAPI match-quality.

### Phase 7 — Data Quality
- **Status:** **Equivalent/Missing** — empty `data-quality` bounded context + Sprint-0 Zod DQ contracts (`packages/contracts/src/dq`), no execution engine; DLQ/quarantine runtime exists.
- **Scope:** execute Freshness/Completeness/SchemaValidity/Reconciliation as **stream-worker consumer patterns** + (later) dbt assertions; stamp `dq_grade` + `cost_confidence`/`effective_confidence=min(cost,attribution)` via the **metric-engine** (confidence is a metric output, not a new DB float); the "70-line" quality gate that marks metrics estimated/untrusted.
- **Dependencies:** Silver tier (reconciliation Bronze↔StarRocks) for full coverage.
- **Acceptance:** freshness-SLA monitor live; quality gate blocks high-risk recommendations.
- **Risk:** building a DQ deployable — **Reject** (extend the empty module + stream consumers).
- **Success metric:** dq_grade coverage; estimated/untrusted correctly gated.

### Phase 8 — Decision-Intelligence Inputs
- **Status:** **Missing** — the terminal consumer of the whole chain.
- **Scope:** assemble certified metrics + confidence + journey + attribution as **read-only structured context** for the Decision Engine / AI layer via the **single Analytics API** (I-ST01) and **read-only MCP** (I-S08). `ai_provenance` (metric_binding, snapshot_id, question_redacted).
- **Dependencies:** Phases 5–7 (attribution + confidence + DQ).
- **Acceptance:** every AI number traces to `metric_binding` (NLQ resolution eval gate); MCP write-tool count = 0; NLQ stored redacted only.
- **Risk:** model-invented numbers / text-to-SQL — both structurally banned (I-S08). **Reject:** any MCP write tool, any model-written SQL.
- **Success metric:** zero honesty-gate failures; decision inputs reproducible from snapshot.

**Sequencing note:** Phases 1–3 are largely shipped; the critical-path net-new is **4 (Journey) → 5 (Attribution) → 6 (Feedback) → 7 (DQ) → 8 (DI inputs)**, and Phase 4 onward is **gated on the Silver tier (StarRocks/dbt/Iceberg) landing**, which is the single largest unbuilt foundation. D13's consent/erasure work (independent of Silver) can ship in parallel as additive migrations + stream-worker consumers any time after Phase 3.

---

## 10-line summary

1. Security primitives (RLS-FORCE/NN-1, single boundary hasher, per-brand salt, brand_keyring crypto-shred substrate, hash-chained audit_log, append-only-by-GRANT, secret_ref-only) are MATURE and shipped — D13 fills the consent/erasure/auditability gaps by EXTENDING seams, zero new deployables.
2. Missing (net-new): `consent_record` + `consent_tombstone` + `consent-suppressor` consumer + `consent_flags` envelope field (the four-category append-only model replacing two coarse `customer` booleans).
3. Missing: real `can_contact()` compliance engine (consent + NCPR/DND + DLT + 9am–9pm window) replacing the pass-through stub; `capi-deletion` consumer for retroactive withdrawal (I-S04).
4. Missing: `pii_erasure_log` + crypto-shred orchestrator + `surrogate_brain_id` re-pointing (destroy DEK → tombstone → re-project → CAPI delete), all inside stream-worker.
5. Missing: prod `contact_pii.pii_ciphertext` KMS path, audit WORM S3-Object-Lock anchor + quarterly chain-walk, no-PII log redaction + nightly grep, crown-jewel DEK restore drill.
6. Missing: client-side SDK hashing — secret salt MUST stay server-side; SDK uses a public per-brand pepper and re-hashing to canonical salt happens in stream-worker.
7. Gated: Bronze Iceberg 24-mo TTL + erasure-aware compaction (Phase-3 storage flip) and GCC residency gate (Phase-5) — seams built now, deployment deferred per STACK phasing.
8. Roadmap: Phases 1–3 (Collection SDK / Commerce Truth / Identity) largely shipped; net-new critical path is 4 Journey → 5 Attribution → 6 Feedback → 7 DQ → 8 DI-inputs.
9. The single largest unbuilt foundation gating Phases 4–8 is the Silver analytics tier (StarRocks/dbt/Iceberg) — journey/attribution/DQ-reconciliation cannot complete until it lands.
10. **Highest-risk decision:** right-to-erasure cannot be claimed end-to-end conformant (I-S05) while M1 Bronze is Postgres — old identifier hashes persist in `bronze_events` until the Iceberg-compaction step exists; ship consent + contact_pii crypto-shred now (DPDP-sufficient for plaintext PII), explicitly gate Iceberg-compaction on the Phase-3 flip, and document the limitation in the DPA rather than overclaim.
