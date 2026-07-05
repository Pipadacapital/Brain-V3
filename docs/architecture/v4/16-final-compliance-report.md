# 16 — Final Compliance Report (Brain V4)

**Status:** Decision-grade synthesis deliverable — the executive compliance scorecard
**Scope:** Conformance of the implemented system vs. the OFFICIAL Brain V4 architecture across the **12 core principles** and the **8 workstream audits + RECON-1**, with violation counts, keystone violations, the explicit "architecture wins" conflict list, and the sign-off gate.
**Rule of adjudication:** When code / migrations / dbt / UI / APIs disagree with V4, **ARCHITECTURE WINS.**
**Evidence base:** the validated audit bundle + sibling reports [01](./01-architecture-impact-report.md)–[15](./15-risk-assessment.md).

> ⚠️ **HIGH-RISK** callouts mark load-bearing changes requiring stakeholder sign-off before execution (see [15-risk-assessment.md](./15-risk-assessment.md)).

---

## 1. Executive verdict

The V4 **spine is half-built and the ingress half is genuinely conformant** (Collector ingress, Spark Bronze hop, Neo4j identity, Redis runtime discipline, consumer-only UI, tenant-isolation spine). The **compute and serving tiers are an inversion of V4**:

- **Spark builds Bronze only** — 4 jobs; **zero Spark Silver/Gold jobs.**
- **dbt is the live Silver+Gold compute engine** — ~30 models, ArgoCD-deployed, hourly crons producing revenue + attribution truth. V4 says **dbt is REMOVED.**
- **Gold lives in StarRocks base tables** (`brain_gold.*`) and residual PG ledgers — **zero `mv_*` serving views exist.** V4 says **Gold lives in Iceberg; StarRocks serves `mv_*` only.**
- **Business truth is computed in TypeScript** (`@brain/metric-engine` ~73 files; `@brain/attribution-writer`). V4 says **Spark calculates.**

The drift is **one root inversion**, not diffuse defects. The fix is a **Spark-first, parity-gated, store-then-cutover re-platform**, never a big-bang dbt deletion ([13](./13-refactoring-plan.md), [14](./14-implementation-plan.md)).

---

## 2. The 12-principle scorecard

| # | V4 Principle | Verdict | Evidence |
|---|--------------|:-------:|----------|
| 1 | Spark is the ONLY computation engine | ❌ **VIOLATED** | Spark builds Bronze only (4 jobs); Silver/Gold computed by dbt (~30 models) + TS metric-engine (~73 files) + app jobs. Zero Spark Silver/Gold jobs. |
| 2 | Bronze owns raw truth | ✅ **CONFORMANT** | `bronze_materialize.py` idempotent MERGE INSERT-only on `(brand_id,event_id)` *(writer since replaced by the Kafka Connect sink, ADR-0010)*; PG `bronze_events` dropped (0070). |
| 3 | Silver owns canonical truth | ⚠️ **PARTIAL** | Silver well-modeled (per-entity, brand_id-leading, minor-units+currency, additive/deterministic, ADR-0004) **but built by dbt+TS, stored in StarRocks.** Canonical gaps: payment, settlement, campaign, journey-entity, identity_alias. |
| 4 | Gold owns business truth | ❌ **VIOLATED** | Gold computed by dbt+TS, stored in StarRocks base tables (+ residual PG ledgers), not Iceberg. |
| 5 | StarRocks owns serving ONLY (`mv_*`) | ❌ **VIOLATED** | StarRocks owns Gold base tables; **zero `mv_*` views.** One-way `Iceberg→dbt→StarRocks` codified. |
| 6 | Redis owns runtime state | ✅ **CONFORMANT** | All keys TTL'd + tenant-prefixed; feature-store/dedup/retry/rate-limit; no SoR use. |
| 7 | AI is runtime | ❌ **VIOLATED** | `ai_config.ai_provenance` permanently persists AI output in PG (redacted-only). |
| 8 | Decision Engine is runtime | ⚠️ **PARTIAL** | Recs computed in TS; PG holds `recommendation`/`recommendation_action`/`recommendation_outcome`/`decision_log` — only the four allowed ledgers may remain. |
| 9 | Dashboards are consumers | ✅ **CONFORMANT** | `apps/web` BFF-only, no lakehouse access (grep clean), honest empty states, no mocks. (Upstream caveat: DTOs originate from a non-V4 compute tier.) |
| 10 | PostgreSQL stores OPERATIONAL data ONLY | ⚠️ **PARTIAL** | Bulk evacuated (0070/0098/0099/0101/0103/0105). Residual analytical: `dq_check_result`, `ai_provenance`, `recommendation_outcome`. |
| 11 | Neo4j owns identity | ✅ **CONFORMANT** | `Neo4jIdentityRepository.ts` is SoR; PG identity graph dropped (0101). ⚠️ Isolation is app-layer-only (P0 risk SEC-01). |
| 12 | Medallion is compulsory | ⚠️ **PARTIAL** | Bronze hop conformant; Silver/Gold hops built by wrong engines and stored in wrong layer. |

