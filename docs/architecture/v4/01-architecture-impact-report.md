# 01 — Architecture Impact Report (Brain V4)

**Status:** Decision-grade audit deliverable
**Scope:** Current implemented architecture vs. the OFFICIAL Brain V4 architecture (the final source of truth).
**Rule of adjudication:** When code / migrations / dbt / UI / APIs disagree with the V4 architecture, **ARCHITECTURE WINS.**
**Evidence base:** the validated audit bundle (8 workstream audits + RECON-1). Every claim below cites a path/line or a workstream finding.

> ⚠️ **HIGH-RISK** callouts mark load-bearing changes (revenue, attribution, billing, tenant isolation, identity/PII) that require explicit stakeholder sign-off **before** execution.

---

## 1. Executive summary

The V4 target chain is:

```
Sources → Collector/Connector → Redpanda → Iceberg Bronze → Spark → Iceberg Silver
        → Spark → Iceberg Gold → StarRocks MVs (serving only) → Redis → Features/AI/Decision → APIs → UI
```

with twelve core principles: **Spark is the ONLY compute engine; Bronze/Silver/Gold own raw/canonical/business truth; Gold lives in Iceberg; StarRocks serves `mv_*` only; Redis owns runtime state; AI and the Decision Engine are runtime; Dashboards are consumers; PostgreSQL is operational-only; Neo4j owns identity; Medallion is compulsory; dbt is REMOVED.**

The **spine is conceptually correct and the ingress half is genuinely conformant**, but the **compute and serving tiers are an inversion of V4**:

- **Spark builds Bronze ONLY.** Exactly four Spark jobs exist (`db/iceberg/spark/{bronze_materialize,validate_bronze,bronze_maintenance,bronze_parity_check}.py`). **ZERO Spark Silver or Gold jobs exist.** (RECON-1; Principal Data Engineer audit)
- **dbt is the de-facto Silver+Gold compute engine** — ~30–31 models (`db/dbt/models`), CI-built/signed/digest-pinned, and run hourly by Argo CronWorkflows (`infra/helm/cronworkflows/values.yaml`: `recognition-refresh` → `+gold_revenue_ledger`, `attribution-gold-refresh` → `gold_marketing_attribution gold_attribution_paths`). V4 says **dbt is REMOVED**. (Data Engineer + Infra audits)
- **Gold is stored in StarRocks `brain_gold.*` base tables, not Iceberg.** `dbt_project.yml:18` (`marts:{+materialized: table}`), `gold_customer_360.sql` (`schema='brain_gold', materialized='incremental'`). **ZERO `mv_*` materialized views exist anywhere** (grep clean). StarRocks therefore **owns** Gold instead of serving it. (Data Engineer + Infra audits)
- **Business truth is computed in TypeScript** inside the Node apps via `@brain/metric-engine` (~73 files: CM2, realized/provisional revenue recognition, attribution Markov/credit, customer-360, CAC, LTV, ROAS, executive metrics) and `@brain/attribution-writer` (APPENDs to `brain_gold.gold_attribution_credit`, a StarRocks PRIMARY KEY table), driven by core jobs (`attribution-reconcile.ts`). V4 says **Spark calculates, StarRocks serves, APIs expose, UI renders.** (Architect + Staff SWE + Data Engineer audits)
- **Infra is not provisioned for Gold-in-Iceberg.** Terraform `s3-iceberg/main.tf` provisions **only** a Bronze bucket + Bronze Glue DB; there is no Iceberg Silver/Gold bucket, catalog, or Spark write role. Gold-in-Iceberg is not deployable today. (Infra audit)

**Net:** the architectural drift is not a patch — it is a **full re-platform of the transform + serving tiers**, gated by revenue/attribution/identity parity. The four genuinely conformant spine elements (Collector ingress, Spark Bronze hop, Neo4j identity, consumer-only UI) are the foundation to build forward from.

---

## 2. Current vs. V4 target — layer by layer

