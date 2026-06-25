# 07 — Code & Architectural Violations

**Audit:** Brain V4 Architecture Migration
**Scope:** Architectural / code-level violations of V4 — business computation outside Spark, wrong-ownership storage, duplicated/dead/stale code, and the dbt-as-compute inversion.
**Evidence base:** Validated audit bundle (RECON-1 + Principal Architect, Data Architecture, Staff SWE, Principal Data Engineer, PG/DB, Platform/Infra, Security, Frontend audits). Direct filesystem verification noted inline.

**Governing rule:** *Spark calculates, StarRocks serves, APIs expose, UI renders.* Where code disagrees with the architecture, **architecture wins**.

---

## The one-sentence finding

Brain's **ingress + Bronze spine is correct**, but the **entire transform-and-serve tier is the architectural inverse of V4**: Spark builds Bronze *only*, **dbt is the de-facto Silver+Gold compute engine**, **business truth (CM2/LTV/attribution/revenue/CAC) is computed in TypeScript at request/job time**, **Gold is stored in StarRocks base tables (not Iceberg)**, and **zero `mv_*` serving views exist**. Closing this is a re-platform, not a patch.

---

## Severity legend

- 🟥 **HIGH-RISK** — load-bearing (money / attribution / identity / tenant-isolation); needs stakeholder sign-off and parity gating before any change.
- 🟧 **Structural** — large but not money-adjacent; same root cause as the HIGH-RISK items.
- 🟨 **Hygiene** — dead/stale/duplicated code; low risk, do opportunistically.

---

## V-CODE-01 🟥 — Business truth computed in TypeScript, not Spark

**Rule violated:** Principle 1 (Spark is the ONLY computation engine); "UI must NEVER calculate attribution/CM2/LTV"; "Spark calculates."

**Finding:** Non-additive business truth is computed **in the Node process** inside `@brain/metric-engine` (~73 files / ~40 compute modules) and `@brain/attribution-writer`, driven by core/stream-worker jobs — over StarRocks Silver, at request or job time.

**Evidence (filesystem-verified `packages/metric-engine/src`):**

| Module | Computes (business truth) | V4 owner |
| --- | --- | --- |
| `contribution-margin.ts` (`:147` CM2 arithmetic) | CM2 / contribution margin | Spark → Iceberg Gold |
| `realized-revenue.ts` (`:47-52` recognition SQL at serve time) | realized-revenue recognition | Spark → Iceberg Gold |
| `provisional-revenue.ts` | provisional revenue | Spark → Iceberg Gold |
| `customer-360.ts` | customer 360 / LTV | Spark → Iceberg Gold |
| `cac.ts` | CAC | Spark → Iceberg Gold |
| `attribution-models.ts`, `attribution-datadriven.ts` (Markov), `attribution-credit.ts`, `attribution-reconciliation.ts` | attribution credit / apportionment | Spark → Iceberg Gold |
| `attribution-channel-roas.ts`, `attribution-campaign-roas.ts`, `blended-roas.ts` | ROAS | Spark → Iceberg Gold |
| `customer-score.ts` | RFM / churn scores | Spark → Iceberg Gold |
| `executive-metrics.ts`, `kpi-summary.ts` | exec KPIs | Spark → Iceberg Gold |
| `cod-rto-rates.ts`, `cod-rto-prediction.ts`, `checkout-funnel.ts`, `cod-mix.ts`, `journey-mix.ts`, `order-status-mix.ts`, `order-stats.ts`, `orders-timeseries.ts`, `ad-spend-timeseries.ts` (~40 total) | derived analytics | Spark → Iceberg Gold |

Driver jobs that invoke this compute:
- `apps/core/src/jobs/attribution-reconcile.ts` (`:67-72`) — runs `reconcileAttribution` + `reconcileDataDrivenAttribution` (Markov) in TS, then writes StarRocks.

**Disposition:** **REFACTOR.** Re-implement each module as a Spark job that builds the mart into **Iceberg Gold**; `@brain/metric-engine` is reduced to a **thin read/serve seam** over `mv_*` (StarRocks) — it stops *computing*. The deterministic money math (largest-remainder credit apportionment, recognition rule, minor-unit arithmetic) must be reproduced **byte-exact** and **parity-gated** before cutover.

> ⚠️ HIGH-RISK: this is the system-of-revenue-truth. Stage entity-by-entity behind a minor-unit Σ parity oracle. Premature removal of the TS compute blanks dashboards and can silently diverge revenue.

---

## V-CODE-02 🟥 — dbt is the Silver+Gold compute engine (V4: "dbt is REMOVED")