**Tally: 4 conformant · 4 partial · 4 violated.** The 4 violations + the Silver/Gold partials all collapse onto the **single compute-and-storage inversion**.

**dbt-REMOVED future assumption:** ❌ not met — dbt is the live, ArgoCD-deployed compute engine.

---

## 3. Audit conformance summary (8 workstreams + RECON-1)

| Audit workstream | Headline verdict | Conformant anchors | Keystone violations |
|---|---|---|---|
| **RECON-1** (runtime data-flow) | Spine right, compute/serving inverted | Collector, Bronze hop, Neo4j, UI | No Spark Silver/Gold; dbt+TS compute; Gold in StarRocks |
| **Principal Architect** (core principles) | Inversion confirmed with line evidence | Bronze hop, Neo4j, UI, Redis | ARCH-001..006/008/009 (Spark-not-compute, dbt-builds-Gold, TS business truth, PG analytical ledgers) |
| **Data Architecture** (medallion/canonical) | Silver well-modeled but mis-homed | Bronze-Iceberg SoR, Silver discipline, Neo4j identity SoR | DATA-01/02/05/11/15 (dbt→Spark, StarRocks→Iceberg); DATA-06..10 (missing canonical entities) |
| **Staff SWE** (repo/boundaries/ownership) | DDD clean; ownership wrong | 13 clean bounded contexts, no cross-module reaches, no writer duplication | Business truth in TS; dbt builds Silver/Gold; dead `identity-graph`; 125 PascalCase files |
| **Principal Data Engineer** (Spark/dbt/topics) | Largest workstream; full re-platform | Bronze append-only/replayable; staging reads Iceberg | SPARK-001..005 (no Spark Silver/Gold, zero `mv_*`, Gold in StarRocks); SPARK-007/015 (topics, `ledger_source=pg`) |
| **PostgreSQL/DB** (operational-only) | Mostly evacuated; residual analytical | Bulk analytical dropped; RLS FORCE; ADR-0004 vault | DB-01..03 (`dq_check_result`/`ai_provenance`/`recommendation_outcome`); migration hygiene (0085/0086) |
| **Platform/Infra** (deployment/observability) | Ingress + supply-chain strong; compute inverted | Redpanda→Iceberg Bronze, Redis TTL discipline, signed+pinned images, observability spine | Spark-Bronze-only, dbt-as-compute, Gold-in-StarRocks, no Iceberg Silver/Gold provisioned, no Spark/Gold SLOs |
| **Security & Compliance** | Tenant isolation strong; identity has no DB backstop | Kafka/Iceberg/Redis/PG-RLS tenant keys, PII vault, NLQ redaction, cross-tenant guard, consumer-only UI | SEC-01 (Neo4j no-RLS P0), SEC-02 (`ai_provenance`), SEC-03 (attribution in StarRocks/TS), SEC-04/05 (PG analytical), SEC-06 (dormant PG-Bronze) |
| **Frontend** (apps/web) | Overwhelmingly conformant consumer | BFF-only, no mocks, honest empty states, money minor-units, engine-computed DTOs | FE-02 (margin cost-input transform); FE-01/FE-03 (display-only client calcs) |

---

## 4. Violation counts

### By severity

