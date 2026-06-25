# 15 — Risk Assessment (Brain V4)

**Status:** Decision-grade synthesis deliverable
**Scope:** Migration risks ranked by likelihood × impact, the **HIGH-RISK load-bearing items requiring stakeholder sign-off BEFORE execution**, plus mitigations and rollback.
**Rule of adjudication:** ARCHITECTURE WINS over code / migrations / dbt / UI / APIs.
**Evidence base:** the validated audit bundle (8 workstream audits + RECON-1) + sibling reports [01](./01-architecture-impact-report.md), [02](./02-repository-impact-report.md), [13](./13-refactoring-plan.md), [14](./14-implementation-plan.md).

> ⚠️ **HIGH-RISK** = load-bearing change (revenue, attribution, billing, identity/PII, tenant isolation). Each named item below must be **signed off by the listed stakeholder + parity-gated** before its phase begins.

---

## 1. Risk matrix (likelihood × impact)

Likelihood: **L** low / **M** medium / **H** high. Impact: **L/M/H/Critical**.

| ID | Risk | Likelihood | Impact | Severity | Phase |
|----|------|:----------:|:------:|:--------:|-------|
| R-01 | Revenue/billing divergence — Spark Gold revenue ledger ≠ dbt recognition basis (billing reads it) | M | **Critical** | ⚠️ **HIGH** | 2/4 |
| R-02 | Attribution money-math divergence — Markov/largest-remainder credit drifts on Spark port | M | **Critical** | ⚠️ **HIGH** | 2/4 |
| R-03 | Gold→Iceberg cutover blanks dashboards if dbt removed before parity | M | **Critical** | ⚠️ **HIGH** | 6 |
| R-04 | Cross-tenant PII leak — Neo4j has no RLS; identity re-home drops a `brand_id` Cypher predicate | M | **Critical** | ⚠️ **HIGH** (P0) | 1 |
| R-05 | RLS/tenant-isolation regression during PG analytical-table moves | L | **Critical** | ⚠️ **HIGH** (P0) | 5 |
| R-06 | PG analytical-ledger removal causes live-route 500s (read by `attribution.routes.ts` et al.) | M | **H** | ⚠️ **HIGH** | 5 |
| R-07 | Source-cutover event loss — flip `ledger_source=pg`→Iceberg before Bronze completeness proven | M | **H** | ⚠️ **HIGH** | 1/2 |
| R-08 | Topic-taxonomy re-partition (if pursued) touches every producer — "No event loss" | L | **H** | High | pre-0 |
| R-09 | Infra not provisioned for Gold-in-Iceberg — Terraform has Bronze only | H | **M** | Medium | 0 |
| R-10 | Scope/schedule — ~30 dbt models + ~73 metric-engine modules + app jobs all re-platformed | H | **M** | Medium | 1–6 |
| R-11 | Observability blind spot — no Spark/StarRocks/Gold-freshness SLOs on the new tiers | H | **M** | Medium | 7 |
| R-12 | AI-output persistence (`ai_provenance`) — compliance classification debt | M | **M** | Medium | 5 |
| R-13 | Feature-table contradiction — `feature_customer_daily` permanent table dropped without runtime replacement | L | **M** | Medium | 2/4 |
| R-14 | DTO drift — read-seam swap changes a DTO shape, breaking UI | L | **M** | Medium | 4 |
| R-15 | Connector dedup loss — relocating `connector_webhook_raw_archive` body bodies loses `body_sha256` dedup | L | **H** | High | 5/6 |
| R-16 | UI display-calc / FE-02 margin transform mis-states CM2 / billing cap | L | **M** | Medium | 7 |
| R-17 | Naming churn (125 PascalCase file renames) causes import breakage | L | **L** | Low | 0/7 |

---

## 2. ⚠️ HIGH-RISK load-bearing items — sign-off gates

Each item below **must be ratified by the named stakeholder + pass its parity gate before the phase begins** ([14 rule 2](./14-implementation-plan.md)). These are the "architecture wins, but prove it first" controls.

### R-01 ⚠️ Revenue / Billing parity
**What:** `gold_revenue_ledger` is the recognition basis **read by billing**; CM2 / realized-revenue are computed in TS (`contribution-margin.ts:147`, `realized-revenue.ts:47-52`) and feed margin + the billing cap. Removing dbt or relocating compute before a Spark→Iceberg revenue ledger is parity-proven **zeros out revenue serving** (ARCH-003/005; SPARK-001; Infra audit).
**Likelihood × impact:** M × Critical.
**Sign-off:** Finance / Revenue + Architecture.
**Mitigation:** Dual-run Spark Gold beside dbt (Phase 2); **exact minor-unit Σ parity oracle** per brand over a full validation window; reproduce the recognition rule + CM2 arithmetic byte-exact; cut reads over only on green parity (Phase 4).
**Rollback:** re-point the serve seam to the still-deployed dbt revenue ledger; dbt `recognition-refresh` cron stays live until Phase 6.