**Rule violated:** FUTURE ASSUMPTION "dbt is REMOVED; Spark is the only compute."

**Finding:** The **entire Silver+Gold transform layer is dbt** — ~30–31 models in `db/dbt/models` (9 `silver_*`, ~11 `gold_*`/`feature_*`, 6 staging, 2 intermediate, 2 snapshots) — and it is **LIVE in production**, CI-built, signed, digest-pinned, and ArgoCD-deployed via the `dbt-runner` image driven by Argo CronWorkflows.

**Evidence:**
- `db/dbt/dbt_project.yml:18` — `marts: {+materialized: table}` (dbt materializes marts as tables).
- `gold_customer_360.sql:12-13` — `schema='brain_gold', materialized='incremental'`.
- `infra/helm/cronworkflows/values.yaml` — `recognition-refresh` cron `DBT_SELECT='+gold_revenue_ledger'`; `attribution-gold-refresh` cron `DBT_SELECT='gold_marketing_attribution gold_attribution_paths'` (dbt produces revenue + attribution business truth hourly).
- `db/starrocks/external_iceberg_catalog.sql:3` — codifies the *opposite* of V4 as a one-way `Iceberg→dbt→StarRocks` rule.

**Models requiring 1:1 Spark replacement (then dbt deletion):**

| Layer | Models |
| --- | --- |
| Silver (9) | `silver_customer`, `silver_order_state`, `silver_order_line`, `silver_touchpoint`, `silver_shipment[_event]`, `silver_checkout_signal`, `silver_sessions`, `silver_product`, `silver_marketing_spend` |
| Gold (~11) | `gold_customer_360`, `gold_revenue_ledger`, `gold_revenue_analytics`, `gold_attribution_paths`, `gold_marketing_attribution`, `gold_cac`, `gold_customer_scores`, `gold_customer_segments`, `gold_cohorts`, `gold_executive_metrics`, `feature_customer_daily` |
| Staging/intermediate (8) | 6 staging + 2 intermediate views → fold into the Spark Bronze→Silver read |
| Snapshots (2) | `snap_order_state`, `snap_attribution_credit` |

**Disposition:** **REMOVE dbt — but NOT before Spark replaces it.** Required ordering (RECON-1 / Principal Architect topRisk):
1. Build **Spark Silver** (Bronze→Iceberg Silver).
2. Build **Spark Gold** (Silver→Iceberg Gold).
3. Stand up **StarRocks `mv_*`** serving over Iceberg Gold.
4. Repoint the `metric-engine` read seam to `mv_*`.
5. **Only then** delete dbt models + the `dbt-runner` image, `docker-entrypoint.sh`, profiles, and the two gold-producing Argo cron steps.

> ⚠️ HIGH-RISK: removing dbt prematurely **zeroes revenue + attribution serving** (the two crons produce `gold_revenue_ledger` and `gold_marketing_attribution`). This is a re-platform; ratify the Spark parity plan first.

---

## V-CODE-03 🟥 — Gold stored in StarRocks, not Iceberg; zero `mv_*` serving views

**Rule violated:** "GOLD: stored in ICEBERG (replayable/auditable/versioned)"; "StarRocks = MVs only (`mv_*`); does NOT own customer_360/attribution/realized_revenue/recommendations."

**Finding:** All Gold is materialized as **StarRocks `brain_gold.*` base tables** (some PRIMARY KEY tables). **No `mv_*` materialized views exist anywhere** (grep clean — re-verified: zero `mv_` matches in `db/dbt/models` or `db/starrocks`). StarRocks therefore **owns** Gold instead of serving it.

**Evidence:**
- `gold_attribution_credit.sql`, `gold_ml_prediction_log.sql` — StarRocks PK tables.
- `@brain/attribution-writer` `index.ts:96,346` — app code **APPENDS** to `brain_gold.gold_attribution_credit` (a StarRocks PK table) directly.
- Infra audit: terraform `s3-iceberg/main.tf` provisions **only** a Bronze bucket + Bronze Glue DB — **there is no Iceberg Silver/Gold bucket or catalog**, so Gold-in-Iceberg is *not even provisionable today*.

**Disposition:** **REFACTOR + INFRA.** Land Gold in Iceberg (Spark-written); demote StarRocks to `mv_*` serving over Iceberg Gold; **extend terraform** to provision the Iceberg Silver/Gold bucket, Glue catalog, and Spark write role. (Naming side of this is in `06-naming-violations.md` §7.)