| Layer | V4 target | Current reality (evidence) | Verdict |
|---|---|---|---|
| **Sources → Redpanda** | Collector/Connector → Redpanda backbone | Collector: Source → HTTP → PG `collector_spool` (transient ACK) → drainer → Redpanda `${env}.collector.event.v1` (`apps/collector/src/main.ts`, `kafka-producer.ts`). Connector re-pull/backfill → Kafka. | **CONFORMANT** (spool is operational/transient) |
| **Iceberg Bronze** | Raw truth, append-only, replayable, in Iceberg | `db/iceberg/spark/bronze_materialize.py`: Redpanda → idempotent **MERGE ... WHEN NOT MATCHED THEN INSERT** on `(brand_id,event_id)`; no UPDATE/DELETE. PG `bronze_events` dropped (0070); dormant `BronzeRepository` PG path default-OFF. | **CONFORMANT** (one fully-conformant medallion hop); ⚠️ remove dormant PG-Bronze path |
| **Spark → Iceberg Silver** | Spark builds canonical Silver in Iceberg | **No Spark Silver jobs.** Silver built by **dbt** (`silver_*` ~9 models) materialized to StarRocks `brain_silver`; two "Silver" entities (`silver_journey_stitch`, `silver_customer_identity`) built by **TS stream-worker jobs**. | **VIOLATION** |
| **Spark → Iceberg Gold** | Spark builds business truth in Iceberg | **No Spark Gold jobs.** Gold built by **dbt** (`gold_*`, `feature_customer_daily`) + **TS** (`metric-engine`, `attribution-writer`); stored in StarRocks `brain_gold.*` base tables. | **VIOLATION** |
| **StarRocks** | Serving ONLY, `mv_*` over Iceberg Gold | StarRocks **owns** Gold base tables (`gold_customer_360`, `gold_revenue_ledger`, `gold_attribution_credit`, …). **Zero `mv_*` views.** One-way `Iceberg→dbt→StarRocks` codified (`db/starrocks/external_iceberg_catalog.sql:3`). | **VIOLATION** |
| **Redis runtime** | Sessions, cache, runtime features/signals, all TTL | Feature-store online store (`FEATURE_TTL_SECONDS=25h` + freshness sentinel), dedup (`SET NX EX` 7d), retry counters (`INCR+EXPIRE` 7d), rate-limiter. No Redis SoR use. | **CONFORMANT** |
| **Features** | Runtime, dynamic, Redis-cached, recomputed; NO permanent feature tables | `feature-materialization` writes Redis (sink correct) but **sources StarRocks Gold table**, not Iceberg-Gold-fed MV; `feature_customer_daily` is a **permanent dbt feature table** (forbidden). | **MIXED → REFACTOR** |
| **AI** | Runtime; outputs not permanently stored | `ai_config.ai_provenance` **permanently persists** AI answer provenance in PG (redacted-only). | **VIOLATION** (classify as audit exception or stop) |
| **Decision** | Runtime; only store recommendation_history/decision_history/decision_outcome/user_feedback | Recommendations **computed in TS** (`recommendation-detectors.ts`, `generate-recommendations.ts`); PG holds `recommendation`, `recommendation_action`, `recommendation_outcome`, `decision_log`. | **MIXED → REFACTOR** (rename to allowed ledgers; move compute to runtime) |
| **PostgreSQL** | Operational ONLY (orgs/brands/users/RBAC/billing/connector config/app state) | Bulk of analytical data already evacuated (bronze 0070, revenue 0098, attribution 0099, identity 0101, ml.prediction_log 0103, ad_spend 0105). Residual analytical: `dq_check_result`, `ai_provenance`, `recommendation_outcome`. | **MOSTLY CONFORMANT** (residual REFACTOR) |
| **Neo4j** | Owns identity (brain_id, graph, confidence, merge/unmerge) | `Neo4jIdentityRepository.ts`: brain_id graph, idempotent MERGE, replay-safe. | **CONFORMANT** (but app-layer-only isolation — see risk SEC-01) |
| **UI** | Consumer only; never queries lakehouse; never computes business metrics | `apps/web`: BFF-only (`lib/api/client.ts`), no Iceberg/StarRocks/PG queries (grep clean), honest empty states, money via `formatMoneyDisplay`. Narrow client-side rate calcs remain. | **CONFORMANT** (narrow display-calc cleanups) |

