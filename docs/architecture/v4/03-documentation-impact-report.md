# 03 — Documentation Impact Report (Brain V4)

**Status:** Decision-grade audit deliverable
**Scope:** For each of the 12 canonical V4 doc sections (01..12), the **exact** changes required so the documentation matches the OFFICIAL V4 architecture and the verified code reality.
**Rule of adjudication:** ARCHITECTURE WINS. Where today's docs/code describe dbt-builds-Gold or StarRocks-owns-Gold, the **docs must be rewritten to the V4 target** and the gap recorded as a migration item, not normalized as steady-state.
**Evidence base:** validated audit bundle (RECON-1 + 8 workstream audits).

> ⚠️ **HIGH-RISK** marks doc changes that ratify load-bearing architecture (revenue/attribution/identity/isolation) and need stakeholder sign-off.

**How to read each entry:** the canonical V4 statement → what current docs/code assert that contradicts it (evidence) → the exact doc edits required → migration note.

---

## Doc 01 — Core Principles & Canonical Data-Flow

**V4 statement:** Sources → Collector/Connector → Redpanda → Iceberg Bronze → **Spark** → Iceberg Silver → **Spark** → Iceberg Gold → StarRocks `mv_*` (serving only) → Redis → Features/AI/Decision → APIs → UI. Spark is the ONLY compute; dbt REMOVED; Gold-in-Iceberg; PG operational-only; Neo4j identity; Medallion compulsory.

**Contradicts (evidence):** docs/code present `Iceberg → dbt → StarRocks` as the canonical one-way pipeline (`db/starrocks/external_iceberg_catalog.sql:3`); Spark builds Bronze only (4 jobs, zero Silver/Gold); Gold stored in StarRocks base tables; zero `mv_*`.

**Exact doc changes:**
- Replace any "Iceberg → dbt → StarRocks" pipeline diagram with the V4 chain above; state **Spark is the sole compute engine** and **dbt is REMOVED**.
- Add the **12-principle conformance scorecard** (see report 01 §4): 4 conformant / 4 partial / 4 violated, with the violations traced to one compute-and-storage inversion.
- Document the four conformant spine elements as the migration foundation (Collector, Spark Bronze, Neo4j, consumer-UI).
- Record the **topic-taxonomy decision** ⚠️: unified-envelope `collector.event.v1` (+ `order.backfill.v1`) vs per-source topics — ratify which is V4-compliant before any change.

---

## Doc 02 — Medallion & Canonical Data Model (Bronze/Silver/Gold)

**V4 statement:** Bronze = raw truth (Iceberg, replayable); Silver = canonical entities (Spark-built, Iceberg); Gold = business truth (Spark-built, **Iceberg**). One canonical entity per concept, brand_id-leading, money in minor-units + currency_code, additive/deterministic, single source of truth.

**Contradicts (evidence):** Silver+Gold built by dbt (~30 models) materialized as StarRocks `brain_silver`/`brain_gold` tables; `silver_journey_stitch` + `silver_customer_identity` built by TS jobs; canonical-entity **gaps** — no standalone Silver `payment`, `settlement`, `campaign`, `journey` (entity vs touchpoint grain), `identity_alias` (only a Neo4j-export projection). A transition JDBC PG source path persists (`ledger_source=pg` default).

**Exact doc changes:**
- State **Bronze is Iceberg-only** and is the conformant hop (idempotent MERGE on `(brand_id,event_id)`); keep the Silver modeling discipline (per-entity, brand_id-leading, minor-units+currency, additive, ADR-0004) but reassign the **builder from dbt/TS to Spark** and the **store from StarRocks to Iceberg**.
- Add the **missing canonical entities** (payment, settlement, campaign, journey, identity_alias) as required net-new Silver modeling, with their downstream Gold/attribution re-point.
- Document that **Silver must read Iceberg Bronze, never PG** — the `ledger_source=pg` JDBC source path is a transition artifact to retire ⚠️ (Bronze-completeness must be proven first).
- Reclassify StarRocks `brain_silver`/`brain_gold` tables to `mv_*` serving over Iceberg Gold.

---

## Doc 03 — Repository Structure & Module Boundaries / Ownership of Computation

**V4 statement:** Spark calculates, StarRocks serves, APIs expose, UI renders. Business truth (attribution/CM2/LTV/revenue/CAC/recs) is NOT computed in app code. DDD bounded contexts.