> ⚠️ HIGH-RISK: `gold_revenue_ledger` (billing reads it) and `gold_attribution_credit` (attribution SoR) are money-adjacent. Relocation must be replay/parity-verified before the StarRocks tables are retired. Storing money truth only in StarRocks (no Iceberg replay/version) is also an **integrity/auditability** gap (Security SEC-03).

---

## V-CODE-04 🟧 — No Spark Silver/Gold jobs exist (scope gap)

**Rule violated:** Principles 3 & 4 (Silver/Gold built by Spark).

**Finding:** Only **4 Spark jobs** exist, all Bronze-only: `db/iceberg/spark/{bronze_materialize,validate_bronze,bronze_maintenance,bronze_parity_check}.py`. There is **NO Spark Silver job and NO Spark Gold job**. V4's compute model is entirely absent above Bronze.

**Disposition:** **BUILD.** This is the net-new engineering that V-CODE-01/02/03 all depend on. It is the single largest lift in the migration.

---

## V-CODE-05 🟧 — App-code computes canonical Silver / identity / features (should be Spark)

**Rule violated:** Principle 3 (Silver built by Spark); Principle 1 (Spark only).

**Finding:** Several "canonical Silver" entities and features are produced by **TypeScript jobs**, not Spark, and landed directly into StarRocks/Redis:

| Job / module | What it does today | V4 disposition |
| --- | --- | --- |
| `apps/stream-worker/src/jobs/journey-stitch-from-identity.ts`, `journey-stitch-export`, `identity-export` | Neo4j→StarRocks identity/journey-stitch projection computed in TS → `silver_customer_identity` / `silver_identity_link` / `silver_journey_stitch` | Spark builds Silver from Bronze + Neo4j export |
| `apps/stream-worker/src/jobs/dq/*` | Reads Silver, writes `dq_check_result` (PG) | Spark-owned DQ; results to Iceberg, not PG |
| `apps/stream-worker/src/jobs/feature-materialization/run.ts` | Reads **StarRocks** `brain_gold.gold_customer_360` → writes Redis online store | **Sink (Redis) is correct**; source must become Iceberg-Gold-fed `mv_*`. REFACTOR source only. |
| `apps/stream-worker/src/jobs/gokwik-rto-predict-emit`, `phone-guard-reeval` | app-code signal compute | Spark/runtime per signal type |

**Disposition:** **REFACTOR** — Spark materializes the Silver projections; identity stitch must preserve `brain_id` resolution, tenant isolation, and GDPR erasure (compliance-sensitive — ratify with Security).

> NOTE: `feature-materialization` is *near-conformant* — features-in-Redis-with-TTL is the correct V4 sink; only its **source** (a StarRocks Gold base table) is wrong.

---

## V-CODE-06 🟥 — Analytical / AI data still written to PostgreSQL

**Rule violated:** "NEVER in PG: events, analytics, clickstream, customer history, attribution, recommendations"; AI output "NOT permanently stored."

**Finding (PG/DB + Security audits):** A prior medallion realignment already evacuated most analytical data from PG (dropped: `bronze_events` 0070, `realized_revenue_ledger` 0098, `attribution_credit_ledger` 0099, PG identity graph 0101, `ml.prediction_log` 0103, `ad_spend_ledger` 0105). **Residual analytical/AI tables remain:**

| PG table | Why it violates V4 | Disposition |
| --- | --- | --- |
| `audit.dq_check_result` | data-quality outcome stream (analytics), actively written by stream-worker DQ + read by metric-engine | Move to Spark/Iceberg |
| `ai_config.ai_provenance` | AI answer provenance — AI output permanently stored (V4: AI is runtime) | ⚠️ Ratify as audit-ledger exception **or** stop; preserve redact-before-store |
| `ai_config.recommendation_outcome` | system measurement of rec effectiveness (analytics) | Move to lakehouse / decision ledger |
| `ai_config.recommendation`, `ai_config.recommendation_action`, `audit.decision_log` | recommendation/decision state | **REFACTOR**: only `recommendation_history`/`decision_history`/`decision_outcome`/`user_feedback` are V4-allowed PG decision tables — rename + ensure they hold decision-loop *state*, not *computed* recs |

> ⚠️ HIGH-RISK: blocked on the larger Spark Silver/Gold + `mv_*` build (cannot be done PG-side alone — DB-01..03). `dq_check_result` and `recommendation_action` are read by **live routes** (`attribution.routes.ts`) — relocate-then-cutover or risk read-path 500s. Do **not** sweep out the deliberately-retained PG compliance vault (`contact_pii`, `consent_record`, `audit.identity_audit`, `send_log`) — those are operational/compliance per ADR-0004.

---

