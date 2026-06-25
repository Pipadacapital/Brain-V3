# 12 — API / BFF Impact Report — Brain V4 Migration

**Scope:** the API/BFF surface in `apps/core/src/modules/frontend-api` (the `/api/v1/...` + `/api/bff/...` routes the web app consumes) and its dependency seam `@brain/metric-engine` / `@brain/attribution-writer`. This report classifies every API surface as **serve** (V4-conformant: read a pre-computed mart/MV and shape a DTO) vs **expose-business-logic** (V4-violating: compute business truth at request/job time), and enumerates the API/DTO changes V4 implies.

**Evidence base:** the validated V4 audit bundle (RECON-1, Principal Architect, Data Architecture, Spark/DE, PG, Security) plus direct source verification noted inline.

**V4 rules under audit (verbatim):**
> Spark calculates, StarRocks serves, APIs expose, UI renders. Architecture change → API change → UI change.
> StarRocks owns serving ONLY (mv_*); does NOT own customer_360/attribution/realized_revenue/business-logic/recommendations. Gold is stored in ICEBERG.
> NEVER in PG: events, analytics, clickstream, customer history, attribution, recommendations. Decision runtime may only store: recommendation_history, decision_history, decision_outcome, user_feedback.
> APIs REST: `GET /customers/{id}`. Events dot.lower. Tables/columns snake_case.

---

## 0. Executive verdict

The BFF's **REST shape, auth, tenancy, validation, and honest-empty-state behavior are conformant.** The V4 violation is **mechanical, not structural**: BFF analytics endpoints **compute business truth in TypeScript at request time** (via `@brain/metric-engine` over StarRocks Silver), instead of reading a Spark-built Iceberg-Gold mart served through a StarRocks `mv_*` materialized view.

**The defining anti-pattern, verified in source:**

```ts
// apps/core/src/modules/frontend-api/internal/routes/analytics-core.routes.ts:84-92
if (!srPool) { return reply.code(503).send({ ... 'Silver tier (StarRocks) not available' }); }
...
const result = await getRevenueTimeseries(auth.brandId, { fromDate, toDate, grain }, { srPool });
return reply.send({ request_id: requestId, data: result });
```

The BFF hands a **StarRocks connection pool (`srPool`)** into a metric-engine function that runs the **revenue computation at request time**. V4 requires that computation to have already happened in Spark (→ Iceberg Gold → `mv_*`), with the BFF doing a thin `SELECT … FROM mv_revenue_timeseries WHERE brand_id = $1` and DTO-shaping only. The error string itself ("Silver tier (StarRocks)") admits the BFF is reading **Silver**, not a served Gold MV.

