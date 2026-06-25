# 02 — Repository Impact Report (Brain V4)

**Status:** Decision-grade audit deliverable
**Scope:** Per app / package / module / infra surface — disposition (**KEEP / REFACTOR / DEPRECATE / REMOVE**) and explicit **wrong-ownership** flags against the V4 architecture.
**Rule of adjudication:** ARCHITECTURE WINS over code/migrations/UI/APIs.
**Evidence base:** validated audit bundle (RECON-1 + 8 workstream audits).

> ⚠️ **HIGH-RISK** = revenue / attribution / billing / identity / tenant-isolation load-bearing; requires sign-off before change.

**Disposition legend**
- **KEEP** — V4-conformant as-is (guard against regression).
- **REFACTOR** — survives, but ownership/compute/storage must move (most of the work).
- **DEPRECATE** — superseded once the Spark/Iceberg/MV target is live; remove after parity.
- **REMOVE** — must be deleted (contradicts V4 with no replacement role).

---

## 1. Disposition summary

| Surface | Disposition | Why (one line) |
|---|---|---|
| `apps/collector` | **KEEP** | Source→PG-spool(transient)→Redpanda; V4-conformant ingress |
| `apps/web` | **KEEP** (narrow REFACTOR) | Pure BFF consumer; move 2–3 display-only client calcs server-side |
| `apps/stream-worker` (consumers/bridges/identity) | **KEEP** | Redpanda consume, connector bridges, Neo4j identity write |
| `apps/stream-worker` (compute jobs) | **REFACTOR** | journey-stitch / identity-export / dq / feature-materialization = Spark's job |
| `apps/stream-worker/.../pg/BronzeRepository.ts` | **REMOVE** | Dormant PG-Bronze escape hatch; raw-PII-in-PG latent risk |
| `apps/core` (frontend-api/BFF reads) | **REFACTOR** | Control-plane reads KEEP; analytics read seam must point at `mv_*` |
| `apps/core/src/jobs/attribution-reconcile.ts` | **REFACTOR** ⚠️ | Attribution computed in TS, written to StarRocks Gold |
| `apps/core/.../recommendation-*` jobs | **REFACTOR** | Recs computed in app code; Decision must be runtime |
| `packages/metric-engine` (~73 files) | **REFACTOR** | Business truth in TS → Spark; package becomes thin serve seam |
| `packages/attribution-writer` | **REFACTOR** ⚠️ | Computes + writes Gold to StarRocks; move to Spark→Iceberg |
| `packages/feature-store` | **REFACTOR** | Redis sink KEEP; source must be Iceberg-Gold-fed MV |
| `packages/connector-secrets`, `packages/events`, `packages/tenant-context`, `packages/db`, `packages/config` | **KEEP** | Conformant operational/isolation plumbing |
| `packages/identity-graph` | **REMOVE** | Dead package, imported nowhere |
| `db/iceberg/spark` (4 Bronze jobs) | **KEEP** + **EXTEND** | Conformant Bronze; add Spark Silver/Gold jobs (net-new) |
| `db/dbt` (entire layer) | **DEPRECATE → REMOVE** ⚠️ | dbt is REMOVED in V4; ~30 models reimplemented in Spark |
| `db/starrocks` (catalog + base tables) | **REFACTOR** | Base Gold tables → `mv_*` over Iceberg Gold |
| `db/migrations` (residual analytical) | **REFACTOR/REMOVE** | `dq_check_result`, `ai_provenance`, `recommendation_outcome` leave PG |
| `infra/helm/cronworkflows` (dbt crons) | **REMOVE** (after parity) | recognition-refresh + attribution-gold-refresh dbt steps |
| `infra/terraform/s3-iceberg` | **REFACTOR/EXTEND** | Provision Iceberg Silver+Gold buckets/catalog/write role |
| `infra/observe` | **KEEP** + **EXTEND** | Add Spark/StarRocks/Gold-freshness SLOs |

---

## 2. Apps

