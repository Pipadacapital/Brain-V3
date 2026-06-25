# 09 — StarRocks Serving-Only Report

**Brain V4 Architecture Migration Audit**
**Scope:** Core Principle (5) "StarRocks owns serving ONLY"; the Gold-must-move-to-Iceberg mandate; the `mv_*`-only target; business-logic-in-StarRocks violations.
**Verdict:** **NON-CONFORMANT.** StarRocks currently **owns Gold** as base tables and serves business truth that is computed *into* it by dbt and TypeScript. V4 requires StarRocks to serve **only** `mv_*` materialized views over **Iceberg Gold**.

> **Authority note.** Per V4: *"if code/functionality/migrations/UI/APIs disagree with architecture, ARCHITECTURE WINS."* This report corrects the implementation toward V4.

---

## 1. V4 contract for StarRocks (verbatim mandate)

- **Principle 5:** StarRocks owns **serving ONLY**.
- **Gold:** stored in **Iceberg** (replayable / auditable / versioned / historical). Gold is **NOT** owned by StarRocks.
- **StarRocks = MVs only (`mv_*`)**; does **NOT** own `customer_360` / attribution / `realized_revenue` / business-logic / recommendations.
- **Flow:** Spark Gold data products → **Iceberg Gold** → **StarRocks Materialized Views (serving)** → Redis → APIs → UI.
- **UI/API rule:** *"Spark calculates, StarRocks serves, APIs expose, UI renders."*

---

## 2. Executive summary — the inversion

| V4 mandate | Reality (evidence) | Status |
|---|---|---|
| StarRocks serves `mv_*` only | **Zero `mv_*` materialized views exist anywhere** (grep clean). The serving layer is entirely **dbt-materialized base tables**. | ❌ Violated |
| Gold lives in Iceberg | All Gold is **StarRocks tables** in `brain_gold` (`db/dbt/dbt_project.yml:18` `marts: { +materialized: table }`). | ❌ Violated |
| StarRocks does NOT own attribution | `db/starrocks/gold_attribution_credit.sql` is a StarRocks **PRIMARY KEY table**; `@brain/attribution-writer` `INSERT`s into `brain_gold.gold_attribution_credit` (`packages/attribution-writer/src/index.ts:96,346`). | ❌ Violated |
| StarRocks does NOT own `customer_360` | `gold_customer_360` materialized in StarRocks `brain_gold` (`db/dbt/models/marts/gold_customer_360.sql:12` `schema='brain_gold', materialized='incremental'`). | ❌ Violated |
| StarRocks does NOT own `realized_revenue` | `gold_revenue_ledger` materialized as a StarRocks table; produced by the live dbt `recognition-refresh` cron. | ❌ Violated |
| StarRocks does NOT own ML/recommendations | `db/starrocks/gold_ml_prediction_log.sql` is a StarRocks base table. | ❌ Violated |
| Serving is read-only over Iceberg Gold | Codified **inverse** policy: `db/starrocks/external_iceberg_catalog.sql:3` *"one-way Iceberg → dbt → StarRocks → Analytics API. StarRocks → Iceberg is FORBIDDEN."* | ❌ Violated (wrong direction) |

**Root cause:** StarRocks is the *system of record* for Gold, not a *serving cache*. Gold business truth is written **into** StarRocks (by dbt marts and by TS writers), and the dashboards read those base tables directly through the metric-engine seam.

---

## 3. Business-logic / ownership violations in StarRocks (inventory)

### 3.1 StarRocks-native Gold base tables (hand-authored DDL — must move to Iceberg Gold)

