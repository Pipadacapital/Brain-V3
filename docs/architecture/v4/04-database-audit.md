# 04 — Database Audit (PostgreSQL Ownership Conformance)

**Audit scope:** the live Aurora/PostgreSQL surface as described by `db/migrations/0001–0111` (gap at `0102`) and the application code that reads/writes it.
**Reference standard:** OFFICIAL BRAIN V4 ARCHITECTURE. Where code/migrations disagree with the architecture, **architecture wins**.
**Evidence base:** the validated V4 audit bundle (PostgreSQL/DB-architecture workstream, Security & Compliance workstream, RECON-1). Every claim below cites a path/migration from that bundle.

---

## 1. The V4 contract for PostgreSQL

PostgreSQL under V4 is **operational-only**. It is the system of record for control-plane / application state and nothing else.

| Allowed in PG (operational) | NEVER in PG (analytical / runtime) |
|---|---|
| organizations, brands, users, RBAC | events, clickstream |
| settings, workflows, application state | analytics, customer history |
| billing, connector config | attribution, recommendations (as computed output) |
| compliance vault + WORM audit (ADR-0004 exceptions) | features (runtime → Redis), AI outputs |

Allowed **decision-loop** tables in PG are explicitly bounded to four:
`recommendation_history`, `decision_history`, `decision_outcome`, `user_feedback`.
Anything beyond these four that stores recommendation/decision *computation* is a violation.

**Per-table V4 question set** (every table must answer all six):
1. Who owns it? 2. Why does it exist? 3. Which layer? 4. Operational? 5. Analytical? 6. Canonical?

---

## 2. Headline finding

A prior **medallion realignment** already evacuated the *bulk* of analytical data out of PostgreSQL. The following are **already DROPPED** and represent completed, V4-conformant cleanup:

| Table | Drop migration | Disposition |
|---|---|---|
| `data_plane.bronze_events` | `0070` (plan-noted again in `0085`) | Bronze SoR moved to Iceberg ✅ |
| `billing.realized_revenue_ledger` | `0098` | Revenue truth → Gold (Iceberg target) ✅ |
| `attribution_credit_ledger` | `0099` | Attribution → lakehouse target ✅ |
| PG identity-graph (6 tables) | `0101` | Identity SoR → Neo4j (ADR-0004) ✅ |
| `ml.prediction_log` | `0103` | Prediction stream out of PG ✅ |
| `ad_spend_ledger` | `0105` | Spend → Bronze/Silver ✅ |

The PG surface that remains is **mostly conformant operational data**. There is a **small, sharply-defined residual set of analytical / AI tables** that still violate V4, plus migration-hygiene debt. These are the actionable items in this audit.

---

## 3. Conformant operational surface (VALID — keep in PG)

These tables answer the V4 question set as operational, are RLS-isolated, and stay in PG.

### 3.1 IAM / tenancy / control-plane
| Table | Owns | Why | Layer | Op | Ana | Canonical |
|---|---|---|---|---|---|---|
| `organization` | Workspace | tenancy root | control-plane | ✅ | ❌ | ✅ |
| `tenancy.brand` | Workspace | brand entity | control-plane | ✅ | ❌ | ✅ |
| `app_user`, `membership`, `invite` | Workspace/RBAC | identity & access | control-plane | ✅ | ❌ | ✅ |
| `user_session`, `email_verification`, `password_reset` | Auth | session lifecycle | control-plane | ✅ | ❌ | partial |

Evidence: control-plane reads come from PG in `dashboard.queries.ts:27-183` (orgs/brands/connectors/pixel). Migrations `0001/0064`. **VALID** (Principle 10 + DB ownership).

### 3.2 Connector config & sync control plane
`connector_instance`, `connector_cursor`, `connector_sync_status`, `connectors.connector_sync_run` (`0093`), `connectors.connector_dlq_record` (`0094`), `connectors.connector_razorpay_order_map`, `jobs.resource_backfill_state` (`0111`).
These are **connector config + application state** — explicitly PG-owned. **VALID.**

### 3.3 Transient ingress buffer
`collector_spool` (`0015`, retention `0069`) — durable-ACK buffer Source→spool→Redpanda. Transient/operational per RECON-1. **VALID.**