---

## 3. The drift, named

There is a **single root cause** with three surfaces:

1. **Compute is in the wrong engines.** Silver/Gold are built by **dbt (SQL) + TypeScript (`metric-engine`/`attribution-writer`)** instead of Spark. V4 requires Spark as the only compute engine.
2. **Gold is in the wrong store.** Business truth lives in **StarRocks base tables** (and residually PG ledgers) instead of **Iceberg**, and StarRocks has **no `mv_*` serving layer**.
3. **Identity/feature/dq Silver is built by app code.** `journey-stitch`, `identity-export`, `dq`, and `feature-materialization` jobs perform canonical/analytical computation in TS instead of Spark.

Everything else (the ~30 dbt models, the ~73 metric-engine modules, the PG analytical ledgers, the topic taxonomy question) is a consequence of these three.

### 3.1 Topic taxonomy divergence (ratification required)

V4's flow names per-source topics (pixel.events, shopify.orders, … identity.events). Brain uses a **unified envelope** `collector.event.v1` (+ `order.backfill.v1` lane) carrying all source events with an `event_name` discriminant, plus separate `m1` control-plane domain topics (`user.registered.v1`, …). This is a **deliberate, working** design (server-trusted bronze sets, backfill-lane isolation preserved into Bronze). **Decision needed:** ratify the unified-envelope taxonomy as V4-compliant, or re-partition into per-source topics (touches every producer + the Bronze consumer — "No event loss" risk).

---

## 4. The 12-principle conformance scorecard

| # | V4 Principle | Verdict | Evidence / note |
|---|---|---|---|
| 1 | **Spark is the ONLY computation engine** | ❌ **VIOLATED** | Spark builds Bronze only (4 jobs); Silver/Gold computed by dbt (~30 models) + TS metric-engine (~73 files) + app jobs. ZERO Spark Silver/Gold jobs. |
| 2 | **Bronze owns raw truth** | ✅ **CONFORMANT** | `bronze_materialize.py` idempotent MERGE INSERT-only on `(brand_id,event_id)`; PG `bronze_events` dropped (0070). |
| 3 | **Silver owns canonical truth** | ⚠️ **PARTIAL** | Silver entities well-modeled (per-entity, brand_id-leading, minor-units+currency, additive/deterministic, ADR-0004) **but built by dbt+TS, stored in StarRocks**, not Spark→Iceberg. Canonical-entity gaps: payment, settlement, campaign, journey-entity, identity_alias. |
| 4 | **Gold owns business truth** | ❌ **VIOLATED** | Gold computed by dbt+TS, stored in **StarRocks base tables** (and residual PG ledgers), not Iceberg. |
| 5 | **StarRocks owns serving ONLY (`mv_*`)** | ❌ **VIOLATED** | StarRocks owns Gold base tables (`gold_customer_360`, `gold_attribution_credit`, `gold_revenue_ledger`). **Zero `mv_*` views exist.** |
| 6 | **Redis owns runtime state** | ✅ **CONFORMANT** | All keys TTL'd, tenant-prefixed; feature-store/dedup/retry/rate-limit; no SoR use. |
| 7 | **AI is runtime** | ❌ **VIOLATED** | `ai_config.ai_provenance` permanently persists AI output in PG (redacted-only). |
| 8 | **Decision Engine is runtime** | ⚠️ **PARTIAL** | Recommendations computed in TS; PG holds `recommendation`/`recommendation_action`/`recommendation_outcome`/`decision_log` — only the four allowed decision ledgers may remain (rename/REFACTOR). |
| 9 | **Dashboards are consumers** | ✅ **CONFORMANT** | `apps/web` BFF-only, no lakehouse access, honest empty states, no mocks. (Upstream caveat: DTOs originate from a non-V4 compute tier.) |
| 10 | **PostgreSQL stores OPERATIONAL data ONLY** | ⚠️ **PARTIAL** | Bulk evacuated (0070/0098/0099/0101/0103/0105). Residual analytical: `dq_check_result`, `ai_provenance`, `recommendation_outcome`. |
| 11 | **Neo4j owns identity** | ✅ **CONFORMANT** | `Neo4jIdentityRepository.ts` is identity SoR; PG identity graph dropped (0101). (Isolation is app-layer-only — P0 risk SEC-01.) |
| 12 | **Medallion is compulsory** | ⚠️ **PARTIAL** | Bronze hop conformant; Silver/Gold hops built by wrong engines and stored in wrong layer. Medallion exists but is mis-homed above Bronze. |