| StarRocks object | Path | Owns (V4-forbidden) | Risk |
|---|---|---|---|
| `brain_gold.gold_attribution_credit` | `db/starrocks/gold_attribution_credit.sql` (PRIMARY KEY model) | Attribution credit ledger (money-adjacent truth) | ⚠️ **HIGH-RISK** |
| `brain_gold.gold_ml_prediction_log` | `db/starrocks/gold_ml_prediction_log.sql` | ML prediction stream | Normal |
| `silver_customer_identity` | `db/starrocks/silver_customer_identity.sql` | Identity projection (Neo4j export) | ⚠️ Compliance |
| `silver_identity_link` | `db/starrocks/silver_identity_link.sql` | Identity link projection | ⚠️ Compliance |
| `silver_journey_stitch` | `db/starrocks/silver_journey_stitch.sql` | Journey stitch (canonical Silver, app-built) | ⚠️ Compliance |
| `bronze_order_line_src` / `bronze_touchpoint_src` | `db/starrocks/bronze_*_src.sql` | Bronze read shims | Fold into Spark Silver reads |
| `identity_export_state` | `db/starrocks/identity_export_state.sql` | Identity export cursor | Operational; re-home with Spark identity export |

### 3.2 dbt-materialized Gold tables in `brain_gold` (must move to Iceberg Gold; StarRocks reduced to `mv_*`)

These are enumerated model-by-model in **report 08 §3.3**. Each is currently a StarRocks **base table** and must become a **Spark→Iceberg Gold** product served by a `mv_*`:

`gold_revenue_ledger` ⚠️, `gold_revenue_analytics` ⚠️, `gold_attribution_paths` ⚠️, `gold_marketing_attribution` ⚠️, `gold_customer_360` ⚠️, `gold_cac` ⚠️, `gold_customer_scores`, `gold_customer_segments`, `gold_cohorts`, `gold_executive_metrics`.

### 3.3 Business logic computed *into* StarRocks (compute that must leave the serving tier)

| Path | Computes into StarRocks | V4 fate |
|---|---|---|
| `@brain/attribution-writer` (`index.ts:96,346`) | Inserts Markov/position-based credit rows into `brain_gold.gold_attribution_credit` | Spark computes credit → Iceberg Gold; writer retired ⚠️ |
| `apps/core/src/jobs/attribution-reconcile.ts` | Recomputes attribution in TS over StarRocks Silver, writes StarRocks Gold | Spark Gold attribution job |
| `apps/stream-worker/src/jobs/feature-materialization/run.ts` | Reads StarRocks `gold_customer_360` (a StarRocks-owned Gold table) → Redis | Source must become Iceberg-Gold-fed `mv_*` (sink is fine — see report 10) |
| dbt `recognition-refresh` cron (`infra/helm/cronworkflows/values.yaml:138`) | Recognition rule → `gold_revenue_ledger` in StarRocks | Spark recognition → Iceberg Gold ⚠️ |
| dbt `attribution-gold-refresh` cron (`values.yaml:178,188`) | `gold_marketing_attribution`, `gold_attribution_paths` in StarRocks | Spark attribution → Iceberg Gold ⚠️ |

---

## 4. The target state — StarRocks as serving-only over Iceberg Gold

```
Spark Gold (compute) ──▶ Iceberg Gold (SoR: replayable / versioned / auditable)
                              │
                              ▼
                 StarRocks mv_* (serving ONLY, read-through external Iceberg catalog)
                              │
                              ▼
                    Redis (TTL cache) ──▶ APIs ──▶ UI (renders)
```

**Rules to enforce at cutover:**
1. Every served object is named `mv_*` and is a **materialized view over Iceberg Gold** — no `brain_gold.*` base tables remain.
2. StarRocks holds **no** PRIMARY KEY Gold tables; no INSERTs from app code into StarRocks Gold.
3. The external catalog policy in `external_iceberg_catalog.sql` is rewritten: StarRocks **reads** Iceberg Gold (not just Bronze) and **serves** via `mv_*`. The current "Iceberg → dbt → StarRocks" one-way line is obsolete once dbt is removed.
4. The `silver_customer_identity` / `silver_identity_link` / `silver_journey_stitch` StarRocks tables become Spark-built Iceberg Silver, served (if needed) via `mv_*`, preserving Neo4j as identity SoR and GDPR erasure.