### 3.4 Billing / financial operational state (LOAD-BEARING)
`billing_plan`, `invoice`, `invoice_line`, `credit_note`, `invoice_number_counter`, `credit_note_number_counter`, `gmv_meter_snapshot` (`0040`), `tax_ledger` (`0078` partitioned). Billing is operational under V4 → stays in PG. **VALID.**

> ⚠️ **HIGH-RISK — stakeholder sign-off (Finance/Billing):** `tax_ledger` + `invoice`/`credit_note` + `gmv_meter_snapshot` are revenue/tax-compliance load-bearing. They **stay in PG**, but any schema change is mis-invoicing / GST-mis-split risk. Do not touch without finance ratification.

### 3.5 ML lifecycle config
`ml.model_registry` (`0083`, retained by `0103`) — model lifecycle/versioning/stage-promotion **config** (not the prediction stream). **VALID** (operational config).

### 3.6 Compliance vault + WORM audit (ADR-0004 exceptions — deliberately PG)
`consent_record`, `consent_tombstone` (`0033`), `contact_pii` (AES-256-GCM envelope, `0037`), `audit.identity_audit`, `audit.send_log` (`0033`), `brand_keyring`, `tenancy.brand_identity_salt` (`0109`).

> ⚠️ **HIGH-RISK — do NOT sweep out as "customer history":** these are DPDP/WORM compliance data deliberately retained in PG per ADR-0004. `contact_pii` holds `SELECT`/`INSERT` only (no `DELETE`); hard-delete is via `SECURITY DEFINER erase_contact_pii_for_customer` (`0100`). Moving them is a compliance regression. **Keep. Requires Security sign-off before any change.**

### 3.7 Pixel config/state
`pixel_installation`, `pixel_status` (`0058` auto-install). Application state. **VALID.**

### 3.8 RLS isolation control (preserve at all costs)
51 `*_isolation` policies under `ENABLE + FORCE` with two-arg fail-closed brand predicates (`0035/0036/0044/0045/0067/0082/0083/0084/0109`), under a `NOBYPASSRLS brain_app` role with per-txn `SET LOCAL ROLE` + `app.current_brand_id` GUC.

> ⚠️ **HIGH-RISK — P0 / Security-VETO surface:** any analytical-table relocation (Section 4) MUST NOT regress an RLS policy. A cross-tenant leak is a P0. **Tenant isolation is non-negotiable; all moves are RLS-regression-gated.**

---

## 4. Residual V4 VIOLATIONS — analytical / AI data still in PostgreSQL

These are the live, actionable ownership violations. Each is non-operational data sitting in PG.

| # | Table | What it stores | V4 verdict | Why it violates V4 | Target home |
|---|---|---|---|---|---|
| DB-01 | `audit.dq_check_result` (`0035`, partitioned `0072`) | data-quality check-outcome stream, append-only | **REMOVE from PG** | analytics (DQ results) — V4 says analytics never in PG | Spark-built → Iceberg, served via StarRocks `mv_*` |
| DB-02 | `ai_config.ai_provenance` (`0036`) | AI Ask-Brain answer provenance (redacted) | **REFACTOR / RATIFY** | AI output is runtime under V4 and not permanently stored | Decision: stop persisting, OR ratify as an audit-ledger exception (preserve redact-before-store) |
| DB-03 | `ai_config.recommendation_outcome` (`0045`) | system measurement of recommendation effectiveness | **REMOVE/REFACTOR** | analytics/recommendation measurement — not one of the 4 allowed decision tables | runtime measurement; if persisted, only as `decision_outcome` |
| DB-04 | `ai_config.recommendation` + `ai_config.recommendation_action` (`0044/0082`) | recommendation state + action ledger | **REFACTOR (rename, narrow)** | these MAY remain ONLY as decision-loop state (`recommendation_history`/`decision_history`), NOT as computed recs | rename to allowed names; ensure they hold loop state, not computation |
| DB-05 | `audit.decision_log` (`0044`, partitioned `0076`) | decision log | **REFACTOR (rename)** | allowed only as `decision_history`/`decision_outcome` | rename + confirm it stores outcomes, not computation |

### 4.1 Dangling compute-in-PG seams (obsolete SQL functions)
`rto_risk_signal_for_brand` and `realization_signal_for_brand` are SQL functions that computed **business signals** over the now-dropped revenue ledger. With `realized_revenue_ledger` dropped (`0098`), these are **dangling / obsolete**. Related: `cm2_signal_for_brand` (`0056`), `realized_gmv_for_period` (`0043`).