**Contradicts (evidence):** DDD boundaries are **clean** (13 contexts, zero cross-internal reaches) — keep. But business truth is computed in TS (`@brain/metric-engine` ~73 files, `@brain/attribution-writer`, core/stream-worker jobs); dead `@brain/identity-graph`; 125 PascalCase `.ts` files violate kebab-case; stale comment `stream-worker/main.ts:155` (PG-Bronze "ENABLED" vs config default `false`).

**Exact doc changes:**
- Affirm DDD bounded-context discipline as conformant.
- Document the **ownership rule explicitly**: no business-truth computation in Node apps; `metric-engine` becomes a thin serve/read seam over `mv_*`; `attribution-writer` math moves to Spark.
- List housekeeping: **remove** `@brain/identity-graph`; **rename** 125 PascalCase files to kebab-case (`customer-repository.ts`) per V4 naming; **fix** the stale `main.ts:155` comment.

---

## Doc 04 — Spark Ownership / dbt-Removal / Bronze-Silver-Gold path / Redpanda topics

**V4 statement:** Spark is the ONLY compute; dbt REMOVED; Bronze→Silver→Gold built entirely by Spark; Gold in Iceberg; StarRocks `mv_*` serving only.

**Contradicts (evidence):** only 4 Spark jobs (Bronze-only); dbt is the live, ArgoCD-deployed compute engine (`recognition-refresh` → `+gold_revenue_ledger`, `attribution-gold-refresh` → `gold_marketing_attribution gold_attribution_paths`); all Gold materialized as StarRocks tables; zero `mv_*`; non-additive truth (CM2/LTV/attribution credit/recognition) computed in TS.

**Exact doc changes:**
- Rewrite this doc as the **migration spec**: 1:1 Spark replacement table for every `silver_*`/`gold_*` dbt model (see report 02 §4); staging/intermediate views fold into the Spark Bronze→Silver read; dbt-runner image + 2 crons removed **after parity**.
- State the **build-Spark-first, parity-gate, then-remove** ordering; warn that premature dbt removal blanks dashboards.
- Document the **Redpanda topic reality** (unified `collector.event.v1` envelope + `order.backfill.v1` + `m1` control-plane topics) and the open ratification vs the per-source set ⚠️ (No event loss).
- Note `feature_customer_daily` violates "NO permanent feature tables" → drop in favor of runtime/Redis features.

---

## Doc 05 — PostgreSQL / Database Architecture (operational-only)

**V4 statement:** PG stores operational data ONLY (orgs/brands/users/RBAC/settings/workflows/billing/connector config/app state). NEVER in PG: events, analytics, clickstream, customer history, attribution, recommendations. Only allowed decision tables: recommendation_history/decision_history/decision_outcome/user_feedback.

**Contradicts (evidence):** prior realignment already evacuated bronze (0070), revenue (0098), attribution (0099), identity (0101), ml.prediction_log (0103), ad_spend (0105) — document as DONE. **Residual analytical in PG:** `audit.dq_check_result`, `ai_config.ai_provenance`, `ai_config.recommendation_outcome`; decision tables `recommendation`/`recommendation_action`/`audit.decision_log` need rename to the four allowed.

**Exact doc changes:**
- List the **conformant operational PG surface** explicitly (IAM/tenancy, connector config, collector_spool, billing, compliance vault, RLS) as KEEP.
- List the **residual violations** with disposition: `dq_check_result`/`recommendation_outcome` → move to Spark/Iceberg; `ai_provenance` → ratify as audit exception or stop persisting; rename decision tables to `recommendation_history`/`decision_history`/`decision_outcome`/`user_feedback`.
- Record **migration hygiene**: 0085 dead no-op, 0086 duplicates 0068, numbering gap at 0102, dangling SECURITY-DEFINER signal functions referencing dropped tables.
- ⚠️ **HIGH-RISK** doc note: billing (`tax_ledger`/invoice/credit_note/gmv_meter_snapshot), compliance vault (`contact_pii`/`consent_record`/`identity_audit`/`send_log`, ADR-0004), and **all RLS FORCE policies** STAY in PG and must not be swept out as "customer history" — touching them is a finance/compliance/P0-isolation risk.

---

## Doc 06 — Platform / Infra & Runtime (Redpanda/Iceberg/Spark/StarRocks/Redis/Neo4j, CI/CD, observability)

