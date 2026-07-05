# 08 — Spark Ownership Report

**Brain V4 Architecture Migration Audit**
**Scope:** Core Principle (1) "Spark is the ONLY computation engine"; Future Assumption "dbt is REMOVED"; the complete dbt → Spark replacement map (model-by-model); Redpanda (Kafka) topic conformance.
**Verdict:** **NON-CONFORMANT (architectural inversion).** Spark today builds **only Bronze**. The entire Silver + Gold compute layer is owned by **dbt** and **TypeScript** — the exact opposite of V4. Closing this is the single largest workstream in the migration.

> **Authority note.** Per the V4 rule *"if code/functionality/migrations/UI/APIs disagree with architecture, ARCHITECTURE WINS."* This report measures the implementation against V4 and prescribes the implementation's correction — it does not propose changes to V4.

---

## 1. Executive summary

| V4 mandate | Reality (evidence) | Status |
|---|---|---|
| Spark is the ONLY compute engine | Exactly **4 Spark jobs**, all Bronze-only: `db/iceberg/spark/{bronze_materialize,validate_bronze,bronze_maintenance,bronze_parity_check}.py`. **Zero** Spark Silver jobs, **zero** Spark Gold jobs. | ❌ Violated |
| dbt is REMOVED | dbt is the de-facto compute engine: **~31 models** under `db/dbt/models` (9 `silver_*`, 11 `gold_*`/`feature_*`, 6 staging, 2 intermediate, 2 snapshots), **live in prod** via the dbt-runner image driven by Argo CronWorkflows (`infra/helm/cronworkflows/values.yaml:138` recognition-refresh, `:178` attribution-gold-refresh). | ❌ Violated |
| Gold lives in Iceberg | All Gold materialized as **StarRocks tables** in `brain_gold` (`db/dbt/dbt_project.yml:18` `marts: { +materialized: table }`; `gold_customer_360.sql:12` `schema='brain_gold', materialized='incremental'`). | ❌ Violated (see report 09) |
| Business truth computed by Spark | CM2/LTV/attribution/realized-revenue computed in **TypeScript** — `@brain/metric-engine` (73 files) + `@brain/attribution-writer` (which `INSERT`s `brain_gold.gold_attribution_credit`, `packages/attribution-writer/src/index.ts:96,346`), driven by core jobs (`attribution-reconcile.ts`). | ❌ Violated |
| Bronze raw, append-only, replayable | `bronze_materialize.py` does idempotent `MERGE ... ON (brand_id, event_id) WHEN NOT MATCHED THEN INSERT` only — no UPDATE/DELETE. *(Writer since replaced by the Kafka Connect sink, ADR-0010.)* | ✅ Conformant |

**Root cause:** the platform codifies *the inverse* of V4 as policy — `db/starrocks/external_iceberg_catalog.sql:3`: *"ADR-002: one-way Iceberg → dbt → StarRocks → Analytics API."* V4 demands Iceberg → **Spark** → Iceberg Gold → StarRocks **mv_* serving only**.

---

## 2. What Spark owns today (conformant baseline)

| Spark job | Path | Function | Disposition |
|---|---|---|---|
| Bronze materialize | `db/iceberg/spark/bronze_materialize.py` | Redpanda → idempotent `MERGE (brand_id,event_id)` into Iceberg Bronze; consumes both live topic **and** `order.backfill.v1` (lines 41-45) so backfill reaches Bronze (no event loss). | ✅ KEEP — the one fully-conformant medallion hop *(later replaced by the Kafka Connect sink and removed, ADR-0010)* |
| Bronze validate | `db/iceberg/spark/validate_bronze.py` | Schema/admission validation at the Bronze boundary | ✅ KEEP |
| Bronze maintenance | `db/iceberg/spark/bronze_maintenance.py` | Small-file compaction + snapshot-expiry TTL + crypto-shred erasure | ✅ KEEP |
| Bronze parity | `db/iceberg/spark/bronze_parity_check.py` | Bronze count/sum parity oracle | ✅ KEEP |

These four prove the Spark + Iceberg toolchain is wired, CI-built, digest-pinned and Argo-scheduled (`infra/helm/cronworkflows/templates/spark-bronze.yaml`). **The migration extends this proven pattern upward into Silver and Gold — it does not invent a new one.**

---

## 3. The complete dbt → Spark replacement map (model-by-model)

Every model below must be reimplemented as a **Spark job that reads Iceberg (Bronze/Silver) and writes Iceberg (Silver/Gold)**. The 6 staging + 2 intermediate dbt **views** are not separate Spark jobs — they fold into the Bronze→Silver Spark read.