**Verdict: DEPRECATED — drop.** Business-signal computation belongs in Spark→Iceberg Gold, never in a PG `SECURITY DEFINER` function. Several drop migrations already left `SECURITY DEFINER`/signal functions referencing dropped tables — these must be cleaned up (see `05-migration-audit.md`).

> ⚠️ **HIGH-RISK — blocked-on-Spark:** DB-01…DB-04 cannot be completed PG-side alone. They are actively written by stream-worker (`dq` job) and core today, and there is **NO Spark Silver/Gold job and ZERO `mv_*`** to receive them (RECON-1). Removal/move is **gated on the larger compute-to-Spark + StarRocks-MV migration**. Cutting them before the lakehouse replacement is live causes read-path 500s and DQ/recommendation blanking. **Relocate-then-cutover only; requires architecture sign-off.**

---

## 5. DDD / 3NF / SSOT / referential-integrity assessment

### 5.1 Domain-Driven Design — STRONG
The application layer is cleanly bounded: `apps/core/src/modules/` holds **13 bounded contexts** (ai, analytics, attribution, billing, connector, data-quality, frontend-api, identity, job-orchestration, ml, notification, recommendation, workspace-access) with **zero cross-module reaches** into another module's `internal/` (grep clean). The PG schema split (migrations `0063–0066`) mirrors this with operational schemas (`connectors`, `jobs`, `tenancy`, `billing`, `audit`, `ai_config`, `identity`, `consent`, `pixel`, `data_plane`). **Conformant.** The residual issue is *ownership-of-data*, not module structure.

### 5.2 Single Source of Truth — MOSTLY CONFORMANT, with explicit cross-store ownership
| Domain | SSOT under V4 | Current state | Verdict |
|---|---|---|---|
| Identity / `brain_id` | Neo4j | PG identity graph dropped `0101` → Neo4j | ✅ Conformant |
| Raw events (Bronze) | Iceberg | PG `bronze_events` dropped `0070` | ✅ Conformant |
| Revenue truth (Gold) | Iceberg | PG ledger dropped `0098`; **but still computed in TS + served from StarRocks** (upstream, not a PG table issue) | ⚠️ Out-of-PG, not yet in Iceberg |
| Control-plane | PostgreSQL | PG | ✅ Conformant |
| Compliance PII | PG vault (ADR-0004) | `contact_pii` `0037` | ✅ Conformant exception |

PG no longer dual-owns the dropped analytical SoRs — a major SSOT win. The remaining SSOT gap is the residual analytical tables in Section 4.

### 5.3 3NF / canonical modeling — CONFORMANT where it matters
Operational tables are normalized with explicit FKs and covering indexes (`0068`, redundantly `0086`). Money is stored as minor units + `currency_code`. Naming conventions are broadly V4-compliant: tables/columns `snake_case`, events `dot.lower` (`order.created`, `order.live.v1`), migration files numbered.

### 5.4 Referential integrity — CONFORMANT
FK covering indexes added (`0068`); RLS FORCE on parent and partition children (`0084`). Partitioning (`0072–0078`, `0080`) preserves PK + dedup keys. `0089` backfills `brain_id` onto a ledger (now dropped) — illustrates the integrity discipline applied during realignment.

---

## 6. Per-table ownership register (decision-grade summary)

Legend: **V**=Valid (keep), **R**=Refactor, **D**=Deprecated (drop, obsolete), **X**=Remove (relocate to lakehouse).