**Scorecard tally:** 4 conformant · 4 partial · 4 violated. The four violations and the Silver/Gold partials all collapse onto the **single compute-and-storage inversion** described in §3.

**dbt-REMOVED future assumption:** ❌ not met — dbt is the live, ArgoCD-deployed compute engine.

---

## 5. Conformant foundation (do NOT regress)

These are verified-conformant and are the load-bearing base for the migration:

1. **Collector ingress** — Source → PG `collector_spool` (transient) → Redpanda (`apps/collector/src/main.ts`, `kafka-producer.ts`).
2. **Spark Bronze hop** — idempotent MERGE INSERT-only into Iceberg Bronze on `(brand_id,event_id)`, partition `bucket(256,brand_id)+days(occurred_at)`; backfill lane consumed (`order.backfill.v1`); server-trusted/ledger-only admission sets mirror stream-worker.
3. **Neo4j identity SoR** — `Neo4jIdentityRepository.ts`, idempotent replay-safe MERGE.
4. **Redis runtime discipline** — every key TTL'd + tenant-prefixed; no SoR use.
5. **Consumer-only UI** — BFF-only, no lakehouse access, honest empty states, money in minor-units, no mocks.
6. **Tenant isolation spine** — Kafka partition key `${brandId}:${eventId}`; Iceberg `bucket(256,brand_id)`; Redis tenant-prefixed keys; PG RLS FORCE under NOBYPASSRLS `brain_app` with per-txn `SET LOCAL ROLE` + `app.current_brand_id`.
7. **Observability + supply chain** — OTel→Prometheus/Loki/Tempo/Grafana, SLO/burn-rate/DLQ/lag/freshness alerts; images signed + digest-pinned, Helm fail-closes on unpinned/`:latest`.

---

## 6. Required migration program (sequenced)

The cutover must be **build-Spark-first, parity-gate, then remove dbt/TS-compute**. Premature dbt removal blanks every dashboard.

| Phase | Action | Gate |
|---|---|---|
| **0. Provision** | Terraform: add Iceberg **Silver + Gold** buckets, Glue catalogs, Spark write role. Today only Bronze exists. | Infra deployable for Gold-in-Iceberg |
| **1. Spark Silver** | Reimplement ~9 `silver_*` dbt models + the two TS-built Silver entities (`journey_stitch`, `customer_identity`) as Spark→Iceberg jobs. Add missing canonical entities (payment, settlement, campaign, journey, identity_alias). | Silver parity vs dbt output |
| **2. Spark Gold** | Reimplement ~11 `gold_*` dbt models + `metric-engine` CM2/revenue/attribution/CAC/LTV/ROAS + `attribution-writer` Markov/credit math as Spark→**Iceberg Gold**. ⚠️ **byte/minor-unit parity oracle** required. | Revenue/attribution Σ parity |
| **3. StarRocks MVs** | Replace `brain_gold.*` base tables with `mv_*` materialized views over Iceberg Gold. | Serving parity |
| **4. Repoint read seam** | `metric-engine` becomes a thin **serve/read** seam over `mv_*`; UI DTO shapes unchanged (near-zero UI impact). | DTO-shape stability |
| **5. Retire** | Remove dbt-runner image + 2 gold-producing crons; remove the dormant PG-Bronze path; relocate residual PG analytical ledgers (`dq_check_result`, `ai_provenance`, `recommendation_outcome`); rename decision tables to the four allowed. | All reads off dbt/PG-analytical |

