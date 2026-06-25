# 14 — Implementation Plan (Brain V4)

**Status:** Decision-grade synthesis deliverable
**Scope:** Phased, PR-staged execution of the Brain V4 migration — sequencing the dbt→Spark + Gold→Iceberg re-platform **safely**, honoring **"no breaking change until a phase is approved."**
**Rule of adjudication:** ARCHITECTURE WINS over code / migrations / dbt / UI / APIs.
**Evidence base:** the validated audit bundle + sibling reports [01](./01-architecture-impact-report.md), [02](./02-repository-impact-report.md), [13](./13-refactoring-plan.md), [15](./15-risk-assessment.md).

> ⚠️ **HIGH-RISK** callouts mark phases/PRs that **cannot start** until the named stakeholder sign-off + parity gate is green.

---

## 1. Execution doctrine

Five non-negotiable rules for every phase below:

1. **Build-Spark-first, parity-gate, store-then-cutover, retire-last.** Never delete dbt/TS-compute before a parity-proven Spark→Iceberg→MV replacement is live (01 §6; ARCH-001/002).
2. **No breaking change until a phase is approved.** Each phase ends at a stakeholder go/no-go gate; the next phase does not begin until the prior gate is signed off.
3. **Dual-run before cutover.** New Spark Gold runs **alongside** dbt; reads cut over only after the parity oracle is green for a full validation window.
4. **Reversible PRs.** Every cutover PR is paired with a documented rollback (re-point the read seam back to dbt/StarRocks base tables; the dbt crons remain deployed until the retire phase).
5. **Parity is exact, money is minor-unit.** Revenue/attribution parity = byte/minor-unit Σ match per brand against an independent oracle (metric-engine registry discipline).

---

## 2. Phase map (at a glance)

| Phase | Name | Workstreams | Breaking? | Exit gate |
|-------|------|-------------|-----------|-----------|
| **0** | Foundations | W0, W8 (start) | No | Iceberg Silver/Gold provisioned + deployable |
| **1** | Spark Silver (dual-run) | W1 | No | Silver parity oracle green |
| **2** | Spark Gold in Iceberg (dual-run) | W2 | No | ⚠️ Revenue + attribution parity green + signed |
| **3** | StarRocks `mv_*` serving | W3 | No | Serving parity green |
| **4** | Read-seam cutover | W4 | **Yes (gated)** | DTO parity green; UI unchanged |
| **5** | Decision/AI + PG cleanup | W5, W6 | **Yes (gated)** | No analytical/AI data in PG beyond allowed |
| **6** | Retire dbt + dead paths | W7 | **Yes (gated)** | dbt removed; dashboards still served |
| **7** | Hardening + observability | W8 (finish) | No | Spark/Gold SLOs live; naming lint clean |

Phases **0–3 are additive (non-breaking)** — they build the new pipeline beside the old one. The first reader cutover is **Phase 4**, behind an approval gate. **Phases 4–6 each require explicit sign-off before they begin** (rule 2).

---

## 3. Phase detail

### PHASE 0 — Foundations (non-breaking)
**Scope (W0 + W8 start):**
- Terraform: provision Iceberg **Silver + Gold** S3 buckets + Glue catalog databases + Spark write role (today only Bronze exists — Gold-in-Iceberg is not deployable; Infra audit).
- Extend Iceberg maintenance (compaction + snapshot-expiry + crypto-shred) to Silver + Gold.
- Stand up the **parity-oracle harness** (independent recompute + minor-unit Σ comparator) — needed by every later phase.
- Begin W8 hygiene that gates nothing: kebab-case file renames, dead-package removal staging.

**Deliverable:** A deployable Iceberg Silver/Gold storage layer + a working parity harness.

**Staged PRs:**
- PR-0.1 `infra/terraform/s3-iceberg`: add Silver + Gold buckets, Glue catalogs, Spark write role.
- PR-0.2 `infra/helm`/maintenance: extend compaction/TTL/crypto-shred to Silver + Gold.
- PR-0.3 parity-oracle harness (CI job + comparator).
- PR-0.4 (W8) kebab-case file renames; remove dead `packages/identity-graph` (imported nowhere).

