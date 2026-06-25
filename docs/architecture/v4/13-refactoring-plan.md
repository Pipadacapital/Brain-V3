# 13 — Refactoring Plan (Brain V4)

**Status:** Decision-grade synthesis deliverable
**Scope:** The ordered refactor of repo + database + pipelines required to reach the OFFICIAL Brain V4 architecture — grouped into workstreams with explicit dependencies.
**Rule of adjudication:** When code / migrations / dbt / UI / APIs disagree with V4, **ARCHITECTURE WINS.**
**Evidence base:** the validated audit bundle (RECON-1 + 8 workstream audits) and the sibling reports [01](./01-architecture-impact-report.md), [02](./02-repository-impact-report.md), [04](./04-database-audit.md), [08](./08-spark-ownership-report.md), [09](./09-starrocks-report.md).

> ⚠️ **HIGH-RISK** callouts mark load-bearing changes (revenue, attribution, billing, identity/PII, tenant isolation) that require explicit stakeholder sign-off **before** execution.

---

## 1. The shape of the work

The drift is **one root inversion with three surfaces** (see [01 §3](./01-architecture-impact-report.md)):

1. **Compute is in the wrong engines** — Silver/Gold built by **dbt (SQL)** + **TypeScript** (`@brain/metric-engine` ~73 files, `@brain/attribution-writer`) instead of Spark (RECON-1; Principal Data Engineer audit).
2. **Gold is in the wrong store** — business truth lives in **StarRocks `brain_gold.*` base tables** (and residual PG ledgers) instead of **Iceberg**; **zero `mv_*` serving views exist** (grep clean; Data Engineer + Infra audits).
3. **Identity / feature / DQ Silver is built by app code** — `journey-stitch`, `identity-export`, `dq`, `feature-materialization` jobs compute canonical/analytical data in TS instead of Spark (RECON-1).

Everything else (the ~30 dbt models, the ~73 metric-engine modules, the residual PG analytical ledgers, the topic-taxonomy question) is a **consequence** of these three.

**Governing strategy for every workstream below: build-Spark-first → parity-gate → cutover → only then remove dbt/TS-compute.** Premature dbt deletion blanks every dashboard (01 §6; Architect ARCH-001/002).

---

## 2. Workstream catalog

Nine workstreams (W0–W8). The dependency graph is in §3; per-workstream detail in §4.

| ID | Workstream | Disposition driver | Risk |
|----|------------|--------------------|------|
| **W0** | Provision Iceberg Silver + Gold storage (Terraform) | Infra not provisioned for Gold-in-Iceberg | Medium |
| **W1** | Spark Silver build (replace ~9 dbt `silver_*` + 2 TS-built Silver entities; add missing canonical entities) | dbt + app-code build Silver | High (identity/PII) |
| **W2** | Spark Gold build → **Iceberg Gold** (replace ~11 dbt `gold_*` + metric-engine + attribution-writer math) | dbt + TS compute Gold | ⚠️ HIGH (revenue/attribution) |
| **W3** | StarRocks `mv_*` serving layer over Iceberg Gold | StarRocks owns Gold base tables | High (serving parity) |
| **W4** | Repoint read seam (`@brain/metric-engine` → thin serve seam over `mv_*`) | Business truth computed at serve time | Medium |
| **W5** | Decision/AI runtime cleanup (recommendations runtime; AI outputs not persisted) | Recs computed in TS; `ai_provenance` persisted | Medium |
| **W6** | PostgreSQL operational-only cleanup (relocate residual analytical ledgers) | `dq_check_result`/`ai_provenance`/`recommendation_outcome` in PG | High (live-route reads) |
| **W7** | Retire dbt + dead/dormant code paths | dbt is REMOVED; `BronzeRepository`, `identity-graph` dead | ⚠️ HIGH (revenue cron) |
| **W8** | Naming + hygiene + observability extension | kebab-case violations; no Spark/Gold SLOs | Low |

---

## 3. Dependency graph (build order)