### `apps/collector` — **KEEP**
- **Flow:** Source → HTTP pixel/server events → PG `collector_spool` (durable ACK buffer, transient) → drainer → Redpanda `${env}.collector.event.v1` (`main.ts`, `kafka-producer.ts:95`).
- **Verdict:** V4-conformant. PG spool is operational/transient, allowed. No change.

### `apps/web` — **KEEP** (narrow REFACTOR)
- **Conformant:** BFF-only (`lib/api/client.ts` — "talks ONLY to the frontend-api BFF. Never the DB, never StarRocks, never Postgres directly"); no Iceberg/StarRocks/PG queries (grep clean; only documentation/data_source comments); honest empty states; money via `formatMoneyDisplay(minorString, ccy)` ("never /100"); attribution/CM2/LTV/ROAS read as pre-computed DTO fields, not computed in UI; synthetic dev data is **server-driven + visibly badged** (`SyntheticBadge` gated on API `data_source==='synthetic'`).
- **REFACTOR (narrow, low-risk):**
  - **FE-02** ⚠️ margin cost-input write path: percent→basis-points conversion + UI-pinned `cost_confidence:'Trusted'` feed CM2 and the billing cap. **Move transform + confidence assignment server-side; ratify API contract first** (mis-states margin / can affect billing).
  - **FE-01 / FE-03** display-only client calcs (RTO high-risk rate; tax rate ×100) → serve pre-computed.
  - Confirm hardcoded date-window literals (last-90/35/30-day in `*-content.tsx`) survive the move to MV-served aggregates.
- **Upstream caveat (not a web defect):** UI DTOs currently originate from the non-V4 compute tier; stable DTO shapes mean the Spark/Iceberg refactor should be near-zero UI impact (V4 "Architecture → API → UI" order).

### `apps/stream-worker`
- **KEEP:**
  - Redpanda consumers + connector bridges (`bronzeBridges.ts`, `EventBronzeBridgeConsumer.ts`) — re-produce onto live topics feeding Bronze via Kafka (not direct PG/Iceberg writes).
  - `Neo4jIdentityRepository.ts` — identity SoR in Neo4j.
  - Connector re-pull/backfill/scheduler/token-refresh/dlq-redrive jobs — connector-runtime orchestration → Kafka.
  - NOBYPASSRLS assertion at startup (`main.ts:116`).
- **REMOVE:**
  - **`infrastructure/pg/BronzeRepository.ts`** ⚠️ — dormant PG-Bronze write, gated default-OFF by `BRONZE_PG_WRITE_ENABLED` (`main.ts:159-162`). Latent **raw-PII-in-PG** escape one env flag away from violating Bronze-in-Iceberg + PG-operational-only (SEC-06). Also fix the **stale comment at `main.ts:155`** claiming PG-Bronze defaults ENABLED (config default is `false`, `packages/config/src/stream-worker.ts:87`).