---

## 7. ⚠️ HIGH-RISK changes requiring stakeholder sign-off

> ⚠️ **HIGH-RISK — REVENUE / BILLING.** `gold_revenue_ledger` (recognition basis, **read by billing**) is produced by the live dbt `recognition-refresh` cron; CM2 / realized-revenue are computed in TS. Removing dbt or relocating compute **before** a Spark→Iceberg revenue ledger is live and **parity-proven (exact minor-unit Σ oracle)** zeros out revenue serving. **RATIFY + parity-gate before execution.** (Architect ARCH-003/005, Data Eng SPARK-001, Infra)

> ⚠️ **HIGH-RISK — ATTRIBUTION TRUTH.** `gold_attribution_credit` (StarRocks PRIMARY-KEY table) and `gold_marketing_attribution`/`gold_attribution_paths` are the attribution SoR, computed in TS (`attribution-reconcile`, Markov/position-based) + dbt. Re-homing compute to Spark and storage to Iceberg must **preserve byte-exact money math (largest-remainder credit, recognition rule)** under a parity oracle. **RATIFY before execution.** (Architect ARCH-004/006, SEC-03)

> ⚠️ **HIGH-RISK — IDENTITY / COMPLIANCE.** `journey-stitch` + `identity_alias` projections carry hashed PII and are the brain_id join spine for all customer/revenue/attribution analytics. **Neo4j has NO RLS** — isolation is app-layer-only; a missing `brand_id` Cypher predicate is a **P0 cross-tenant PII leak with no DB backstop.** Re-platforming to Spark→Iceberg must preserve tenant isolation, GDPR erasure, and current identity parity, and an **enforced Cypher query-guard** is required. **RATIFY with Security/compliance.** (Data Architecture DATA-03/09, SEC-01)

> ⚠️ **HIGH-RISK — SOURCE CUTOVER / EVENT LOSS.** Silver defaults to reading PG via JDBC (`ledger_source=pg`). Flipping the SoR to Iceberg-built Spark Gold must be **parity-verified and Bronze-completeness-proven first** (Bronze today is largely `order.live.v1` + `spend.live.v1`); cutting the PG analytical path early **drops revenue/spend data**. The unified-topic re-partition question (if pursued) touches every producer — "No event loss." **RATIFY topic taxonomy + Bronze completeness before any cutover.** (Data Eng SPARK-007/015)

> ⚠️ **HIGH-RISK — PG ANALYTICAL-LEDGER REMOVAL.** `dq_check_result`/`recommendation_action` are read by live routes (`attribution.routes.ts` referenced PG Gold historically); dropping them risks read-path 500s. **Relocate-then-cutover**; preserve the four allowed decision ledgers (`recommendation_history`/`decision_history`/`decision_outcome`/`user_feedback`). DB-side removal is **blocked on** the Spark Silver/Gold + StarRocks MV build existing first. (Architect ARCH-009, DB audit DB-01..03)

---

## 8. Bottom line

V4 is **architecturally sound and the spine is already half-built**. The work is concentrated, not diffuse: **one inversion** (compute in dbt+TS, Gold in StarRocks/PG) drives nearly every violation. The migration is large and revenue/identity-load-bearing, so it must be executed **Spark-first, parity-gated, store-then-cutover** — never as a big-bang dbt deletion.