### 3.1 Staging + intermediate (fold into Spark Silver reads — no standalone job)

| dbt model | Path | V4 fate |
|---|---|---|
| `stg_order_events_bronze` | `staging/stg_order_events_bronze.sql` (reads `source('bronze_iceberg','collector_events')`, line 32) | Fold into Spark `silver_order_state` Bronze read |
| `stg_order_line_events` | `staging/stg_order_line_events.sql` | Fold into Spark `silver_order_line` |
| `stg_touchpoint_events` | `staging/stg_touchpoint_events.sql` | Fold into Spark `silver_touchpoint` |
| `stg_checkout_signal_events` | `staging/stg_checkout_signal_events.sql` | Fold into Spark `silver_checkout_signal` |
| `stg_shipment_events` | `staging/stg_shipment_events.sql` | Fold into Spark `silver_shipment` |
| `stg_ad_spend_bronze` | `staging/stg_ad_spend_bronze.sql` | Fold into Spark `silver_marketing_spend` |
| `silver_order_recognition` | `staging/silver_order_recognition.sql` | **Recognition rule** — fold into Spark recognition step feeding `gold_revenue_ledger` ⚠️ |
| `int_order_lifecycle` | `intermediate/int_order_lifecycle.sql` | Fold into Spark `silver_order_state` |
| `int_touchpoint_sessionized` | `intermediate/int_touchpoint_sessionized.sql` | Fold into Spark `silver_sessions`/`silver_touchpoint` |

### 3.2 Silver entities → Spark Silver jobs (write Iceberg Silver)

| dbt model | Path | Canonical entity | Replacement |
|---|---|---|---|
| `silver_customer` | `marts/silver_customer.sql` | customer | Spark Silver job → Iceberg Silver |
| `silver_order_state` | `marts/silver_order_state.sql` | order (terminal-wins fold, 1 row/(brand,order)) | Spark Silver job → Iceberg Silver |
| `silver_order_line` | `marts/silver_order_line.sql` | order_line | Spark Silver job → Iceberg Silver |
| `silver_product` | `marts/silver_product.sql` | product | Spark Silver job → Iceberg Silver |
| `silver_touchpoint` | `marts/silver_touchpoint.sql` | touchpoint | Spark Silver job → Iceberg Silver |
| `silver_sessions` | `marts/silver_sessions.sql` | session | Spark Silver job → Iceberg Silver |
| `silver_checkout_signal` | `marts/silver_checkout_signal.sql` | checkout_signal | Spark Silver job → Iceberg Silver |
| `silver_shipment` | `marts/silver_shipment.sql` | shipment | Spark Silver job → Iceberg Silver |
| `silver_shipment_event` | `marts/silver_shipment_event.sql` | shipment_event | Spark Silver job → Iceberg Silver |
| `silver_marketing_spend` | `marts/silver_marketing_spend.sql` (builds FROM Bronze `spend.live.v1`, connector-agnostic `platform` column) | marketing_spend | Spark Silver job → Iceberg Silver |

> **Canonical-entity gaps** (no standalone Silver model exists today; net-new Spark modeling required): **payment**, **settlement**, **campaign**, **journey** (as an entity vs. touchpoint grain), and **identity_alias** (only a Neo4j-export projection exists). See report on Data Architecture; flagged here because Gold/attribution Spark jobs must be re-pointed onto them.

### 3.3 Gold business-truth → Spark Gold jobs (write **Iceberg Gold**, served by `mv_*`)

| dbt model | Path | Business truth | Replacement | Risk |
|---|---|---|---|---|
| `gold_revenue_ledger` | `marts/gold_revenue_ledger.sql` | Realized-revenue recognition ledger; produced by the live `recognition-refresh` cron (`values.yaml:138`, `DBT_SELECT="+gold_revenue_ledger"`); **read by billing** | Spark Gold → Iceberg Gold; parity-gated | ⚠️ **HIGH-RISK** |
| `gold_revenue_analytics` | `marts/gold_revenue_analytics.sql` | Revenue rollups | Spark Gold → Iceberg Gold | ⚠️ HIGH-RISK |
| `gold_attribution_paths` | `marts/gold_attribution_paths.sql` | Attribution paths; produced by `attribution-gold-refresh` (`values.yaml:188`) | Spark Gold → Iceberg Gold; parity-gated | ⚠️ **HIGH-RISK** |
| `gold_marketing_attribution` | `marts/gold_marketing_attribution.sql` | Marketing attribution; produced by `attribution-gold-refresh` (`values.yaml:188`) | Spark Gold → Iceberg Gold; parity-gated | ⚠️ **HIGH-RISK** |
| `gold_customer_360` | `marts/gold_customer_360.sql` (`schema='brain_gold', materialized='incremental'`, line 12) | Customer 360 (LTV, order counts, lifecycle) | Spark Gold → Iceberg Gold | ⚠️ HIGH-RISK (LTV) |
| `gold_cac` | `marts/gold_cac.sql` | CAC | Spark Gold → Iceberg Gold | ⚠️ HIGH-RISK |
| `gold_customer_scores` | `marts/gold_customer_scores.sql` | RFM / churn scores | Spark Gold → Iceberg Gold | Normal |
| `gold_customer_segments` | `marts/gold_customer_segments.sql` | Segments | Spark Gold → Iceberg Gold | Normal |
| `gold_cohorts` | `marts/gold_cohorts.sql` | Cohorts | Spark Gold → Iceberg Gold | Normal |
| `gold_executive_metrics` | `marts/gold_executive_metrics.sql` | Executive KPIs | Spark Gold → Iceberg Gold | Normal |