- **REFACTOR (wrong-ownership — Spark's job, not app code):**
  - `feature-materialization/run.ts` — reads **StarRocks `gold_customer_360`** → writes Redis. **Redis sink KEEP; source must become an Iceberg-Gold-fed `mv_*`.**
  - `journey-stitch-export`, `journey-stitch-from-identity.ts`, `identity-export` — build canonical Silver (identity/journey) in TS; must be **Spark→Iceberg Silver**. ⚠️ identity/PII parity + GDPR.
  - `dq/*` — read Silver, write `dq_check_result` (PG); **Spark-owned in V4; output leaves PG.**
  - `gokwik-rto-predict-emit`, `phone-guard-reeval`, `partition-maintenance` — app-code/PG-partition ops → REFACTOR/operational.

### `apps/core`
- **KEEP:** DDD bounded contexts are clean — 13 contexts under `modules/` with **zero** cross-module reaches into another module's `internal/` (grep clean). `attribution/internal/credit-writer.ts` is a 10-line re-export shim of `@brain/attribution-writer` (no duplication). Control-plane PG reads (`dashboard.queries.ts:27-183`: orgs/brands/connectors/pixel) are operational, allowed.
- **REFACTOR (wrong-ownership):**
  - **`jobs/attribution-reconcile.ts`** ⚠️ — computes attribution in TS (`reconcileAttribution`, `reconcileDataDrivenAttribution` Markov) over StarRocks Silver, writes StarRocks `brain_gold.gold_attribution_credit`. **VIOLATION:** Spark must compute; Gold must be Iceberg; StarRocks must not own attribution.
  - `recommendation-detectors.ts`, `generate-recommendations.ts`, `measure-recommendation-outcomes.ts` — recommendations computed in app code; Decision must be runtime over features/metrics.
  - frontend-api analytics reads go through `@brain/metric-engine` (`withSilverBrand`) but the **metric is computed in TS at serve time** → repoint the seam to pre-computed `mv_*`.

---

## 3. Packages

### `packages/metric-engine` (~73 files) — **REFACTOR** (single biggest lift)
- **Wrong-ownership:** business truth computed in TypeScript at request/job time over StarRocks Silver — `realized-revenue.ts` (recognition SQL `:47-52`), `provisional-revenue.ts`, `contribution-margin.ts` (CM2 arithmetic `:147`), `customer-360.ts`, `cac.ts`, `attribution-models.ts`/`attribution-datadriven.ts`/`attribution-credit.ts`/`attribution-reconciliation.ts`, `*-roas.ts`, `executive-metrics.ts`, `kpi-summary.ts`, plus ~40 reader modules (cod-rto, checkout-funnel, storefront-*, top-products).
- **Target:** Spark computes → Iceberg Gold → StarRocks `mv_*`; **metric-engine becomes a thin serve/read seam** over MVs. Keep the registry (one-definition-per-metric, money = minor units + currency_code).
- ⚠️ HIGH-RISK: CM2/realized-revenue/LTV are money truth — **parity-gate before cutover.**

### `packages/attribution-writer` — **REFACTOR** ⚠️
- **Wrong-ownership:** computes credit and **APPENDs to StarRocks `brain_gold.gold_attribution_credit`** (PRIMARY KEY table) (`index.ts:96,346`). Double violation (compute-in-TS + Gold-in-StarRocks).
- **Target:** Markov/position-based apportionment + largest-remainder credit math → Spark; storage → Iceberg Gold; serve via `mv_*`. Byte-exact money parity required.

### `packages/feature-store` — **REFACTOR**
- Redis online store (`RedisOnlineStore`, TTL 25h + freshness sentinel) is the **conformant sink**. Source must move from StarRocks Gold table → Iceberg-Gold-fed `mv_*`. Note: `feature_customer_daily` (a **permanent** dbt feature table) **violates** "NO permanent feature tables" — features are runtime/Redis.

### KEEP packages (conformant plumbing)
- `packages/events` — `buildPartitionKey(brandId,eventId)`; tenant partition key.
- `packages/tenant-context` — Redis session keys tenant-prefixed.
- `packages/db` — RLS GUC + injection-guarded privileged escapes (`audit_reader`/`send_service`).
- `packages/connector-secrets` — per-brand namespaced Secrets Manager ARNs, brand_id scrubbed from errors.
- `packages/config` — per-env config (fix the stale stream-worker Bronze default comment consumer).
- `packages/logistics-status`, `packages/money` — deterministic shared authorities.

### `packages/identity-graph` — **REMOVE**
- Dead package, imported nowhere (Staff SWE audit).

---

## 4. Data / compute / serving layers

### `db/iceberg/spark` — **KEEP + EXTEND** (net-new Silver/Gold)
- **KEEP:** `bronze_materialize.py` (idempotent MERGE INSERT-only, append-only/replayable, the one conformant medallion hop), `validate_bronze.py`, `bronze_maintenance.py` (compaction + 24-month snapshot TTL + crypto-shred), `bronze_parity_check.py`. Backfill lane consumed; server-trusted/ledger-only admission sets mirror stream-worker.
- **EXTEND (net-new, the core of the migration):** add **Spark Silver** jobs (1:1 for ~9 `silver_*` dbt models + journey-stitch/identity) and **Spark Gold** jobs (1:1 for ~11 `gold_*` + metric-engine/attribution compute) writing **Iceberg Gold**.

### `db/dbt` (entire layer, ~30–31 models) — **DEPRECATE → REMOVE** ⚠️
- **Why:** V4 says "dbt is REMOVED" and "Spark is the only compute." dbt currently is the de-facto Silver+Gold compute engine (`dbt_project.yml:18` `marts:{+materialized: table}`; `gold_customer_360.sql` incremental in `brain_gold`).
- **Models to replace 1:1 with Spark:** Silver — `silver_customer`, `silver_order_state`, `silver_order_line`, `silver_touchpoint`, `silver_shipment[_event]`, `silver_checkout_signal`, `silver_sessions`, `silver_product`, `silver_marketing_spend`. Gold — `gold_customer_360`, `gold_revenue_ledger`, `gold_revenue_analytics`, `gold_attribution_paths`, `gold_marketing_attribution`, `gold_cac`, `gold_customer_scores`, `gold_customer_segments`, `gold_cohorts`, `gold_executive_metrics`, `feature_customer_daily` (drop — permanent feature table forbidden), `snap_order_state`, `snap_attribution_credit`. The 6 staging + 2 intermediate views fold into the Spark Bronze→Silver read.
- **KEEP-as-pattern:** dbt staging proves Bronze SoR is Iceberg (`stg_order_events_bronze.sql:32` reads `source('bronze_iceberg','collector_events')`) — preserve that read direction in Spark.
- **Order:** DEPRECATE only after Spark parity; **do not delete first** (blanks every dashboard). Then REMOVE dbt-runner image, entrypoint, profiles.

### `db/starrocks` — **REFACTOR**
- Reclassify `brain_silver`/`brain_gold` **base tables** to **`mv_*` materialized views over Iceberg Gold** (zero `mv_*` exist today). Re-home PRIMARY-KEY upsert semantics onto Iceberg MERGE. The one-way `Iceberg→dbt→StarRocks` codified in `external_iceberg_catalog.sql:3` must become `Iceberg-Gold → StarRocks mv_*`.

### `db/migrations` (111 migrations, gap at 0102) — **mostly KEEP, residual REFACTOR/REMOVE**
- **KEEP (operational, V4-conformant):** organization/tenancy/IAM/RBAC (0064), connector config + sync control plane (0093/0094/0111), `collector_spool` (0069), `ml.model_registry` (0083 lifecycle config), billing (invoice/credit_note/billing_plan/gmv_meter_snapshot/tax_ledger) ⚠️ load-bearing, compliance vault (`contact_pii`/`consent_record`/`identity_audit`/`send_log`, ADR-0004) ⚠️, `brand_keyring`/`brand_identity_salt` (0109), pixel config (0058), **all RLS FORCE policies** ⚠️ (51 `*_isolation` policies — P0 isolation control, must not regress).
- **Already-evacuated (good):** bronze_events (0070), realized_revenue_ledger (0098), attribution_credit_ledger (0099), PG identity graph (0101), ml.prediction_log (0103), ad_spend_ledger (0105).
- **REFACTOR/REMOVE (residual analytical in PG):** `audit.dq_check_result` (move to Spark/Iceberg), `ai_config.ai_provenance` (AI output — classify as audit exception or stop), `ai_config.recommendation_outcome` (analytics). **Decision tables** `recommendation`/`recommendation_action`/`audit.decision_log` → **REFACTOR** (rename to the four allowed: `recommendation_history`/`decision_history`/`decision_outcome`/`user_feedback`; ensure they hold decision-loop state only, not computed recs).
- **Hygiene:** 0085 is a dead no-op duplicating the 0070 drop; 0086 duplicates 0068 (`fk_covering_indexes`); dangling SECURITY-DEFINER/signal functions (`rto_risk_signal_for_brand`, `realization_signal_for_brand`) reference dropped tables — remove.

---

## 5. Infrastructure

| Surface | Disposition | Action |
|---|---|---|
| `infra/terraform/s3-iceberg` | **REFACTOR/EXTEND** | Provision Iceberg **Silver + Gold** buckets, Glue catalogs, Spark write role (only Bronze exists today — Gold-in-Iceberg not deployable) |
| `infra/helm/cronworkflows` (spark-bronze) | **KEEP** | Conformant Bronze cron (concurrency=Forbid, idempotent, podGC) |
| `infra/helm/cronworkflows` (recognition-refresh, attribution-gold-refresh) | **REMOVE** ⚠️ | dbt gold-producing crons; remove **after** Spark parity (premature removal halts recognition + attribution) |
| dbt-runner image + entrypoint + profiles | **REMOVE** | After Spark builds the marts |
| `infra/observe` | **KEEP + EXTEND** | Add Spark/StarRocks/Iceberg-Gold **freshness SLOs** (today no Spark/StarRocks/Gold telemetry — blind spot) |
| `infra/argocd`, supply-chain (sign+digest-pin) | **KEEP** | Strong; preserve fail-closed-on-unpinned |
| `worktrees/brain-v4-audit` | **n/a** | This audit's own gitignored worktree — exclude |

---

## 6. Wrong-ownership matrix (who does whose job)

| Layer doing the wrong job | Job it is wrongly doing | Correct V4 owner | Disposition |
|---|---|---|---|
| **StarRocks** (`brain_gold.*` base tables) | Owns Gold (customer_360, attribution_credit, revenue_ledger, ml prediction log) | **Iceberg Gold** (StarRocks = `mv_*` serving) | REFACTOR base→MV |
| **dbt** (~30 models) | Builds Silver + Gold | **Spark** | DEPRECATE→REMOVE |
| **`@brain/metric-engine`** (~73 TS files) | Computes CM2/LTV/revenue/CAC/ROAS/attribution | **Spark** | REFACTOR→thin serve seam |
| **`@brain/attribution-writer`** | Computes + writes attribution Gold to StarRocks | **Spark → Iceberg Gold** | REFACTOR |
| **stream-worker jobs** (journey-stitch/identity-export) | Builds identity/journey Silver | **Spark** | REFACTOR ⚠️ |
| **stream-worker dq jobs** | Computes DQ analytics, writes PG | **Spark → Iceberg**, out of PG | REFACTOR |
| **core jobs** (attribution-reconcile/recommendation-*) | Computes attribution + recs in app code | **Spark** (attribution) / **runtime Decision** (recs) | REFACTOR ⚠️ |
| **PostgreSQL** (`dq_check_result`/`ai_provenance`/`recommendation_outcome`) | Holds analytical/AI data | **Iceberg/Spark-owned lakehouse** | REFACTOR/REMOVE |
| **PG `BronzeRepository`** (dormant) | Latent raw-event store | **Iceberg Bronze** (sole SoR) | REMOVE ⚠️ |

---

## 7. ⚠️ HIGH-RISK repo changes requiring sign-off

> ⚠️ **`attribution-reconcile.ts` + `@brain/attribution-writer` + `gold_attribution_credit`** — attribution money truth in TS/StarRocks. Move compute→Spark, storage→Iceberg under a **byte-exact parity oracle** (largest-remainder credit). Sign-off: Finance/Revenue + Architecture.

> ⚠️ **`metric-engine` revenue/CM2 modules + `gold_revenue_ledger` dbt cron** — recognition basis read by billing. **Parity-gate before removing dbt cron.** Sign-off: Finance/Billing.

> ⚠️ **stream-worker identity/journey-stitch jobs → Spark** — hashed-PII brain_id spine; **Neo4j has no RLS** (P0 leak surface). Require enforced Cypher query-guard + GDPR-erasure parity. Sign-off: Security/Compliance.

> ⚠️ **`BronzeRepository.ts` removal** — eliminates raw-PII-in-PG escape; safe to remove but coordinate with the stale-comment fix and confirm no env still flips `BRONZE_PG_WRITE_ENABLED`.

> ⚠️ **PG analytical-ledger relocation** (`dq_check_result` et al.) — **blocked on** Spark Silver/Gold + StarRocks MV existing; live routes read these. Relocate-then-cutover. Sign-off: Data + Security.