**V4 statement:** Gold-in-Iceberg; StarRocks serves `mv_*`; Spark the only compute; Redis runtime; Neo4j identity. Observability covers the business-critical hops.

**Contradicts (evidence):** Terraform `s3-iceberg/main.tf` provisions **only** Bronze bucket + Bronze Glue DB — no Iceberg Silver/Gold storage or Spark write role; Gold-in-Iceberg not deployable. No `mv_*`. dbt is CI-built/signed/ArgoCD-deployed compute. No Spark/StarRocks/Gold-freshness telemetry (blind spot).

**Exact doc changes:**
- Document the **conformant infra posture** (Redpanda→Iceberg-Bronze sole SoR; Redis all-TTL; Neo4j identity store; OTel→Prometheus/Loki/Tempo/Grafana with SLO/burn/DLQ/lag/freshness; signed+digest-pinned images; Helm fail-close on unpinned; ArgoCD prune+selfHeal; Bronze compaction + 24-month snapshot TTL + crypto-shred; cron concurrency=Forbid + podGC).
- Add **provisioning gap as a blocker**: Terraform must add Iceberg **Silver+Gold** buckets, Glue catalogs, Spark write role before Gold-in-Iceberg.
- Add **observability extension**: Spark/StarRocks/Iceberg-Gold-freshness SLOs for the future Spark Gold pipeline.
- Record the **dbt-cron removal** (recognition-refresh + attribution-gold-refresh) as post-parity infra work ⚠️.

---

## Doc 07 — Security & Compliance Architecture

**V4 statement:** Tenant isolation at every layer; PG operational-only; Neo4j identity; AI output not permanently stored; Gold replayable/auditable in Iceberg; no-mock.

**Contradicts (evidence):** isolation spine strong (Kafka partition key `${brandId}:${eventId}`; Iceberg `bucket(256,brand_id)`; Redis tenant-prefixed; PG RLS FORCE under NOBYPASSRLS; per-brand secrets; PII vault; NLQ redacted-only). **Violations:** Neo4j isolation is **app-layer-only, no RLS** (P0); `ai_provenance` permanently persists AI output; attribution Gold owned/served by StarRocks (integrity/auditability control, not just placement); dormant `BronzeRepository` PG-Bronze latent raw-PII escape.

**Exact doc changes:**
- Affirm the conformant isolation/PII controls (RLS, partition keys, secrets, redaction, cross-tenant pixel guard, consumer-only UI).
- ⚠️ **HIGH-RISK SEC-01:** document Neo4j's **no-RLS** gap and mandate an **enforced Cypher query-guard** (a missing `brand_id` predicate is a P0 cross-tenant PII leak with no DB backstop).
- ⚠️ **SEC-02:** classify `ai_provenance` — ratify as a redact-before-store audit-ledger exception or stop persisting.
- ⚠️ **SEC-03:** record attribution Gold relocation to replayable Iceberg+Spark as an integrity/audit control with parity+replay verification.
- ⚠️ **SEC-06:** mandate **removal** of the dormant `BronzeRepository` PG-Bronze path (latent raw-PII-in-PG, one env flag away).

---

## Doc 08 — Frontend (apps/web) — UI consumer-only

**V4 statement:** UI never queries Iceberg/StarRocks/PG; never computes business metrics (attribution/CM2/LTV); no mocks; empty state never faked; money in minor-units. Architecture change → API change → UI change.

**Contradicts (evidence):** apps/web is **overwhelmingly conformant** (BFF-only, no lakehouse access, honest empty states, server-driven+badged synthetic data, money via `formatMoneyDisplay`). Residual: narrow client-side rate calcs (FE-01 RTO rate, FE-03 tax ×100) and the FE-02 margin cost-input transform/confidence write path.

**Exact doc changes:**
- Document apps/web as the **reference consumer** (no business compute, honest empty-state, money discipline, no mocks).
- ⚠️ **FE-02:** record that the percent→basis-points conversion + UI-pinned `cost_confidence:'Trusted'` must move server-side (feeds CM2 + billing cap) — ratify API contract first.
- FE-01/FE-03: move display-only rate calcs server-side.
- Note the **stable-DTO decoupling**: the upstream Spark/Iceberg/MV refactor should be near-zero UI impact, but confirm client-supplied date-window literals survive MV-served aggregates.

---

## Doc 09 — Identity (Neo4j) & Journey/Attribution Join Spine