---

## 5. Migration ordering (StarRocks-specific)

⚠️ **HIGH-RISK / STAKEHOLDER SIGN-OFF.** StarRocks is the live serving tier for **all** dashboards; flipping it carelessly zeroes the UI.

1. Stand up **Iceberg Gold** (requires the Silver/Gold bucket + catalog + Spark write role — **not yet provisioned in Terraform**, see report 08 §4).
2. Build Spark Gold → Iceberg Gold, **parity-gated** against the current StarRocks `brain_gold.*` base tables (exact minor-unit Σ oracle for money tables).
3. Create `mv_*` materialized views over Iceberg Gold; verify row/sum parity vs. the base tables they replace.
4. Repoint the `@brain/metric-engine` read seam from `brain_gold.*` base tables to `mv_*`. DTO shapes are stable → near-zero UI impact (V4 "Architecture change → API change → UI change").
5. Drop the StarRocks `brain_gold` base tables and the hand-authored Gold DDL (`gold_attribution_credit.sql`, `gold_ml_prediction_log.sql`) **only after** `mv_*` parity holds and the writers are retired.

---

## 6. Load-bearing / high-risk callouts

- ⚠️ **HIGH-RISK — `gold_revenue_ledger`:** produced by the dbt `recognition-refresh` cron and **read by billing**. Any StarRocks-table removal before the Iceberg Gold revenue ledger + `mv_*` is live and parity-proven **zeros revenue serving**. Ratify + parity-gate (exact minor-unit recognition) before execution.
- ⚠️ **HIGH-RISK — `gold_attribution_credit`:** a StarRocks PRIMARY KEY table that is the attribution **system of record**, computed in TS (attribution-writer / attribution-reconcile). Relocating storage to Iceberg Gold + serving via `mv_*` is data-integrity-sensitive; the largest-remainder credit math must reproduce **byte-exact** before cutover.
- ⚠️ **HIGH-RISK — `gold_customer_360` (LTV) and `gold_cac`:** customer LTV and CAC feed decisions/billing-adjacent surfaces; parity-gate.
- ⚠️ **COMPLIANCE — identity Silver in StarRocks** (`silver_customer_identity`, `silver_identity_link`, `silver_journey_stitch`): carry hashed PII and are the `brain_id` join spine; re-platforming to Spark→Iceberg must preserve tenant isolation + GDPR erasure (Neo4j remains identity SoR). Note StarRocks has **no RLS** — isolation is via row-policy templates (`db/starrocks/row_policy_template.sql`); preserve on `mv_*`.
- **Observability gap (low):** no StarRocks/Iceberg-Gold-freshness telemetry today; add `mv_*` refresh-freshness SLOs when the serving tier flips.

---

## 7. Disposition summary

| Object class | Count | Disposition |
|---|---|---|
| StarRocks `brain_gold` base tables (dbt marts) | ~10 | → Spark/Iceberg Gold; replace with `mv_*` |
| Hand-authored StarRocks Gold DDL | 2 (`gold_attribution_credit`, `gold_ml_prediction_log`) | → Iceberg Gold; serve via `mv_*`; retire writers |
| StarRocks identity/journey Silver tables | 3 | → Spark/Iceberg Silver; preserve Neo4j SoR + GDPR |
| `mv_*` serving views | **0 today** | BUILD over Iceberg Gold |
| TS compute writing into StarRocks | attribution-writer + attribution-reconcile + feature-materialization source | → Spark compute; StarRocks serves only |
| External-catalog one-way policy | `external_iceberg_catalog.sql:3` | Rewrite: read Iceberg Gold + serve `mv_*`; "Iceberg→dbt→StarRocks" retired |

**Bottom line:** StarRocks must be demoted from *owner of Gold* to *serving cache of Iceberg Gold via `mv_*` only*. This is gated on the Spark Gold re-platform (report 08) and Iceberg Gold provisioning, and is revenue/attribution load-bearing.