## V-CODE-07 🟥 — Permanent feature table contradicts "NO permanent feature tables"

**Rule violated:** "FEATURES: runtime, generated dynamically, cached in Redis, recomputed. NO permanent feature tables."

**Finding:** `feature_customer_daily` is a **persisted dbt mart** (StarRocks table).

**Disposition:** **REMOVE** (not relocate). Features become runtime, computed by Spark/runtime and cached in Redis with TTL (the existing `RedisOnlineStore` sink is already correct).

---

## V-CODE-08 🟧 — Silver can still read PostgreSQL as an analytical source

**Rule violated:** "PostgreSQL stores OPERATIONAL data ONLY"; Silver must build from Bronze.

**Finding:** A transition JDBC-over-Postgres source path persists — `ledger_source=pg` is the **default** (SPARK-015 / DATA-05), letting Silver read PG as an analytical source.

**Disposition:** **REFACTOR + sequence.** Flip the source-of-truth to Iceberg-built Spark Gold — **but only after** Iceberg Bronze proves full event coverage (today largely `order.live.v1` + `spend.live.v1`). Cutting the PG path before Bronze completeness drops revenue/spend data.

> ⚠️ HIGH-RISK: Bronze-completeness must be proven first, or revenue/spend silently vanishes (DATA-INTEGRITY / event-loss).

---

## V-CODE-09 🟥 — Dormant PG-Bronze write path (latent raw-PII-in-PG escape)

**Rule violated:** Bronze-in-Iceberg; "PG operational only"; data residency.

**Finding:** `apps/stream-worker/src/infrastructure/pg/BronzeRepository.ts` still exists. It is retired by default (`BRONZE_PG_WRITE_ENABLED` defaults `false`, gated at `main.ts:159-162`), but it is **one env flag away** from landing raw event payloads (incl. PII) into Postgres (Security SEC-06).

**Disposition:** **REMOVE** the dormant PG-Bronze write path entirely (repository + use-case branch + config flag). Spark→Iceberg is the sole Bronze SoR.

> NOTE — STALE COMMENT (hygiene, verified): `apps/stream-worker/src/main.ts:155` says the PG-Bronze switch is *"default ENABLED"*, directly contradicting both the C4 comment 6 lines below it and the actual config default (`packages/config/src/stream-worker.ts:87` → `false`). Misleading; fix or delete with the path.

---

## V-CODE-10 🟨 — Dead package: `@brain/identity-graph`

**Rule violated:** Hygiene / "stale code."

**Finding (Staff-SWE, verified):** `packages/identity-graph` exists but is **imported nowhere** in live code. Filesystem check: the only `@brain/identity-graph` references are in `apps/stream-worker/package.json` (a declared-but-unused dependency) and compiled `dist/` artifacts — no `src` importer. Identity SoR is Neo4j via `Neo4jIdentityRepository.ts`.

**Disposition:** **REMOVE** the package and drop the unused dependency from `apps/stream-worker/package.json`.

---

## V-CODE-11 🟨 — Migration hygiene (dead / duplicate / dangling)

**Rule violated:** Hygiene; "every table answers who owns it / why / which layer."

**Finding (PG/DB audit):**

| Item | Problem | Disposition |
| --- | --- | --- |
| Migration `0085` | No-op "retire-plan only" comment duplicating the real `bronze_events` drop in `0070` | Document/clean |
| Migration `0086` | Duplicates `0068` (`fk_covering_indexes`) | Document/clean |
| Numbering gap at `0102` | Missing sequence number | Document |
| `rto_risk_signal_for_brand`, `realization_signal_for_brand` SQL fns | Compute business signals over the **now-dropped** revenue ledger — dangling/obsolete | **REMOVE** (SECURITY-DEFINER fns referencing dropped tables) |

**Disposition:** **CLEANUP** (low risk). Several drop migrations left SECURITY-DEFINER/signal functions referencing dropped tables — audit and remove.

---

## V-CODE-12 🟨 — UI residual client-side business calculations (narrow)

**Rule violated:** "UI must NEVER calculate business metrics."

**Finding (Frontend audit):** `apps/web` is overwhelmingly conformant (consumer-only, no direct lakehouse access, no mocked data, money via `formatMoneyDisplay`, honest empty states). Residual **narrow** client-side computations remain — none touch money minor-units, attribution, CM2, or LTV:

| Finding | What | Disposition |
| --- | --- | --- |
| **FE-02** 🟥 (the one HIGH-risk UI item) | margin cost-input: percent→basis-points conversion + UI-pinned `cost_confidence:'Trusted'` feed CM2 **and the billing cap** | Move transform + confidence assignment server-side; **ratify the API contract first** — a wrong conversion mis-states margin and can affect billing |
| FE-01 | client-side RTO high-risk rate display calc | Move to engine DTO |
| FE-03 | tax rate × 100 display transform | Move to engine DTO |

> Per V4's "Architecture change → API change → UI change", DTO shapes are stable, so the upstream Spark/Iceberg refactor has **near-zero UI impact**. Confirm UI date-range/window literals (last-90/35/30-day windows hardcoded in `*-content.tsx`) survive the move to `mv_*`-served aggregates.

---

## V-CODE-13 🟥 — Neo4j identity isolation is app-layer only (no RLS backstop)

**Rule violated:** Multi-tenancy isolation (Principle 11 ownership + tenant-isolation invariant). Not strictly a "compute outside Spark" item, but the highest-blast-radius code violation in the identity path.

**Finding (Security SEC-01):** Neo4j has **no RLS**. Tenant isolation for identity is enforced **only** by a `brand_id` predicate convention in Cypher. A single `brand_id`-less Cypher query is an unguarded **P0 cross-tenant leak** with no database backstop.

**Disposition:** **HARDEN** — add an enforced query-guard (e.g. a mandatory tenant-predicate wrapper / lint gate on Cypher), not convention. SLO = 0 leaks.

> ⚠️ HIGH-RISK: this is the highest-blast-radius tenant-isolation surface in the codebase.

---

## Topic taxonomy — flagged, NOT auto-classified as a violation

⚠️ **HIGH-RISK — requires explicit ratification (SPARK-007).**
V4's *illustrative* per-source topic set (`pixel.events`, `shopify.orders`, `identity.events`) differs from Brain's **unified-envelope** topic `collector.event.v1` (+ `order.backfill.v1`, + m1 control-plane domain topics). Brain's design is replay-safe and tenant-keyed. Re-partitioning topics would touch **every producer** and the Bronze Spark consumer; a mis-cut violates "No event loss." **Do not change topic taxonomy without ratifying the taxonomy decision first** — this is a deliberate-design question, not a defect.

---

## Disposition rollup

| ID | Violation | Severity | Disposition | Blocked on |
| --- | --- | --- | --- | --- |
| V-CODE-01 | Business truth in TypeScript | 🟥 | Refactor → Spark; metric-engine becomes read seam | V-CODE-04 |
| V-CODE-02 | dbt is the Silver+Gold compute engine | 🟥 | Remove dbt *after* Spark replaces it | V-CODE-04 |
| V-CODE-03 | Gold in StarRocks; zero `mv_*` | 🟥 | Gold→Iceberg, StarRocks→`mv_*`, provision infra | V-CODE-04 |
| V-CODE-04 | No Spark Silver/Gold jobs | 🟧 | Build (the keystone lift) | — |
| V-CODE-05 | App-code Silver/identity/feature compute | 🟧 | Refactor → Spark (Redis sink OK) | V-CODE-04 |
| V-CODE-06 | Analytical/AI data in PG | 🟥 | Relocate-then-cutover; preserve 4 allowed decision tables | V-CODE-04 |
| V-CODE-07 | `feature_customer_daily` permanent feature table | 🟧 | Remove; features → runtime/Redis | V-CODE-04 |
| V-CODE-08 | Silver reads PG (`ledger_source=pg`) | 🟧 | Flip to Iceberg after Bronze-completeness proof | Bronze coverage |
| V-CODE-09 | Dormant PG-Bronze write path | 🟥 | Remove repository + flag + stale comment | — |
| V-CODE-10 | Dead `@brain/identity-graph` package | 🟨 | Remove | — |
| V-CODE-11 | Migration hygiene (0085/0086, dangling fns) | 🟨 | Cleanup | — |
| V-CODE-12 | UI residual client calcs (FE-01/02/03) | 🟥 (FE-02) / 🟨 | Move to engine; ratify FE-02 API contract | — |
| V-CODE-13 | Neo4j identity isolation app-layer only | 🟥 | Enforce Cypher tenant-guard | — |

**Bottom line:** the conformant spine (collector → Redpanda → Iceberg Bronze, Neo4j identity, Redis TTL-only, pure-consumer UI) is real and should be preserved. Every HIGH-RISK item converges on **one root cause**: Spark must become the only compute, building Silver and Gold into Iceberg, with StarRocks demoted to `mv_*` serving — and that re-platform must be staged entity-by-entity behind minor-unit parity oracles, never big-bang, because revenue, attribution, and tenant-isolation truth ride on it.