```
W0 Provision Iceberg Silver+Gold storage
      │
      ▼
W1 Spark Silver (Iceberg) ───────────────┐
      │                                   │
      ▼                                   │
W2 Spark Gold (Iceberg)  ⚠️ revenue/attr  │
      │                                   │
      ▼                                   │
W3 StarRocks mv_* over Iceberg Gold       │
      │                                   │
      ▼                                   │
W4 Repoint metric-engine → serve seam     │
      │                                   │
      ├──────────────► W5 Decision/AI runtime cleanup
      │                                   │
      ▼                                   ▼
W6 PG operational-only cleanup  ◄─── (blocked on W1–W4 existing)
      │
      ▼
W7 Retire dbt + dead paths  ⚠️ (only AFTER W2/W3 parity-proven)
      │
      ▼
W8 Naming + hygiene + observability (parallelizable throughout)
```

**Hard dependencies (cannot be reordered):**

- **W1 → W2 → W3 → W4** is a strict chain: Gold reads Silver; MVs serve Gold; the serve seam reads MVs.
- **W6 (PG analytical removal) is BLOCKED on W1–W4** — the residual PG tables (`dq_check_result`, `ai_provenance`, `recommendation_outcome`) are actively written by stream-worker/core and read by live routes; they cannot leave PG until the Spark Silver/Gold + MV replacement exists (DB audit DB-01..03; Architect ARCH-009).
- **W7 (dbt removal + cron deletion) is BLOCKED on W2/W3 parity** — the `recognition-refresh` and `attribution-gold-refresh` crons produce `gold_revenue_ledger` / `gold_marketing_attribution`, which billing and attribution read; deleting before parity zeros revenue serving (Infra audit; SPARK-001). ⚠️ **HIGH-RISK.**

**Parallelizable:** W0 unblocks immediately. W5 can proceed alongside W4 once the read seam target exists. W8 (hygiene/naming/observability) runs throughout and gates nothing.

---

## 4. Workstream detail