### R-02 ⚠️ Attribution money-math parity
**What:** `gold_attribution_credit` (StarRocks PRIMARY-KEY table) + `gold_marketing_attribution`/`gold_attribution_paths` are the attribution SoR, computed in TS (`attribution-reconcile.ts`, `@brain/attribution-writer` Markov/position-based + largest-remainder credit) and written to StarRocks (`index.ts:96,346`). Porting to Spark must preserve **byte-exact** apportionment (ARCH-004/006; SEC-03).
**Likelihood × impact:** M × Critical.
**Sign-off:** Finance / Revenue + Architecture.
**Mitigation:** Spark port reproduces largest-remainder credit + recognition rule exactly; attribution Σ parity oracle (per brand, per channel) green before cutover; no-float→quantize→exact-money discipline preserved.
**Rollback:** re-point to dbt + TS attribution outputs; `attribution-gold-refresh` cron stays live until Phase 6.

### R-03 ⚠️ Gold→Iceberg cutover / dbt removal ordering
**What:** dbt is the live, ArgoCD-deployed Silver+Gold compute engine; its two gold crons produce billing/attribution truth. Deleting dbt before Spark Gold + `mv_*` are parity-proven blanks every dashboard (ARCH-001/002; SPARK-001).
**Likelihood × impact:** M × Critical.
**Sign-off:** Architecture + Data Engineering.
**Mitigation:** dbt removal is **Phase 6 (retire-last)**; only after Phases 1–4 dual-run + parity green for a full window; build-first / cutover / retire-last doctrine ([14 rule 1](./14-implementation-plan.md)).
**Rollback:** dbt models + crons restorable from git until Phase 6 PRs merge.

### R-04 ⚠️ Cross-tenant PII leak (P0) — Neo4j identity re-home
**What:** Neo4j identity isolation is **app-layer-only — no RLS backstop**. One `brand_id`-less Cypher query leaks identity/PII across tenants. Re-homing journey-stitch/identity-export from TS to Spark touches this spine (SEC-01; DATA-03/09).
**Likelihood × impact:** M × Critical. **P0 / Security-VETO.**
**Sign-off:** Security / Compliance.
**Mitigation:** enforced Cypher **query-guard** (every query carries a `brand_id` predicate — not convention); preserve GDPR-erasure parity; identity parity oracle (current vs Spark-built identity_alias); tenant-scoped subgraph tests with negative controls.
**Rollback:** keep the TS journey-stitch/identity-export path until the Spark identity Silver is parity + isolation verified.

### R-05 ⚠️ RLS / tenant-isolation regression (P0) — PG table moves
**What:** 51 RLS FORCE `*_isolation` policies under NOBYPASSRLS `brain_app` are the tenant-isolation control. The Phase 5 analytical-table moves must not regress any policy (DB audit topRisks; multi-tenancy audit). A cross-tenant leak is a P0 Security-VETO surface.
**Likelihood × impact:** L × Critical.
**Sign-off:** Security.
**Mitigation:** no schema/move change touches an RLS-bearing table without an isolation regression test (per-tenant read returns only own rows; missing-GUC → 0 rows); keep ADR-0004 compliance vault + billing ledgers in PG untouched.
**Rollback:** migrations are forward-only but staged; keep relocated-table PG copies until lakehouse reads verified.

### R-06 ⚠️ PG analytical-ledger removal → live-route 500s
**What:** `dq_check_result` / `recommendation_action` are read by live routes; the attribution read path historically referenced PG Gold (`attribution.routes.ts:69`). Dropping them before the lakehouse replacement risks read-path 500s (ARCH-009; DB-01..03).
**Likelihood × impact:** M × High.
**Sign-off:** Data + Security.
**Mitigation:** **blocked on Phases 1–4**; **relocate-then-cutover** (never drop-first); keep the four allowed decision ledgers; smoke every live route against the lakehouse read path before dropping the PG table.
**Rollback:** retain PG copies until the lakehouse read path is confirmed.