### 3.4 Feature + snapshot models — special handling

| dbt model | Path | V4 fate |
|---|---|---|
| `feature_customer_daily` | `marts/feature_customer_daily.sql` | ⚠️ **VIOLATES "NO permanent feature tables."** Features are runtime, generated dynamically, cached in Redis. This must NOT be re-built as an Iceberg table — it becomes a **runtime feature computation cached in Redis**. See report 10. |
| `snap_order_state` | `marts/snap_order_state.sql` | dbt snapshot → Spark-built Iceberg snapshot table (Iceberg time-travel may subsume it) |
| `snap_attribution_credit` | `marts/snap_attribution_credit.sql` | dbt snapshot → Spark-built Iceberg snapshot (subsumed by Iceberg Gold versioning) |

### 3.5 App-code Silver/Gold compute (also "Spark's job") — re-home to Spark

These compute Silver/Gold business truth in TypeScript and must move to Spark:

| Component | Path | Computes | V4 fate |
|---|---|---|---|
| `@brain/metric-engine` (73 files) | `packages/metric-engine/src/*` | CM2 (`contribution-margin.ts`), realized revenue (`realized-revenue.ts`), attribution (`attribution-models.ts`, `attribution-datadriven.ts`, `attribution-credit.ts`, `attribution-reconciliation.ts`), CAC (`cac.ts`), customer-360 (`customer-360.ts`), executive metrics (`executive-metrics.ts`), ROAS (`*-roas.ts`), KPI summary (`kpi-summary.ts`) | Compute moves to Spark→Iceberg Gold; metric-engine becomes a thin **serve/read seam** over StarRocks `mv_*` |
| `@brain/attribution-writer` | `packages/attribution-writer/src/index.ts:96,346` | `INSERT`s computed credit into StarRocks `brain_gold.gold_attribution_credit` | Spark computes credit → Iceberg Gold; writer retired ⚠️ HIGH-RISK |
| `attribution-reconcile` job | `apps/core/src/jobs/attribution-reconcile.ts` | Drives TS attribution (incl. Markov) over StarRocks Silver | Spark Gold attribution job |
| journey-stitch / identity-export | `apps/stream-worker/src/jobs/{journey-stitch-from-identity,identity-export,journey-stitch-export}.ts` | Builds canonical Silver (journey stitch, Neo4j→StarRocks identity export) in app code | Spark Silver job (preserve Neo4j identity SoR + GDPR) |
| dq jobs | `apps/stream-worker/src/jobs/dq/*` | Reads Silver, writes `dq_check_result` (PG) | Spark-owned DQ → Iceberg |
| feature-materialization | `apps/stream-worker/src/jobs/feature-materialization/run.ts` | Reads StarRocks `gold_customer_360` → writes Redis | Sink (Redis) is correct; **source** must be Iceberg-Gold-fed `mv_*` (see report 10) |

---

## 4. Sequencing — dbt removal is a re-platform, not a delete

⚠️ **HIGH-RISK / STAKEHOLDER SIGN-OFF REQUIRED.** Removing dbt before Spark Silver/Gold is live and parity-proven **blanks every dashboard** and **halts revenue recognition + attribution refresh** (the `recognition-refresh` and `attribution-gold-refresh` crons are the producers). Mandatory order:

1. **Build Spark Silver** (Iceberg Silver) — entity-by-entity, parity-gated against current `silver_*` outputs.
2. **Build Spark Gold** (Iceberg Gold) — parity-gated against current `brain_gold.*`; money math (recognition rule, largest-remainder attribution credit) reproduced **byte/minor-unit exact** before cutover.
3. **Build StarRocks `mv_*` serving** over Iceberg Gold (zero `mv_*` exist today).
4. **Repoint** the `@brain/metric-engine` read seam to the `mv_*` views (DTO shapes stay stable → near-zero UI impact per V4 "Architecture change → API change → UI change").
5. **Only then** remove: the ~31 dbt models, the dbt-runner Docker image + entrypoint + profiles, and the two gold-producing Argo cron steps; and remove the TS compute in metric-engine/attribution-writer.

**Provisioning blocker:** Terraform provisions only a **Bronze** S3 bucket + Bronze Glue DB (`infra/terraform/.../s3-iceberg/main.tf`). There is **no Iceberg Silver/Gold bucket, catalog, or Spark write role** — Gold-in-Iceberg is not provisionable until infra is extended. This must precede step 2.

---

## 5. Redpanda (Kafka) topic conformance

V4's flow names per-source topics (pixel.events, shopify.orders, … identity.events). Brain instead uses a **unified envelope** topic plus a backfill lane and separate control-plane domain topics.

| Aspect | V4 expectation | Reality (evidence) | Assessment |
|---|---|---|---|
| Event ingress topic | Per-source topics | **Unified** `${env}.collector.event.v1` carrying all source events with an `event_name` discriminant (`kafka-producer.ts`, `bronzeBridges.ts:37-61`) | Topology differs; functionally feeds Bronze correctly |
| Backfill lane | (unspecified) | `order.backfill.v1` consumed by the Bronze sink (`bronze_materialize.py:41-45` at audit time — sink since replaced by Kafka Connect, ADR-0010) — backfill reaches Bronze, no event loss | ✅ Conformant intent |
| Control-plane events | (n/a — operational) | Separate `m1` domain topics (`user.registered.v1`, etc.) | ✅ Operational, not analytical |
| Event naming | `dot.lower` | `order.live.v1`, `shopflo.checkout_abandoned.v1`, `gokwik.awb_status.v1`, `shiprocket.shipment_status.v1` (`bronzeBridges.ts:37-61`) | ✅ Conformant |
| Partition key = tenant key | Tenant-keyed | `buildPartitionKey(brandId,eventId) = "${brandId}:${eventId}"` (`packages/events/src/index.ts:144`) | ✅ Conformant |

⚠️ **HIGH-RISK / RATIFY THE TOPIC TAXONOMY.** The unified-envelope vs. per-source-topic divergence is a genuine V4 deviation, but **re-partitioning topics touches every producer and the Bronze Spark consumer**; a mis-cut violates "No event loss." Brain's unified envelope is arguably a defensible engineering choice (the `event_name` discriminant + tenant-keyed partitioning preserve replay and isolation). **Decision required:** ratify the unified-envelope taxonomy as V4-compliant, OR plan a guarded migration to per-source topics. Do **not** change topics opportunistically during the Spark re-platform.

---

## 6. Counts at a glance

| Layer | Spark jobs (V4 target) | Exist today | Gap |
|---|---|---|---|
| Bronze | 4 | 4 | 0 ✅ |
| Silver | ~10 entity jobs | **0** | ~10 + gap entities (payment/settlement/campaign/journey/identity_alias) |
| Gold | ~10 business-truth jobs | **0** | ~10 |
| Compute relocated from dbt | — | 31 dbt models | all → Spark |
| Compute relocated from TS | — | ~73 metric-engine modules + attribution-writer + ~5 app jobs | all → Spark (metric-engine survives as read seam) |

---

## 7. Disposition summary

- ✅ **KEEP:** the 4 Bronze Spark jobs; Bronze append-only/replay invariant; tenant-keyed partitioning; dot.lower event naming; backfill-lane-into-Bronze.
- 🔧 **BUILD (net-new Spark):** ~10 Spark Silver jobs + gap entities; ~10 Spark Gold jobs (Iceberg Gold); StarRocks `mv_*` serving; Iceberg Silver/Gold infra provisioning.
- 🔁 **RELOCATE (compute → Spark):** 31 dbt models; ~73 metric-engine TS modules (→ thin read seam); attribution-writer; attribution-reconcile; journey-stitch/identity-export; dq jobs.
- ⚠️ **DO NOT REBUILD AS A TABLE:** `feature_customer_daily` → runtime + Redis (report 10).
- 🗑️ **REMOVE LAST (after parity + cutover):** dbt models, dbt-runner image/entrypoint/profiles, the 2 gold-producing Argo dbt crons, TS compute.
- ⚖️ **RATIFY:** revenue/attribution money-math parity oracle; Redpanda topic taxonomy.