**Exit criteria:** Spark can CREATE + MERGE into an empty Iceberg Silver/Gold table in the provisioned catalog; parity harness runs in CI. **No reads changed — non-breaking.**

---

### PHASE 1 — Spark Silver, dual-run (non-breaking)
**Scope (W1):**
- Reimplement ~9 `silver_*` dbt models as Spark→Iceberg jobs reading **Iceberg Bronze** (`source('bronze_iceberg','collector_events')`).
- Re-home `journey-stitch`/`identity-export` TS jobs into Spark — preserve hashed-PII, tenant isolation, GDPR erasure, identity parity.
- Add missing canonical entities: payment, settlement, campaign, journey-as-entity, identity_alias (DATA-06..10).
- **Dual-run:** Spark Silver writes Iceberg Silver beside the existing dbt `brain_silver`; no reader repointed yet.

**Deliverable:** A complete Spark-built Iceberg Silver layer running in parallel with dbt Silver.

**Staged PRs:**
- PR-1.1 Spark Silver: order entities (`silver_order_state`, `silver_order_line`, `silver_product`).
- PR-1.2 Spark Silver: customer + identity (`silver_customer`, `silver_customer_identity`/journey-stitch) — ⚠️ identity/PII.
- PR-1.3 Spark Silver: touchpoint/sessions/checkout-signal/shipment/marketing-spend.
- PR-1.4 Spark Silver: new canonical entities (payment, settlement, campaign, journey, identity_alias).

**Exit criteria:** **Silver parity oracle green** — Spark Silver equals dbt/TS Silver row-for-row keyed by `(brand_id, entity_id)` for a full validation window. **No reads changed — non-breaking.**
> ⚠️ **HIGH-RISK — IDENTITY / COMPLIANCE.** PR-1.2 must not start until Security/Compliance sign off on the Neo4j→Spark identity path (enforced Cypher query-guard, GDPR-erasure parity, app-layer-only isolation backstop — SEC-01; DATA-03/09).

---

### PHASE 2 — Spark Gold in Iceberg, dual-run (non-breaking, ⚠️ gated to start)
**Scope (W2):**
- Reimplement ~11 `gold_*` dbt models + `metric-engine` business math (CM2, realized/provisional revenue recognition, CAC, LTV, ROAS, executive metrics) + `attribution-writer` apportionment (Markov/position-based + largest-remainder credit) as Spark jobs writing **Iceberg Gold**, reproducing money math byte/minor-unit-exact.
- **DROP** `feature_customer_daily` (permanent feature table forbidden; features become runtime in Phase 4).
- **Dual-run:** Spark Gold writes Iceberg Gold beside dbt `brain_gold`/TS outputs; no reader repointed yet.

**Deliverable:** A complete Spark-built **Iceberg Gold** layer running in parallel with dbt + TS Gold.

**Staged PRs:**
- PR-2.1 Spark Gold: non-money marts first (`gold_customer_360`, `gold_customer_scores`, `gold_customer_segments`, `gold_cohorts`, `gold_executive_metrics`).
- PR-2.2 ⚠️ Spark Gold: **revenue** (`gold_revenue_ledger`, `gold_revenue_analytics`, recognition + CM2 from metric-engine).
- PR-2.3 ⚠️ Spark Gold: **attribution** (`gold_attribution_paths`, `gold_marketing_attribution`, `gold_attribution_credit`, `snap_attribution_credit` — Markov/largest-remainder from attribution-writer).
- PR-2.4 Spark Gold: `gold_cac`, `snap_order_state`; drop `feature_customer_daily`.

**Exit criteria:** **Revenue + attribution parity oracle green** — exact minor-unit Σ match per brand vs current dbt+TS, sustained over a validation window. **No reads changed — non-breaking.**
> ⚠️ **HIGH-RISK — REVENUE/BILLING + ATTRIBUTION.** PR-2.2 / PR-2.3 **cannot start** until Finance/Revenue + Architecture sign off (revenue recognition basis read by billing; attribution money math). The parity oracle is the go/no-go evidence (ARCH-003/004/005/006; SPARK-001; SEC-03). **See [15-risk-assessment.md](./15-risk-assessment.md).**