**Net API impact:** **DTO contracts stay stable** (so the UI is shielded — see report #11), but the **implementation behind ~30+ analytics endpoints must flip from compute-over-Silver to serve-from-`mv_*`-over-Iceberg-Gold.** A handful of endpoints additionally read **PG analytical/Gold ledgers** that V4 forbids and must be repointed. The endpoints' job is to **expose**, never to **calculate**.

---

## 1. BFF surface inventory (verified) — serve vs expose-business-logic

Counts below are verified route-handler registrations per file in `apps/core/src/modules/frontend-api/internal/routes/`.

| Route file | Handlers (verified) | Today: compute or serve? | V4 disposition |
|---|---|---|---|
| `analytics-core.routes.ts` | 9 (`:41,99,150,198,221,263,312,357,415`) | **EXPOSE-LOGIC** — calls metric-engine over `srPool` (revenue-timeseries, kpi-summary, etc.) | REPOINT to `mv_*` |
| `analytics-journey.routes.ts` | 8 (`:49…480`) | **EXPOSE-LOGIC** — metric-engine over StarRocks Silver | REPOINT to `mv_*` |
| `analytics-logistics.routes.ts` | 11 GET + 1 POST (`:53…476`, POST `:342`) | **EXPOSE-LOGIC** (GETs); POST is a cost/config write | REPOINT GETs; keep write as operational |
| `analytics-marketing.routes.ts` | 5 (`:37,132,216,250,285`) | **EXPOSE-LOGIC** — ROAS/spend over metric-engine | REPOINT to `mv_*` |
| `attribution.routes.ts` | 1 POST + 4 GET (`:39` POST, `:93,136,179,223`) | **EXPOSE-LOGIC + PG-GOLD READ** — reads `attribution_credit_ledger (Postgres Gold, 0032)` (verified comment `:69`) | ⚠️ REPOINT to Iceberg-Gold-fed `mv_*`; drop PG read |
| `decisions.routes.ts` | 4 GET + 3 POST (`:51,99,145,211,252,309`) | MIXED — recommendation read (compute) + decision-ledger write | REPOINT reads; KEEP only the 4 allowed PG decision ledgers |
| `feedback.routes.ts` | 3 GET (`:41,64,86`) | EXPOSE-LOGIC (CAPI/conversion-feedback) | REPOINT to `mv_*` |
| `dashboard.routes.ts` | 8 GET (`:58…541`) | MIXED — control-plane (PG, ✅) + some analytics tiles (compute) | SPLIT: PG tiles stay, analytics tiles repoint |
| `dashboard.queries.ts` | (queries) | **SERVE (✅ operational)** — orgs/brands/connectors/pixel from PG | KEEP (operational data, V4-valid) |
| `auth-session.routes.ts` | 8 (`:41…575`) | **OPERATIONAL (✅)** — session/register/login/etc. over PG | KEEP |
| `billing.routes.ts` | 6 (`:46…325`) | **OPERATIONAL (✅)** — invoices/plans/meter over PG billing | KEEP (billing is operational) |
| `consent.routes.ts` | 4 GET (`:37,58,80,103`) | **OPERATIONAL/COMPLIANCE (✅)** — consent vault (PG, ADR-0004) | KEEP |
| `identity.routes.ts` | 5 GET + 3 POST (`:47…345`) | MIXED — identity reads (Neo4j ✅) + identity-projection analytics | KEEP Neo4j reads; repoint any StarRocks-projection reads |
| `tracking.routes.ts` | 2 GET (`:27,62`) | **OPERATIONAL (✅)** — pixel/tracking health | KEEP |
| `ask.routes.ts` | 1 POST (`:40`) | AI runtime (✅ runtime) — but persists provenance to PG (see §4) | KEEP runtime; ⚠️ ai_provenance PG-store violates V4 |

**Summary:** of the BFF's ~80 handlers, the **operational/control-plane subset (auth, billing, consent, tracking, dashboard control-plane queries, connector config) is V4-conformant and stays.** The **analytics subset (~40 handlers across analytics-core/journey/logistics/marketing, attribution, feedback, and the analytics dashboard tiles) is the expose-business-logic violation** and must be repointed from compute-over-Silver to serve-from-`mv_*`.

---

## 2. The core API change: compute-over-Silver → serve-from-MV

### 2.1 What changes inside each analytics handler

| Aspect | Today (V4-violating) | V4 target |
|---|---|---|
| Data source | `srPool` → metric-engine TS computes over StarRocks **Silver** (`brain_silver.*`) and dbt-built **Gold tables** (`brain_gold.*`) | StarRocks **`mv_*`** materialized view over **Iceberg Gold** (Spark-built) |
| Where the math runs | **at request time, in Node** (`getRevenueTimeseries(...)`, CM2, attribution Markov, CAC, ROAS in `@brain/metric-engine` ~73 modules + `@brain/attribution-writer`) | **already done in Spark**; BFF runs `SELECT … FROM mv_…` only |
| `@brain/metric-engine` role | the **compute engine** | a **thin serve/read seam** (DTO shaping, currency, `no_data`) — REFACTOR, not delete |
| DTO shape | unchanged | **unchanged** (this is the UI shield — report #11 C-1) |
| Error contract | `503 SERVICE_UNAVAILABLE "Silver tier (StarRocks) not available"` | reword to "serving tier (StarRocks MV)"; semantics identical |

**Key consequence for the API contract:** because the DTOs do not change, **the OpenAPI/`@brain/contracts` request+response shapes are stable.** The change is an **implementation swap behind a stable contract** — the cleanest possible expression of "Architecture change → API change → UI change", where the API change is internal (data source) and the UI change is ~zero.

### 2.2 metric-engine seam (the load-bearing refactor)

`@brain/metric-engine` (~73 files) today contains `realized-revenue.ts`, `provisional-revenue.ts`, `contribution-margin.ts` (CM2), `customer-360.ts`, `cac.ts`, `attribution-models.ts` / `attribution-datadriven.ts` / `attribution-credit.ts` / `attribution-reconciliation.ts`, `*-roas.ts`, `executive-metrics.ts`, `kpi-summary.ts`, etc. (Data Architecture / Staff SWE / RECON-1).

> ⚠️ **HIGH-RISK — STAKEHOLDER SIGN-OFF REQUIRED — REVENUE/ATTRIBUTION TRUTH.** Moving realized-revenue, CM2, and attribution-credit computation from metric-engine TS (over StarRocks) into Spark (→ Iceberg Gold → `mv_*`) is a **money-truth migration**. Per the audit's top risks: every relocated metric must be **byte/minor-unit parity-gated** against current outputs before cutover, reproducing the deterministic money math exactly (largest-remainder attribution apportionment, revenue-recognition rule). **Do NOT remove the TS compute or repoint the endpoint until the Spark→Iceberg-Gold→`mv_*` path is live and parity-proven.** Premature repointing blanks every revenue/attribution dashboard.

**Sequencing the API repoint (must follow the compute migration):**
1. Spark builds Silver → Spark builds Gold (Iceberg) → StarRocks `mv_*` over Iceberg Gold.
2. Repoint metric-engine read seam from `srPool`-Silver compute → `mv_*` serve.
3. Only then remove the dbt marts + the TS compute modules.

---

## 3. ⚠️ HIGH-RISK — Endpoints reading PG / StarRocks analytical "Gold" that V4 forbids

These are not just compute-placement issues — they read **storage that V4 forbids for analytics** and are revenue/attribution-load-bearing.

| Endpoint(s) | Forbidden source (verified) | V4 rule broken | Required API change |
|---|---|---|---|
| `attribution.routes.ts` GET handlers (`:93,136,179,223`) | `attribution_credit_ledger (Postgres Gold, 0032)` — confirmed in the route comment block at `attribution.routes.ts:69` | "NEVER in PG: attribution"; "StarRocks does NOT own attribution"; Gold in Iceberg | ⚠️ Repoint to `mv_attribution_credit` over Spark-built **Iceberg Gold**; retire the PG ledger read. **Parity-gate first.** |
| analytics endpoints served by `@brain/attribution-writer` outputs | `brain_gold.gold_attribution_credit` (StarRocks PRIMARY-KEY table, written by TS `attribution-writer`) | StarRocks must not OWN attribution; compute must be Spark | ⚠️ Spark produces the credit in Iceberg Gold; BFF serves `mv_*`. |
| revenue endpoints | `gold_revenue_ledger` (dbt-built StarRocks table; the recognition basis) | Gold must be Iceberg; dbt REMOVED | ⚠️ Spark builds the recognition ledger in Iceberg Gold; serve via `mv_*`. **Billing reads this — parity-gate.** |
| `decisions.routes.ts` recommendation reads | `recommendation` / `recommendation_action` / `recommendation_outcome` (PG) | "NEVER in PG: recommendations" | Repoint recommendation reads to the Spark/MV serve path; KEEP only `recommendation_history`, `decision_history`, `decision_outcome`, `user_feedback` in PG. |
| `dq_check_result` reads (data-quality surfaced via BFF/metric-engine) | `audit.dq_check_result` (PG) | analytics in PG forbidden | Repoint to Iceberg/MV once Spark DQ exists. |

> ⚠️ **HIGH-RISK — ratify before execution.** Dropping `attribution_credit_ledger` (a money/attribution ledger) or `dq_check_result` while a live route still reads them causes **read-path 500s and attribution-integrity loss**. The audit mandates **relocate-then-cutover**: stand up the Iceberg-Gold + `mv_*` serve path, repoint the endpoint, verify parity, THEN drop the PG/StarRocks source. These removals are **blocked on the larger compute-to-Spark migration** (no Spark Silver/Gold jobs and zero `mv_*` exist today).

---

## 4. AI / Decision runtime endpoints

| Endpoint | Today | V4 rule | API change |
|---|---|---|---|
| `ask.routes.ts` POST `/…/ask` (`:40`) | AI runtime answer; **persists `ai_config.ai_provenance` to PG** (redacted question only) | "AI output (summaries/explanations/insights) NOT permanently stored" | ⚠️ Ratify `ai_provenance` as an audit-ledger exception OR stop persisting. Preserve the **redact-before-store** guarantee either way (Security SEC-02). API request/response shape unchanged. |
| `decisions.routes.ts` writes (`:99,145,252`) | Decision-loop writes | Decision runtime may store ONLY `recommendation_history`/`decision_history`/`decision_outcome`/`user_feedback` | Ensure write endpoints persist ONLY those four; any computed-recommendation persistence is repointed/removed. Likely a **table rename + scope-narrowing**, not a contract change. |
| `feedback.routes.ts` (`:41,64,86`) | conversion/CAPI feedback reads | analytics → must serve from MV | Repoint to `mv_*`. |

---

## 5. Endpoints that STAY (operational — V4-conformant, do not touch)

These already match "APIs expose operational data from PG / serve from approved sources." Preserve through the migration.

| Endpoint group | Source | Why conformant |
|---|---|---|
| `auth-session.routes.ts` (session/register/login/logout/verify/reset) | PG IAM/tenancy | operational (organizations/users/RBAC/settings) |
| `billing.routes.ts` (invoices/plans/credit-notes/meter) | PG billing | "Aurora Postgres = … billing"; operational |
| `consent.routes.ts` | PG consent vault (ADR-0004) | operational/compliance |
| `tracking.routes.ts`, pixel/connector status | PG application state | operational |
| `dashboard.queries.ts` (orgs/brands/connectors/pixel) | PG control-plane | operational (verified RECON-1; `dashboard.queries.ts` control-plane reads) |
| `identity.routes.ts` identity reads | Neo4j | "Neo4j owns identity" |

---

## 6. Naming / REST-shape conformance

| Convention | Status | Evidence |
|---|---|---|
| REST verbs/resources | ✅ broadly conformant — `GET` for reads, `POST`/`DELETE` for writes (verified handler scan) | route registrations across all files |
| Path style | ◦ MINOR — paths are action/segment-style (`/api/v1/analytics/revenue-timeseries`) rather than strict resource (`GET /customers/{id}`). V4 prefers resource REST. | `analytics-core.routes.ts:42` |
| Events dot.lower | ✅ | `order.live.v1`, `shopflo.checkout_abandoned.v1` (bundle) |
| Tables/columns snake_case | ✅ | `revenue-timeseries`, `aov_minor`, `share_pct` DTO fields |

**Disposition:** path-style naming is a LOW-risk optional cleanup; do **not** bundle a REST-resource rename into the compute migration (it would needlessly break the stable-DTO/UI-shield property). Defer to a separate, contract-versioned pass if desired.

---

## 7. API change summary — prioritized

| Priority | Change | Endpoints | Risk | Gate |
|---|---|---|---|---|
| P0 ⚠️ | Repoint revenue/attribution/CM2 endpoints from metric-engine-compute-over-Silver → serve from `mv_*` over Iceberg Gold | `analytics-core`, `analytics-marketing`, `attribution`, revenue/margin handlers | **HIGH (money/attribution truth, billing reads gold_revenue_ledger)** | **Stakeholder sign-off + byte/minor-unit parity oracle BEFORE cutover; relocate-then-cutover** |
| P0 ⚠️ | Retire PG/StarRocks analytical sources behind endpoints (`attribution_credit_ledger` 0032, `gold_attribution_credit`, `dq_check_result`, recommendation/decision analytics) | `attribution`, `decisions`, `feedback`, DQ reads | **HIGH (read-path 500s, attribution integrity)** | blocked on Spark Silver/Gold + `mv_*` existing; parity-gate |
| P1 ⚠️ | Resolve `ai_provenance` PG persistence (ratify exception or stop) | `ask.routes.ts` | normal-high (compliance/privacy) | Security ratification; preserve redact-before-store |
| P1 | Narrow decision writes to the 4 allowed PG decision ledgers | `decisions.routes.ts` | normal | rename + scope check |
| P2 | Repoint remaining analytics tiles in `dashboard.routes.ts` to `mv_*` | `dashboard.routes.ts` analytics handlers | normal | after MV build |
| P3 (optional) | Reword `503` "Silver tier" message → "serving tier (MV)" | analytics-core et al. | trivial | cosmetic |
| P3 (optional, deferred) | Resource-style REST path cleanup | all analytics routes | low | separate versioned pass; do NOT bundle with compute migration |

**Bottom line:** the BFF must stop being a **computation tier dressed as an API tier**. The endpoints keep their stable DTO contracts (shielding the UI), but their internals flip from "compute business truth over StarRocks Silver in Node" to "serve a Spark-built Iceberg-Gold mart via a StarRocks `mv_*`." The money/attribution endpoints and the PG-Gold reads (`attribution_credit_ledger` 0032, `gold_revenue_ledger`) are the HIGH-RISK, sign-off-gated, parity-first changes; everything operational (auth, billing, consent, tracking, control-plane, Neo4j identity) stays exactly as-is.