### W0 — Provision Iceberg Silver + Gold storage (Terraform)
**Why:** `infra/terraform/s3-iceberg/main.tf` provisions **only** a Bronze S3 bucket + Bronze Glue DB. There is no Iceberg Silver/Gold bucket, catalog, or Spark write role — **Gold-in-Iceberg is not deployable today** (Infra audit).
**Refactor:**
- Add Iceberg Silver + Gold S3 buckets and Glue catalog databases (`brain_silver`, `brain_gold` as **Iceberg**, distinct from today's StarRocks `brain_silver`/`brain_gold`).
- Add a Spark write role with least-privilege access to Silver + Gold buckets.
- Extend Iceberg maintenance (compaction + snapshot-expiry TTL + crypto-shred) — currently Bronze-only — to Silver + Gold.
**Dependencies:** none (entry point).
**Verification:** Spark can create + MERGE into an empty Iceberg Silver/Gold table in the provisioned catalog.

### W1 — Spark Silver build ⚠️ (identity/PII)
**Why:** Silver is built by **dbt** (~9 `silver_*` models materialized to StarRocks `brain_silver`) and by **TS stream-worker jobs** for two "Silver" entities (`silver_journey_stitch`, `silver_customer_identity`). V4 requires Spark to build canonical Silver in Iceberg (01 §2; RECON-1).
**Refactor (1:1 Spark→Iceberg replacements):**
- Reimplement `silver_customer`, `silver_order_state`, `silver_order_line`, `silver_touchpoint`, `silver_shipment[_event]`, `silver_checkout_signal`, `silver_sessions`, `silver_product`, `silver_marketing_spend` as Spark jobs reading **Iceberg Bronze** (`source('bronze_iceberg','collector_events')` is the proven read direction — `stg_order_events_bronze.sql:32`).
- Re-home `journey-stitch`/`identity-export` TS jobs into Spark; **preserve hashed-PII handling, tenant isolation, GDPR erasure, and current identity parity** (Data Architecture DATA-03/09).
- Add the **missing canonical entities** V4 names but that have no standalone Silver today: payment, settlement, campaign, journey-as-entity, identity_alias (Data Architecture DATA-06..10).
- Preserve Silver modeling discipline already correct in dbt: per-entity grain, `brand_id`-leading keys, money as BIGINT minor units + `currency_code`, additive/deterministic folds, ADR-0004.
**Dependencies:** W0.
**Verification:** **Silver parity oracle** — Spark Silver output equals current dbt/TS Silver row-for-row (keyed by `(brand_id, entity_id)`).
> ⚠️ **HIGH-RISK — IDENTITY / COMPLIANCE.** Identity/journey Silver is the brain_id join spine for all customer/revenue/attribution analytics and carries hashed PII. **Neo4j has no RLS** (app-layer isolation only) — re-platforming must preserve isolation + GDPR erasure and add an enforced Cypher query-guard (SEC-01; DATA-03/09). **RATIFY with Security/Compliance before execution.**

### W2 — Spark Gold build → Iceberg Gold ⚠️ (revenue/attribution)
**Why:** Gold is built by **dbt** (~11 `gold_*` models) + **TypeScript** (`metric-engine` CM2/revenue/CAC/LTV/ROAS; `attribution-writer` Markov/credit) and stored in **StarRocks base tables** (and residual PG ledgers), not Iceberg. Double violation: compute-in-TS + Gold-in-StarRocks (RECON-1; Architect ARCH-003..006; Data Eng SPARK-004/005).
**Refactor (1:1 Spark→**Iceberg Gold**):**
- `gold_customer_360`, `gold_revenue_ledger`, `gold_revenue_analytics`, `gold_attribution_paths`, `gold_marketing_attribution`, `gold_cac`, `gold_customer_scores`, `gold_customer_segments`, `gold_cohorts`, `gold_executive_metrics`, `snap_order_state`, `snap_attribution_credit`.
- Port `metric-engine` business math (realized/provisional revenue recognition, CM2 in `contribution-margin.ts:147`, CAC, LTV, ROAS, executive metrics) and `attribution-writer` apportionment (Markov/position-based + **largest-remainder credit**) into Spark, **reproducing the deterministic money math byte/minor-unit-exact**.
- **DROP `feature_customer_daily`** — a permanent feature table violates "NO permanent feature tables"; features become runtime/Redis (handled in W4).
**Dependencies:** W1.
**Verification:** **Revenue + attribution parity oracle** — exact minor-unit Σ match against current dbt+TS outputs, per brand, before any cutover; independent oracle per `metric-engine` registry discipline.
> ⚠️ **HIGH-RISK — REVENUE / BILLING.** `gold_revenue_ledger` is the recognition basis **read by billing**; CM2/realized-revenue feed margin and the billing cap. Any compute relocation must be parity-proven (exact minor-unit Σ) before cutover (ARCH-003/005; SPARK-001). **RATIFY + parity-gate.**
> ⚠️ **HIGH-RISK — ATTRIBUTION TRUTH.** `gold_attribution_credit` (StarRocks PRIMARY-KEY) + `gold_marketing_attribution`/`gold_attribution_paths` are the attribution SoR. Byte-exact money math (largest-remainder, recognition rule) must be preserved (ARCH-004/006; SEC-03). **RATIFY before execution.**

### W3 — StarRocks `mv_*` serving over Iceberg Gold
**Why:** StarRocks **owns** Gold as base tables in `brain_gold.*`; **zero `mv_*` views exist** anywhere. The one-way `Iceberg→dbt→StarRocks` rule is codified in `db/starrocks/external_iceberg_catalog.sql:3`. V4: StarRocks serves `mv_*` ONLY (09-starrocks-report; Data Eng SPARK-002/003).
**Refactor:**
- Replace `brain_gold.*` base tables with `mv_*` async materialized views over the new **Iceberg Gold** external catalog.
- Re-home PRIMARY-KEY upsert semantics (e.g. `gold_attribution_credit`) onto Iceberg MERGE upstream; the MV becomes a read-only projection.
- Recodify the serving rule to `Iceberg-Gold → StarRocks mv_* → API → UI`.
**Dependencies:** W2.
**Verification:** Serving parity — `mv_*` query results match the Iceberg Gold table they project.

### W4 — Repoint read seam (`@brain/metric-engine` → thin serve seam)
**Why:** `metric-engine` computes business truth in TS at request/job time over StarRocks Silver; the BFF analytics reads route through `withSilverBrand` (02 §3). V4: "Spark calculates, StarRocks serves, APIs expose, UI renders."
**Refactor:**
- Reduce `metric-engine` to a **thin serve/read seam** over `mv_*`: keep the registry (one-definition-per-metric, money = minor units + `currency_code`), delete the in-TS computation bodies.
- Repoint `feature-materialization/run.ts`: keep the **Redis sink** (`RedisOnlineStore`, TTL 25h + freshness sentinel — conformant), change the source from StarRocks Gold table → Iceberg-Gold-fed `mv_*`.
- **UI DTO shapes unchanged** (V4 "Architecture → API → UI" order) — near-zero `apps/web` impact; confirm hardcoded date-window literals survive MV-served aggregates (FE caveat, 02 §2).
**Dependencies:** W3.
**Verification:** BFF endpoints return identical DTOs (shape + values) before/after the seam swap; contract tests green.

### W5 — Decision / AI runtime cleanup
**Why:** Recommendations are computed in TS (`recommendation-detectors.ts`, `generate-recommendations.ts`, `measure-recommendation-outcomes.ts`); PG holds `recommendation`/`recommendation_action`/`recommendation_outcome`/`decision_log`; `ai_config.ai_provenance` permanently persists AI output (redacted-only). V4: Decision + AI are runtime; only `recommendation_history`/`decision_history`/`decision_outcome`/`user_feedback` may persist (01 §2; DB audit; SEC-02/04/05).
**Refactor:**
- Move recommendation/decision computation to **runtime** over features/metrics/signals/confidence.
- **Rename** the decision tables to the four allowed ledgers and ensure they hold **decision-loop state only**, not computed recs.
- **`ai_provenance`** — classify as an explicit audit-ledger exception (preserving redact-before-store) or stop persisting. ⚠️ **RATIFY with Compliance.**
**Dependencies:** W4 (needs the runtime feature/metric seam).
**Verification:** No computed recs land in PG; the four allowed ledgers exist; AI outputs not persisted beyond the ratified exception.

### W6 — PostgreSQL operational-only cleanup
**Why:** Bulk analytical data is already evacuated (bronze 0070, revenue 0098, attribution 0099, identity 0101, ml.prediction_log 0103, ad_spend 0105 — DB audit). Residual analytical in PG: `audit.dq_check_result`, `ai_config.ai_provenance`, `ai_config.recommendation_outcome` (01 §2; DB audit DB-01..03).
**Refactor:**
- Relocate `dq_check_result` to **Spark→Iceberg** (DQ becomes Spark-owned).
- Relocate/retire `ai_provenance` (per W5 ratification) and `recommendation_outcome` (analytics → lakehouse).
- Remove dangling SECURITY-DEFINER signal functions referencing dropped tables (`rto_risk_signal_for_brand`, `realization_signal_for_brand`); drop the dead no-op migration 0085 and the 0086/0068 duplicate (migration hygiene — 05-migration-audit).
- **KEEP (do NOT sweep out):** billing ledgers, compliance/PII vault (`contact_pii`/`consent_record`/`identity_audit`/`send_log`, ADR-0004), `ml.model_registry` (lifecycle config), all RLS FORCE policies.
**Dependencies:** **Blocked on W1–W4** (live routes read these tables; the Spark/MV replacement must exist first).
**Verification:** No analytical/AI data in PG beyond the four allowed decision ledgers + ADR-0004 compliance exceptions; live read paths return from the lakehouse with no 500s.
> ⚠️ **HIGH-RISK — PG ANALYTICAL-LEDGER REMOVAL.** `dq_check_result` and recommendation ledgers are read by live routes; **relocate-then-cutover**, never drop-first (Architect ARCH-009; DB-01..03). Preserve RLS isolation through every move (P0 / Security-VETO).

### W7 — Retire dbt + dead/dormant code paths ⚠️
**Why:** dbt is the live, ArgoCD-deployed compute engine; V4 says **dbt is REMOVED**. Plus dead/dormant code: `BronzeRepository.ts` (PG-Bronze escape), `packages/identity-graph` (imported nowhere), stale `main.ts:155` comment (02 §2; Staff SWE audit).
**Refactor (in this order, AFTER W2/W3 parity):**
1. Remove the two gold-producing dbt crons (`recognition-refresh`, `attribution-gold-refresh`) — ⚠️ **only after** Spark Gold + MV are parity-proven (premature removal halts recognition + attribution refresh).
2. Remove the `db/dbt` model layer, dbt-runner Docker image, `docker-entrypoint.sh`, profiles.
3. **REMOVE `apps/stream-worker/.../pg/BronzeRepository.ts`** (latent raw-PII-in-PG escape, default-OFF via `BRONZE_PG_WRITE_ENABLED`); confirm no env flips the flag; fix the stale `main.ts:155` comment (SEC-06).
4. **REMOVE `packages/identity-graph`** (dead).
**Dependencies:** W2 + W3 parity-proven; W6 for the PG cleanup overlap.
**Verification:** No dbt references remain; all dashboards still serve from Spark→Iceberg→MV; `grep` clean for `BronzeRepository`/`identity-graph` imports.
> ⚠️ **HIGH-RISK — dbt REMOVAL.** dbt removal is **not a delete** — it is the completion of the Spark re-platform. Every cron/model removal must follow a green parity gate (ARCH-001/002; SPARK-001).

### W8 — Naming + hygiene + observability extension
**Why:** 125 PascalCase-named `.ts` files violate the kebab-case file rule (06-naming-violations; Staff SWE audit); no Spark/StarRocks/Iceberg-Gold-freshness telemetry exists (Infra observability blind spot).
**Refactor (low-risk, parallelizable throughout):**
- Rename PascalCase files to kebab-case (`CustomerRepository.ts` → `customer-repository.ts`), classes stay PascalCase.
- Add Spark/StarRocks/Iceberg-Gold **freshness SLOs** to `infra/observe` (the new business-critical hops ship without SLOs otherwise).
- Move the narrow `apps/web` display-only client calcs server-side (FE-01/FE-03); ⚠️ **FE-02** margin cost-input transform + confidence assignment requires API-contract ratification first.
**Dependencies:** none (gates nothing).
**Verification:** naming lint clean; freshness SLO dashboards live; UI display calcs served pre-computed.

---

## 5. Conformant foundation — guard against regression

These are verified-conformant and must **not** regress during the refactor (01 §5):

1. Collector ingress (Source → PG `collector_spool` transient → Redpanda).
2. Spark Bronze hop (idempotent MERGE INSERT-only on `(brand_id,event_id)`; the one conformant medallion hop).
3. Neo4j identity SoR.
4. Redis runtime discipline (every key TTL'd + tenant-prefixed).
5. Consumer-only UI (BFF-only, honest empty states, money in minor-units, no mocks).
6. Tenant-isolation spine (Kafka partition key, Iceberg `bucket(256,brand_id)`, Redis prefixes, PG RLS FORCE under NOBYPASSRLS `brain_app`). **P0 — any regression is a Security-VETO surface.**
7. Observability + supply chain (OTel→Prometheus/Loki/Tempo/Grafana; signed + digest-pinned images).

---

## 6. Bottom line

The refactor is **concentrated, not diffuse**: one inversion (compute in dbt+TS, Gold in StarRocks/PG) drives nearly every violation. The nine workstreams reduce to a single strict chain — **provision (W0) → Spark Silver (W1) → Spark Gold in Iceberg (W2) → StarRocks MVs (W3) → repoint seam (W4) → cleanup (W5/W6) → retire dbt + dead paths (W7) → hygiene (W8)** — executed **Spark-first, parity-gated, store-then-cutover.** The phased execution and exit criteria are in [14-implementation-plan.md](./14-implementation-plan.md); the load-bearing sign-off items are in [15-risk-assessment.md](./15-risk-assessment.md).