---

### PHASE 3 — StarRocks `mv_*` serving (non-breaking)
**Scope (W3):**
- Build `mv_*` async materialized views over the new Iceberg Gold external catalog (zero `mv_*` exist today).
- Re-home PRIMARY-KEY upsert semantics (e.g. `gold_attribution_credit`) onto Iceberg MERGE upstream; MV becomes read-only projection.
- Recodify the serving rule to `Iceberg-Gold → StarRocks mv_* → API → UI`.
- **Dual-serve:** `mv_*` exist beside the dbt base tables; reads still hit base tables.

**Deliverable:** An `mv_*` serving layer projecting Iceberg Gold, validated against the base tables.

**Staged PRs:**
- PR-3.1 `mv_*` for non-money marts.
- PR-3.2 ⚠️ `mv_*` for revenue + attribution marts.
- PR-3.3 recodify `db/starrocks/external_iceberg_catalog.sql` to the new one-way rule.

**Exit criteria:** Serving parity — `mv_*` results match the Iceberg Gold tables and the legacy base tables. **No reads changed — non-breaking.**

---

### PHASE 4 — Read-seam cutover (BREAKING — gated)
**Scope (W4):**
- Reduce `@brain/metric-engine` to a **thin serve/read seam** over `mv_*`; delete in-TS computation bodies (keep the registry: one-definition-per-metric, money = minor units + `currency_code`).
- Repoint `feature-materialization`: keep Redis sink, change source StarRocks Gold table → Iceberg-Gold-fed `mv_*`; features become runtime (no permanent feature table).
- **Cut BFF analytics reads over to `mv_*`.** UI DTO shapes unchanged (V4 "Architecture → API → UI" order) — near-zero `apps/web` impact.

**Deliverable:** Live serving from Spark→Iceberg Gold→`mv_*`; metric-engine no longer computes business truth.

**Staged PRs:**
- PR-4.1 metric-engine serve-seam swap (non-money endpoints first).
- PR-4.2 ⚠️ metric-engine serve-seam swap (revenue/attribution endpoints).
- PR-4.3 feature-materialization source repoint to `mv_*`.

**Exit criteria:** **DTO parity green** — BFF endpoints return identical DTO shape + values before/after; contract tests green; UI unchanged; hardcoded date-window literals confirmed working against MV-served aggregates.
**Rollback:** re-point the serve seam back to the (still-deployed) dbt base tables; dbt crons remain live until Phase 6.
> ⚠️ **This is the first breaking phase — requires explicit go/no-go sign-off before it begins.** PR-4.2 inherits the revenue/attribution sign-off.

---

### PHASE 5 — Decision/AI runtime + PG operational-only cleanup (BREAKING — gated)
**Scope (W5 + W6):**
- Move recommendation/decision computation to **runtime** over features/metrics/signals/confidence.
- **Rename** PG decision tables to the four allowed ledgers (`recommendation_history`/`decision_history`/`decision_outcome`/`user_feedback`); ensure decision-loop state only.
- Relocate `dq_check_result` to Spark→Iceberg; relocate/retire `ai_provenance` (per ratification) and `recommendation_outcome`.
- Remove dangling SECURITY-DEFINER signal functions; drop dead no-op migration 0085 + 0086/0068 duplicate.
- **KEEP:** billing ledgers, ADR-0004 compliance vault, `ml.model_registry`, all RLS FORCE policies.

**Deliverable:** PG is operational-only beyond the four allowed decision ledgers + ADR-0004 exceptions; Decision/AI are runtime.

**Staged PRs:**
- PR-5.1 recommendations → runtime; decision-table rename migration.
- PR-5.2 `dq_check_result` → Spark/Iceberg; remove PG dq writes.
- PR-5.3 ⚠️ `ai_provenance` classify-or-stop (Compliance ratification); `recommendation_outcome` relocate.
- PR-5.4 migration hygiene (drop dangling functions, 0085/0086 cleanup).