| Severity | Count | Items |
|----------|:-----:|-------|
| ⚠️ **HIGH-RISK** (load-bearing, sign-off required) | **7** | R-01 revenue parity, R-02 attribution parity, R-03 dbt-removal ordering, R-04 Neo4j PII leak (P0), R-05 RLS regression (P0), R-06 PG-ledger live-route 500s, R-07 source-cutover event loss |
| **High** | **5** | Spark-not-compute (P1), Gold-in-StarRocks (P4/P5), dbt-as-compute, connector-dedup relocation (DB-08), topic-taxonomy re-partition |
| **Medium** | **8** | `ai_provenance` (P7), Decision recs in TS (P8), residual PG analytical (P10), feature_customer_daily permanent table, infra-not-provisioned, observability blind spot, DTO drift, FE-02 margin |
| **Low** | **2** | 125 PascalCase file names, narrow UI display calcs (FE-01/FE-03) |

### By classification (existing / equivalent / missing / raw-only / reject)

| Classification | Count | Examples |
|----------------|:-----:|----------|
| **Existing-but-wrong-owner** (REFACTOR) | majority | metric-engine compute, attribution-writer, dbt Silver/Gold, StarRocks base tables, app-code journey-stitch/dq/feature-materialization |
| **Missing** (net-new build) | 7+ | Spark Silver jobs, Spark Gold jobs, `mv_*` serving layer, Iceberg Silver/Gold provisioning, canonical entities (payment/settlement/campaign/journey/identity_alias), Spark/Gold SLOs, Cypher query-guard |
| **Raw-only / dormant** (REMOVE) | 3 | `BronzeRepository.ts` (dormant PG-Bronze), `packages/identity-graph` (dead), dead migration 0085 / duplicate 0086 |
| **Reject** (no change — ratify as-is) | 1 | Unified-envelope topic taxonomy (`collector.event.v1`) — working design; ratify rather than re-partition |
| **Conformant** (KEEP, guard) | 7 spine items | Collector, Bronze hop, Neo4j, Redis, UI, tenant-isolation spine, observability/supply-chain |

---

## 5. Keystone violations

The three keystones whose remediation cascades to nearly every other item:

1. **KEYSTONE-A — Spark is not the compute engine; dbt + TypeScript are.**
   Spark builds Bronze only (4 jobs, zero Silver/Gold). dbt (~30 models, ArgoCD-deployed) and `@brain/metric-engine` (~73 TS files) + `@brain/attribution-writer` compute all Silver/Gold/business truth. Remediating this (Spark Silver → Spark Gold) resolves Principles 1, 3, 4, 12 and audit findings ARCH-001..006, DATA-01/02, SPARK-001..005, SWE-01/02/04.

2. **KEYSTONE-B — Gold lives in StarRocks (and residual PG), not Iceberg; zero `mv_*` exist.**
   `brain_gold.*` base tables own customer_360/attribution_credit/revenue_ledger; StarRocks owns Gold instead of serving it. Remediating this (Iceberg Gold + `mv_*` serving) resolves Principles 4, 5 and findings DATA-05/11/15, SPARK-002/003, SEC-03, the Infra inversion.

3. **KEYSTONE-C — Identity Silver has no DB-level tenant backstop (P0).**
   Neo4j identity isolation is app-layer-only — no RLS. journey-stitch/identity-export are TS-computed canonical Silver carrying hashed PII. Remediating this (Spark-built identity Silver + enforced Cypher query-guard + GDPR parity) resolves SEC-01, DATA-03/09 and removes the single highest-blast-radius leak surface.

The remaining violations (AI persistence, Decision recs in TS, residual PG analytical, dormant PG-Bronze, naming, FE display calcs) are **consequences or long-tail** of these three.

---

## 6. Explicit "architecture wins" conflict list

Where the implemented system disagrees with V4, **V4 prevails**; the system changes (not the architecture):