**V4 statement:** Neo4j owns brain_id, identity graph, relationships, confidence, merge/unmerge.

**Contradicts (evidence):** Neo4j is correctly the identity SoR (`Neo4jIdentityRepository.ts`; PG identity graph dropped 0101). But identity **Silver projections** (`silver_customer_identity`, `journey-stitch`, `identity_alias`) are materialized **Neo4j→StarRocks by TS jobs**, not Spark; Neo4j has **no RLS**.

**Exact doc changes:**
- Affirm Neo4j as identity SoR; document the brain_id resolution path and replay-safe MERGE.
- Reassign identity/journey Silver materialization from **TS jobs to Spark→Iceberg** ⚠️ (preserve brain_id parity, tenant isolation, GDPR erasure).
- Add the **app-layer-isolation caveat** (no Neo4j RLS) and the required enforced query-guard.

---

## Doc 10 — AI Runtime

**V4 statement:** AI consumes Gold/MVs/features; outputs (summaries/explanations/insights) are NOT permanently stored.

**Contradicts (evidence):** `ai_config.ai_provenance` permanently persists AI answer provenance in PG (redacted-only; raw question never stored, 0036).

**Exact doc changes:**
- State AI is runtime and consumes Gold/MV/features (which must originate from Spark→Iceberg Gold via `mv_*`, not the current TS/StarRocks tier).
- ⚠️ Document the `ai_provenance` persistence decision: ratify as a redact-before-store audit exception or remove the permanent store; preserve the redact-before-store guarantee.

---

## Doc 11 — Decision Engine Runtime

**V4 statement:** Decision consumes features/metrics/signals/confidence; outputs runtime. Only store: recommendation_history, decision_history, decision_outcome, user_feedback.

**Contradicts (evidence):** recommendations computed in app code (`recommendation-detectors.ts`, `generate-recommendations.ts`, `measure-recommendation-outcomes.ts`); PG holds `recommendation`, `recommendation_action`, `recommendation_outcome`, `decision_log` (analytics/measurement, not just decision-loop state).

**Exact doc changes:**
- State the Decision Engine is runtime over features/metrics/signals/confidence; recommendation **computation** moves out of app code.
- Document the table rename/REFACTOR: keep only `recommendation_history`/`decision_history`/`decision_outcome`/`user_feedback` in PG; move `recommendation_outcome` measurement analytics to the lakehouse.

---

## Doc 12 — Naming, DB Principles & Future Assumptions

**V4 statement:** files kebab-case, classes PascalCase, functions camelCase, tables/columns snake_case, events dot.lower, APIs REST. DDD/3NF/referential-integrity/canonical/SSoR/explicit-ownership. Future: Spark-only compute; dbt REMOVED; Gold-in-Iceberg; StarRocks `mv_*` serving; Redis runtime features; AI/Decision runtime; PG operational-only; Neo4j identity; NO permanent feature tables.

**Contradicts (evidence):** naming broadly conformant (snake_case tables/columns, dot.lower events like `order.live.v1`/`shopflo.checkout_abandoned.v1`) — **except 125 PascalCase `.ts` files** violating kebab-case. Future assumptions: **dbt-REMOVED is NOT met** (live compute engine); **Gold-in-Iceberg NOT met** (StarRocks tables); **NO-permanent-feature-tables NOT met** (`feature_customer_daily`).

**Exact doc changes:**
- Confirm conformant naming (snake_case, dot.lower events); add the **file-naming remediation** (125 PascalCase `.ts` → kebab-case).
- Restate the **future assumptions as not-yet-met** with status: dbt-REMOVED ❌, Gold-in-Iceberg ❌, no-permanent-feature-tables ❌ (`feature_customer_daily` drop), StarRocks-`mv_*`-only ❌ — each tied to the migration program in report 01 §6.
- Affirm DB principles (every table answers owner/why/layer/operational?/analytical?/canonical?) and apply them to the residual-PG decision.

---

## Cross-cutting documentation directive

Every doc above must be rewritten to the **V4 target state**, with the current dbt/StarRocks/TS-compute reality recorded as a **migration item, not steady-state**. The single root cause threaded through docs 01–12 is the **compute-and-storage inversion** (compute in dbt+TS, Gold in StarRocks/PG). All revenue/attribution/identity doc changes carry a ⚠️ HIGH-RISK sign-off requirement and a **parity-gate-before-cutover** clause.