| Table / object | Owner domain | Layer | Operational? | Analytical? | Canonical? | Verdict |
|---|---|---|---|---|---|---|
| `organization`, `tenancy.brand` | Workspace | control-plane | ✅ | ❌ | ✅ | **V** |
| `app_user`, `membership`, `invite`, `user_session` | Auth/RBAC | control-plane | ✅ | ❌ | partial | **V** |
| `connector_instance`/`_cursor`/`_sync_status` | Connector | control-plane | ✅ | ❌ | ✅ | **V** |
| `connectors.connector_sync_run`/`_dlq_record`/`_razorpay_order_map` | Connector | control-plane | ✅ | ❌ | ✅ | **V** |
| `connectors.connector_webhook_raw_archive` (`0050`) | Connector | control-plane (dedup/idempotency) | ✅ | ❌ | ✅ | **V** ⚠️ |
| `jobs.resource_backfill_state` (`0111`) | Job-orchestration | control-plane | ✅ | ❌ | ❌ | **V** |
| `collector_spool` | Ingress | transient | ✅ | ❌ | ❌ | **V** |
| `billing_plan`/`invoice`/`invoice_line`/`credit_note` | Billing | operational | ✅ | ❌ | ✅ | **V** ⚠️ |
| `gmv_meter_snapshot`, `tax_ledger` | Billing | operational | ✅ | ❌ | ✅ | **V** ⚠️ |
| `ml.model_registry` | ML | operational config | ✅ | ❌ | ✅ | **V** |
| `contact_pii`, `consent_record`, `consent_tombstone` | Compliance | vault (ADR-0004) | ✅ | ❌ | ✅ | **V** ⚠️ |
| `audit.identity_audit`, `audit.send_log` | Compliance/WORM | operational | ✅ | ❌ | ❌ | **V** ⚠️ |
| `brand_keyring`, `tenancy.brand_identity_salt` | Compliance | operational | ✅ | ❌ | ✅ | **V** ⚠️ |
| `pixel_installation`, `pixel_status` | Pixel | operational | ✅ | ❌ | ✅ | **V** |
| `audit.dq_check_result` | Data-quality | **analytical** | ❌ | ✅ | ❌ | **X (DB-01)** ⚠️ |
| `ai_config.ai_provenance` | AI | **AI output** | ❌ | ✅ | ❌ | **R/Ratify (DB-02)** ⚠️ |
| `ai_config.recommendation_outcome` | Recommendation | **analytical** | ❌ | ✅ | ❌ | **X/R (DB-03)** ⚠️ |
| `ai_config.recommendation`, `..recommendation_action` | Recommendation | decision-loop | partial | partial | ❌ | **R — rename (DB-04)** |
| `audit.decision_log` | Decision | decision-loop | partial | partial | ❌ | **R — rename (DB-05)** |
| `rto_risk_signal_for_brand`, `realization_signal_for_brand`, `cm2_signal_for_brand`, `realized_gmv_for_period` (fns) | (legacy compute) | compute-in-PG | ❌ | ✅ | ❌ | **D — drop** |
| `data_plane.bronze_events`, `realized_revenue_ledger`, `attribution_credit_ledger`, PG identity graph, `ml.prediction_log`, `ad_spend_ledger` | (legacy analytical) | — | — | — | — | **already DROPPED ✅** |

⚠️ = load-bearing; see callouts in Sections 3–4 for the required sign-off.

---

## 7. Ratification queue (stakeholder sign-off required)

| Item | Owner to sign off | Why HIGH-RISK |
|---|---|---|
| `tax_ledger` / `invoice` / `credit_note` / `gmv_meter_snapshot` (stay in PG) | Finance / Billing | revenue & GST compliance; mis-invoicing on any schema change |
| `contact_pii` / `consent_record` / `identity_audit` / `send_log` (stay in PG) | Security / Compliance (DPDP) | WORM + PII vault, ADR-0004 deliberate exception |
| All RLS FORCE policies (preserve through DB-01…05 moves) | Security | P0 cross-tenant-leak surface |
| DB-02 `ai_provenance` — persist-as-audit vs stop persisting | Security + Architecture | V4 forbids permanent AI output; needs an explicit ruling |
| DB-01/DB-03 relocation timing | Architecture / Data Eng | blocked on Spark Silver/Gold + StarRocks `mv_*` not yet built; premature removal = read 500s + DQ blanking |
| `connector_webhook_raw_archive` (if ever moved to Bronze) | Data Eng | underpins `body_sha256` dedup; mis-move → duplicate order processing |

---

## 8. Bottom line

PostgreSQL is **~90% V4-conformant**: the prior medallion realignment already removed Bronze, revenue, attribution, identity-graph, ML-prediction, and ad-spend from PG. DDD boundaries, RLS isolation, SSOT direction, and the ADR-0004 compliance vault are sound and must be preserved. The **only** ownership violations left are five analytical/AI tables (DB-01…DB-05) plus dangling compute functions — and **none of them can be safely removed until Spark builds Silver/Gold into Iceberg and StarRocks `mv_*` serving exists** (see `01`/`03`/`05` of this bundle). Sequence: build the lakehouse replacement → parity-verify → relocate-then-cutover → drop from PG, never delete first.