### R-07 ⚠️ Source-cutover event loss
**What:** Silver defaults to reading PG via JDBC (`ledger_source=pg`). Flipping the SoR to Iceberg-built Spark Gold before **Bronze completeness** is proven drops revenue/spend data (Bronze today is largely `order.live.v1` + `spend.live.v1`) (SPARK-007/015).
**Likelihood × impact:** M × High.
**Sign-off:** Data Engineering.
**Mitigation:** prove Bronze event-coverage completeness per source before flipping `ledger_source`; backfill-lane isolation (`order.backfill.v1`) preserved into Bronze; parity-verify before retiring the PG analytical read path.
**Rollback:** keep `ledger_source=pg` as the live path until Iceberg Bronze coverage + parity are green.

---

## 3. Other notable risks (mitigation summary)

| ID | Mitigation | Rollback |
|----|-----------|----------|
| **R-08** Topic-taxonomy | **Ratify the unified-envelope (`collector.event.v1`) taxonomy as V4-compliant** rather than re-partition (working design: server-trusted bronze sets, backfill-lane isolation). Only re-partition with a full producer + Bronze-consumer migration plan (01 §3.1). | n/a — prefer no change |
| **R-09** Infra | Phase 0 Terraform provisions Iceberg Silver+Gold buckets/catalog/write role first; nothing downstream proceeds until deployable. | revert Terraform PR |
| **R-10** Scope | Stage entity-by-entity behind parity gates (Phases 1–2 PR breakdown); never big-bang. | per-PR revert |
| **R-11** Observability | Phase 7 adds Spark/StarRocks/Iceberg-Gold freshness SLOs before final cutover declared done. | n/a |
| **R-12** AI persistence | Phase 5: classify `ai_provenance` as a ratified audit-ledger exception (preserve redact-before-store) **or** stop persisting. | keep redacted-only persistence pending ratification |
| **R-13** Feature table | Drop `feature_customer_daily` only when runtime feature path (Redis online store sourced from `mv_*`) is live (Phase 4). | keep dbt feature table until runtime path verified |
| **R-14** DTO drift | DTO parity contract tests in Phase 4; UI DTO shapes are stable by design (V4 "Architecture → API → UI"). | re-point seam to dbt base tables |
| **R-15** Connector dedup | Preserve `body_sha256` dedup when relocating `connector_webhook_raw_archive` raw bodies to Iceberg Bronze, or risk duplicate order processing (DB-08). | keep PG raw archive until Iceberg dedup proven |
| **R-16** FE-02 margin | Move percent→basis-points conversion + `cost_confidence` server-side **after** API-contract ratification (feeds CM2 + billing cap). | keep client-side calc until contract ratified |
| **R-17** Naming churn | Mechanical kebab-case renames with import-path codemod + full typecheck gate. | per-PR revert |

---

## 4. Rollback doctrine (global)

1. **dbt stays deployed until Phase 6.** Every cutover before then is reversible by re-pointing the read seam back to dbt/StarRocks base tables.
2. **Relocate-then-cutover for PG.** Never drop a PG analytical table before the lakehouse read path is verified; keep PG copies through the validation window.
3. **Dual-run + parity oracle gate** every revenue/attribution change; cut reads over only on green parity.
4. **Forward-only migrations are staged**, paired with a documented re-enable path (re-create the relocated table from the lakehouse if a read regresses).
5. **RLS regression tests are mandatory** on any PG change; a failure is a hard stop (P0 / Security-VETO).

---

## 5. Sign-off gate (must be green before the named phase starts)

| Phase | Gate | Stakeholders |
|-------|------|--------------|
| **1** (identity PR) | Cypher query-guard + GDPR-erasure + identity parity (R-04) | Security / Compliance |
| **2** (revenue/attribution PRs) | Exact minor-unit Σ parity oracle (R-01, R-02) | Finance/Revenue + Architecture |
| **4** (read-seam cutover) | DTO parity + revenue/attribution sign-off carried (R-14, R-01/02) | Architecture |
| **5** (PG cleanup) | Relocate-then-cutover + RLS regression green (R-05, R-06) | Data + Security |
| **6** (dbt removal) | Phases 2/3 parity green for full window (R-03) | Architecture + Data |
| **pre-0** | Topic-taxonomy decision (R-08) | Architecture + Data |

---

## 6. Bottom line

The migration's risk is **concentrated in five Critical-impact items** (R-01..R-05) — revenue parity, attribution parity, dbt-removal ordering, Neo4j identity leak, and RLS regression — every one of which is **gated, parity-proven, and reversible** under the build-first / cutover / retire-last doctrine. None requires a big-bang; all require sign-off. The full scorecard and the explicit "architecture wins" conflict list are in [16-final-compliance-report.md](./16-final-compliance-report.md).