**Exit criteria:** No analytical/AI data in PG beyond allowed ledgers + ADR-0004; live read paths return from the lakehouse with **no 500s**; RLS isolation preserved through every move (P0 verification).
**Rollback:** keep the relocated tables' PG copies until the lakehouse read path is confirmed; relocate-then-cutover (never drop-first).
> ⚠️ **HIGH-RISK — PG ANALYTICAL-LEDGER REMOVAL.** Blocked on Phases 1–4 existing; live routes read these tables. **Relocate-then-cutover**; preserve RLS (Security-VETO). Requires Data + Security sign-off (ARCH-009; DB-01..03).

---

### PHASE 6 — Retire dbt + dead/dormant paths (BREAKING — gated, retire-last)
**Scope (W7):**
- Remove the two gold-producing dbt crons (`recognition-refresh`, `attribution-gold-refresh`).
- Remove `db/dbt` models, dbt-runner image, entrypoint, profiles.
- **REMOVE** `apps/stream-worker/.../pg/BronzeRepository.ts` (latent raw-PII-in-PG escape); fix stale `main.ts:155` comment; confirm no env flips `BRONZE_PG_WRITE_ENABLED`.

**Deliverable:** dbt fully removed; the lakehouse is Spark-only above Bronze; no dormant PG-Bronze escape.

**Staged PRs:**
- PR-6.1 remove dbt gold crons (Argo).
- PR-6.2 remove `db/dbt` + dbt-runner image/entrypoint/profiles.
- PR-6.3 remove `BronzeRepository.ts`; fix stale comment; assert no env flag.

**Exit criteria:** `grep` clean for dbt / `BronzeRepository`; **all dashboards still serve** from Spark→Iceberg→`mv_*`; CI green.
**Rollback:** dbt crons/models are restorable from git until this phase's PRs merge; do **not** start until Phase 2/3 parity has been green for the full validation window.
> ⚠️ **HIGH-RISK — dbt REMOVAL.** This is the completion of the re-platform, not a delete. Each removal follows a green parity gate (ARCH-001/002; SPARK-001). Requires Architecture + Data sign-off.

---

### PHASE 7 — Hardening + observability (non-breaking)
**Scope (W8 finish):**
- Add Spark/StarRocks/Iceberg-Gold **freshness SLOs** to `infra/observe` (no such telemetry today — the new business-critical hops would ship without SLOs).
- Move narrow `apps/web` display-only client calcs server-side (FE-01/FE-03).
- ⚠️ **FE-02** margin cost-input transform + confidence assignment server-side — **ratify API contract first** (feeds CM2 + billing cap).

**Deliverable:** Full SLO coverage on the new compute/serving tiers; UI display-only calcs served pre-computed.

**Exit criteria:** Spark/Gold freshness SLO dashboards live; naming lint clean; UI display calcs pre-computed.

---

## 4. Sequencing safety summary

| Risk the sequence avoids | How |
|---|---|
| Blanking dashboards by deleting dbt early | dbt removal is **Phase 6**, only after Phases 1–4 dual-run + parity (rule 1) |
| Revenue/attribution divergence | Phase 2 dual-run + exact minor-unit Σ parity oracle **before** any cutover (rule 5) |
| Read-path 500s from PG table moves | Phase 5 is **blocked on** Phases 1–4; relocate-then-cutover (rule 1) |
| Cross-tenant PII leak in identity re-home | Phase 1 identity PR gated on Security/Compliance + Cypher query-guard |
| Irreversible cutovers | Every cutover PR paired with a documented rollback (rule 4); dbt stays deployed until Phase 6 |
| Starting a breaking phase without approval | Phases 4/5/6 each require explicit go/no-go before they begin (rule 2) |

---

## 5. Bottom line

The plan is **additive for Phases 0–3** (the new Spark→Iceberg→`mv_*` pipeline is built beside the live one), and **breaking only from Phase 4**, where each step is **gated, parity-proven, and reversible.** dbt is retired **last** (Phase 6), only after the Spark replacement has served correctly for a full validation window. The load-bearing sign-off items and rollback recipes are detailed in [15-risk-assessment.md](./15-risk-assessment.md); the executive scorecard is in [16-final-compliance-report.md](./16-final-compliance-report.md).