| # | Code/infra reality | V4 ruling (architecture wins) | Disposition |
|---|--------------------|-------------------------------|-------------|
| 1 | dbt builds Silver + Gold (~30 models, live crons) | **dbt is REMOVED; Spark is the only compute** | Re-platform to Spark, retire dbt last |
| 2 | Gold stored in StarRocks `brain_gold.*` base tables | **Gold lives in Iceberg; StarRocks serves `mv_*` only** | Move Gold→Iceberg; build `mv_*` |
| 3 | `@brain/metric-engine` / `attribution-writer` compute CM2/LTV/revenue/attribution in TS | **Spark calculates, StarRocks serves, APIs expose, UI renders** | metric-engine → thin serve seam |
| 4 | `feature_customer_daily` permanent feature table (dbt) | **Features are runtime/Redis; NO permanent feature tables** | Drop table; runtime features from `mv_*` |
| 5 | `ai_config.ai_provenance` persists AI output in PG | **AI is runtime; outputs not permanently stored** | Classify as ratified audit exception or stop |
| 6 | PG holds `recommendation`/`recommendation_action`/`recommendation_outcome`/`decision_log` | **Only `recommendation_history`/`decision_history`/`decision_outcome`/`user_feedback` may persist** | Rename to allowed ledgers; recs runtime |
| 7 | `dq_check_result` analytical stream in PG | **PG operational ONLY; analytics in the lakehouse** | Relocate to Spark→Iceberg |
| 8 | Dormant `BronzeRepository` PG-Bronze write path | **Bronze owns raw truth in Iceberg (sole SoR)** | REMOVE |
| 9 | `ledger_source=pg` default lets Silver read PG as analytical source | **Silver builds from Iceberg Bronze** | Flip to Iceberg after Bronze-completeness proven |
| 10 | StarRocks PRIMARY-KEY upsert owns `gold_attribution_credit` | **Iceberg owns the table; MV is a read-only projection** | Re-home upsert to Iceberg MERGE |

**No conflicts resolved in code's favor.** The one item proposed for *ratification-as-compliant* (rather than change) is the unified-envelope topic taxonomy (§5 RECON; ratify or re-partition — Architecture/Data decision).

---

## 7. Conformant foundation (KEEP — guard against regression)

Verified-conformant; the load-bearing base to build forward from (01 §5):

1. Collector ingress (Source → PG `collector_spool` transient → Redpanda).
2. Spark Bronze hop (idempotent MERGE INSERT-only; the one fully-conformant medallion hop).
3. Neo4j identity SoR.
4. Redis runtime discipline (every key TTL'd + tenant-prefixed; no SoR use).
5. Consumer-only UI (BFF-only, honest empty states, money minor-units, no mocks).
6. Tenant-isolation spine (Kafka partition key, Iceberg `bucket(256,brand_id)`, Redis prefixes, PG RLS FORCE under NOBYPASSRLS `brain_app`). **P0 — any regression is Security-VETO.**
7. Observability + supply chain (OTel→Prometheus/Loki/Tempo/Grafana; signed + digest-pinned images; Helm fail-closes on unpinned/`:latest`).

---

## 8. Sign-off gate (must be green before execution)

No phase that touches a load-bearing item begins until its stakeholder gate is signed and its parity gate is green (see [14 §3](./14-implementation-plan.md), [15 §5](./15-risk-assessment.md)):

| Gate | Owner | Evidence required |
|------|-------|-------------------|
| ⚠️ Revenue parity (R-01) | Finance/Revenue + Architecture | Exact minor-unit Σ oracle green per brand (dual-run window) |
| ⚠️ Attribution parity (R-02) | Finance/Revenue + Architecture | Byte-exact largest-remainder credit Σ oracle green |
| ⚠️ dbt-removal ordering (R-03) | Architecture + Data | Phases 2/3 parity green for full validation window |
| ⚠️ Neo4j identity leak / GDPR (R-04, P0) | Security/Compliance | Enforced Cypher query-guard + GDPR-erasure + identity parity |
| ⚠️ RLS regression (R-05, P0) | Security | Per-tenant isolation regression tests green on every PG change |
| ⚠️ PG-ledger removal (R-06) | Data + Security | Relocate-then-cutover; live-route smoke green |
| ⚠️ Source cutover / event loss (R-07) | Data Engineering | Bronze-completeness proof per source before `ledger_source` flip |
| Topic taxonomy (R-08) | Architecture + Data | Ratify unified-envelope as V4-compliant, or approve re-partition plan |

---

## 9. Bottom line

Brain V4 is **architecturally sound and the spine is already half-built and conformant.** The work is **concentrated in one inversion** — compute in dbt+TS, Gold in StarRocks/PG — manifested as **three keystones** (Spark-not-compute, Gold-not-Iceberg, identity-no-DB-backstop). Remediation is a **Spark-first, parity-gated, store-then-cutover re-platform** ([13](./13-refactoring-plan.md), [14](./14-implementation-plan.md)), gated by **seven load-bearing sign-offs** ([15](./15-risk-assessment.md)). Where code disagrees with V4, **architecture wins** — and the system changes accordingly.
