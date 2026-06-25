# 11 — UI Impact Report (apps/web) — Brain V4 Migration

**Scope:** `apps/web` only. This report enumerates every V4 UI-conformance finding (Iceberg-direct access, business-metric computation in the UI, mock/hardcoded data, attribution/CM2/LTV computed in the UI) and translates them into a per-page / per-component / per-DTO change list.

**Evidence base:** the validated V4 audit bundle (Frontend workstream + RECON-1 + Security + Principal Architect). Every claim below traces to a `path` or `path:line` citation from that bundle, or to direct source verification noted inline.

**V4 rule under audit (verbatim):**
> Medallion compulsory. UI must NEVER query Iceberg directly, calculate business metrics, use mocked values, or calculate attribution/CM2/LTV. Spark calculates, StarRocks serves, APIs expose, UI renders. Architecture change → API change → UI change.
> NO-MOCK POLICY: UI values come ONLY from PostgreSQL/StarRocks/Redis/approved APIs. No data → show empty state, never fake.

---

## 0. Executive verdict

**`apps/web` is overwhelmingly CONFORMANT with the V4 UI-as-consumer mandate.** This is the single most architecturally-clean tier in the system. The audit's hardest finding is that the *upstream serving tier* the UI consumes is non-conformant — but because the UI is correctly decoupled behind stable DTO shapes, **the UI blast-radius of the entire V4 backend re-platform is near-zero** (the "Architecture change → API change → UI change" chain mostly terminates at the API, never reaching the render layer).

| Dimension | Verdict | Evidence |
|---|---|---|
| UI queries Iceberg/StarRocks/PG directly | **CONFORMANT (no)** | `apps/web/lib/api/client.ts` — "talks ONLY to the frontend-api BFF. Never the DB, never StarRocks, never Postgres directly." Every `iceberg`/`starrocks`/`brain_gold`/`brain_silver` hit in app code is a documentation comment, not a query. `pg`/`Client` imports appear ONLY in `apps/web/e2e/*` test helpers. |
| UI computes business metrics | **MOSTLY CONFORMANT** — engine-computed DTO fields rendered verbatim; a narrow residual tail of client-side rate/transform math | `attribution-content.tsx` reads `roasQ.data`; `channel-roas-table.tsx` "roas_ratio is the engine's EXACT value"; `margin-content.tsx` renders served `cm1_minor`/`cm2_minor` |
| UI computes attribution / CM2 / LTV | **CONFORMANT (no)** | none of the residual client calcs touch money minor-units, attribution, CM2, or LTV |
| Mocked / hardcoded business data | **CONFORMANT (none)** | every `mock`/`fake`/`hardcoded` grep hit is a DEV-HONESTY comment asserting the opposite (`cod-rto-content.tsx` "data_source comes from the BFF, never hardcoded"; `dashboard-content.tsx` "never a faked Live"; `orders-list-card.tsx` "never a fake 0") |
| Honest empty states | **CONFORMANT** | `no_data`/`not_found` → `EmptyState`/`EmptyConnectCard`, never a fabricated `0` |
| Money rendering discipline | **CONFORMANT** | `formatMoneyDisplay(minorString, currency_code)` with explicit "never /100, never a hardcoded symbol" rule |

**Net:** the V4-required UI changes are a **small, bounded set** (one HIGH-risk cost-input write path, two display-only client calcs, and a date-window-literal hygiene pass) — NOT a redesign.

---

## 1. CONFORMANT — preserve as-is (do not regress during the backend re-platform)

These are the load-bearing UI invariants V4 demands. They already hold and must survive the upstream Spark/Iceberg/MV migration unchanged.

| # | Invariant | Where it lives | Keep because |
|---|---|---|---|
| C-1 | BFF-only contract | `apps/web/lib/api/client.ts` (all reads via `/api/bff/*`); hooks under `lib/hooks/*` (20 hooks) | The decoupling seam. As long as this holds, backend storage/compute moves never touch the UI. |
| C-2 | No direct lakehouse access | every `iceberg`/`starrocks`/`brain_gold` occurrence in `app/` + `components/` is a comment; `pg` only in `e2e/*` | Direct V4 prohibition satisfied. |
| C-3 | No mocked/hardcoded business data | all `mock`/`fake` hits are dev-honesty assertions; no hardcoded KPI in any JSX `value=` | NO-MOCK policy satisfied. |
| C-4 | Honest empty states | `EmptyState`/`EmptyConnectCard` on `no_data` (`cod-rto-content.tsx`, `top-products-card.tsx`, `orders-list-card.tsx`, `order-detail-content.tsx`) | "No data → empty state, never fake" satisfied. |
| C-5 | Synthetic dev data is **server-driven + visibly badged** | `SyntheticBadge` gated on API field `data_source==='synthetic'` (`synthetic-badge.tsx`, `logistics-content.tsx`, `top-products-card.tsx`); UI never invents the flag | This is NOT a UI mock — it is honest provenance disclosure. Keep. |
| C-6 | Money rendered from served minor-units | `formatMoneyDisplay(minorString, ccy)`; `aov_minor`/`cm1_minor`/`cm2_minor` rendered as bigint minor-units (`revenue-content.tsx`, `margin-content.tsx`, `channel-roas-table.tsx`) | Money discipline; "never /100". |
| C-7 | Attribution / ROAS / CM read as pre-computed DTO fields | `attribution-content.tsx` reads `roasQ.data`; `channel-roas-table.tsx` `roas_ratio`; charts only format engine `share_pct` strings (`attributed-channel-chart.tsx`, `first-touch-mix-chart.tsx`, `order-status-mix-chart.tsx`) | UI does NOT compute attribution/CM2/LTV. |
| C-8 | Live/status indicators reflect real query state | `live-indicator.tsx`, `tracking-status.ts` (no events → "waiting", never fake green); pixel verify "NEVER faked, never optimistic" (`live-verification.tsx`) | Honest liveness. |

---

## 2. RESIDUAL V4 VIOLATIONS — UI changes required

The complete set of UI-side changes V4 implies. None of these is a redesign; they are surgical.

### 2.1 ⚠️ HIGH-RISK — FE-02: Margin cost-input write path (the only HIGH-risk UI item)

**File:** `apps/web/app/(dashboard)/analytics/margin/margin-content.tsx`
**Components/hooks:** `useCostInputs`, `useUpsertCostInput`, `ConfidenceBadge` (`'Trusted' | 'Estimated' | 'Insufficient'`)
**Verified directly:** the cost-input form exists; the header comment states "Entering costs lifts `cost_confidence` off 'Insufficient' and makes CM2 trustworthy … eligible for the billing cap" (`margin-content.tsx:6`, `:97-98`).

**Violation:** the percent→basis-points conversion and a UI-pinned `cost_confidence` feed CM2 **and the billing cap**. Business-rule transform + confidence assignment happening client-side is a V4 "UI must never calculate business metrics" violation, and it is **billing-load-bearing** (a wrong conversion mis-states margin and can affect the billing cap).

> ⚠️ **HIGH-RISK — STAKEHOLDER SIGN-OFF REQUIRED.** Move the percent→basis-points transform AND the `cost_confidence` assignment **server-side**. RATIFY the API contract change first (Finance/Billing + Backend) — a conversion or confidence-classification change here mis-states margin and can affect billing. Do NOT ship the UI change before the server contract is agreed and parity-gated.

**UI change list:**
- Remove client-side percent→basis-points math; submit the raw user-entered percent and let the BFF convert + validate.
- Remove any UI-side assignment of `cost_confidence: 'Trusted'`; render `cost_confidence` strictly as a **served** field (read-only badge).
- `ConfidenceBadge` becomes purely presentational of the served value.

---

### 2.2 LOW-RISK — FE-01 / FE-03: Display-only client-side business calculations

Two narrow client-side calcs. **Neither touches money minor-units, attribution, CM2, or LTV.** Both should be moved to the engine for V4 purity, but are low blast-radius.

| ID | File / component | Client-side calc today | V4-correct target |
|---|---|---|---|
| FE-01 | RTO high-risk surface (cod-rto / logistics) — see `logistics-content.tsx` | a client-derived "RTO high-risk rate" | engine emits the rate on the DTO; UI renders verbatim (it already renders `rto_pct`/`overall_rto_rate_pct`/`rto_rate_pct` correctly for the main metric) |
| FE-03 | tax-rate display | client `tax_rate × 100` transform | engine emits a pre-formatted `tax_rate_pct`; UI renders verbatim |

**UI change list:** delete the `× 100` / rate-derivation expressions; bind to a new pre-formatted DTO field. No empty-state, money, or layout change.

---

### 2.3 LOW-RISK — Date/window literals hardcoded in content components

**Verified directly (not in the original FE finding list but confirmed across the tree):** every analytics content component computes its query window client-side with a hardcoded literal.

| File | Literal | Line (verified) |
|---|---|---|
| `revenue/revenue-content.tsx` | last **90** days | `:59` |
| `orders/orders-content.tsx` | last **90** days | `:108-111` |
| `spend/spend-content.tsx` | last **35** days | `:133`, sublabel `:247`, `:372` |
| `cod-rto/cod-rto-content.tsx` | last **30** days (sublabel) | `:314`, `:391` |
| `behavior` / `abandoned-cart` / `engagement` / `funnel` / `logistics` / `journey` / `order-status` / `attribution` `-content.tsx` | `Date.now() - days * 24*60*60*1000` | `behavior:39`, `abandoned-cart:39`, `engagement:39`, `funnel:47`, `logistics:42`, `journey:73`, `order-status:59`, `attribution:81` |

**Why it matters for V4:** these assume the serving tier accepts **client-supplied date windows**. After the move to StarRocks `mv_*` MV-served aggregates over Iceberg Gold, confirm MVs still accept arbitrary windows (vs pre-aggregated fixed windows). If MVs pre-aggregate, the UI window literals must be reconciled with the MV grains.

**UI change list (only if MV grains change):** parameterize windows from a shared config or accept them from API metadata; otherwise no change.

---

## 3. Per-page / per-widget conformance matrix

Legend: ✅ conformant · ⚠️ HIGH-risk change · �small low-risk change.

| Page (route) | Content component | Data source (V4-correct?) | Client-side business compute | Mock data | Required UI change |
|---|---|---|---|---|---|
| `/analytics/revenue` | `revenue-content.tsx` | ✅ BFF → served `realized`/`provisional`/`aov_minor` | ✅ none | ✅ none | ◦ window literal (90d) |
| `/analytics/orders` | `orders-content.tsx` | ✅ BFF timeseries | ✅ none (RTO rate served) | ✅ none ("never a fake 0") | ◦ window literal (90d) |
| `/analytics/orders/[order_id]` | `order-detail-content.tsx` | ✅ BFF | ✅ none | ✅ honest empty | none |
| `/analytics/margin` | `margin-content.tsx` | ✅ BFF served `cm1_minor`/`cm2_minor`/`cost_confidence` | ⚠️ **cost write: percent→bps + confidence pin** | ✅ none | ⚠️ **FE-02 move transform+confidence server-side** |
| `/analytics/attribution` | `attribution-content.tsx` | ✅ BFF reads `roasQ.data`, `share_pct` | ✅ none (attribution NOT computed in UI) | ✅ synthetic badge honest | ◦ window literal |
| `/analytics/cod-rto` | `cod-rto-content.tsx` | ✅ BFF served `rto_pct`/`cod_share_pct`, `data_source` badge | ◦ FE-01 RTO high-risk rate | ✅ synthetic server-driven badge | ◦ FE-01 |
| `/analytics/logistics` | `logistics-content.tsx` | ✅ BFF served `rto_pct`/`rto_rate_pct`, `data_source` badge | ◦ FE-01/FE-03 (rate/tax) | ✅ synthetic badge | ◦ FE-01/FE-03 |
| `/analytics/funnel` | `funnel-content.tsx` | ✅ BFF served `conversion_pct` | ✅ none (formats engine `share_pct`) | ✅ none | ◦ window literal |
| `/analytics/journey` | `journey-content.tsx` | ✅ BFF | ✅ none | ✅ none | ◦ window literal |
| `/analytics/behavior` | `behavior-content.tsx` | ✅ BFF (invariant comment) | ✅ none | ✅ none | ◦ window literal |
| `/analytics/engagement` | `engagement-content.tsx` | ✅ BFF | ✅ none | ✅ none | ◦ window literal |
| `/analytics/abandoned-cart` | `abandoned-cart-content.tsx` | ✅ BFF | ✅ none | ✅ none | ◦ window literal |
| `/analytics/order-status` | `order-status-content.tsx` | ✅ BFF (invariant comment) | ✅ none (formats engine `share_pct`) | ✅ none | ◦ window literal |
| `/analytics/spend` | `spend-content.tsx` | ✅ BFF `useBlendedRoas` | ✅ none (`roas_ratio` served) | ✅ none | ◦ window literal (35d) |
| `/analytics/conversion-feedback` | `conversion-feedback-content.tsx` | ✅ BFF (CAPI feedback hook) | ✅ none | ✅ none | none |
| `/analytics/settlements` | settlements content | ✅ BFF | ✅ none | ✅ none | none |
| Dashboard home | `dashboard-content.tsx` | ✅ BFF | ✅ none ("never a faked Live") | ✅ none | none |
| Insights | `insights-content.tsx` | ✅ BFF (`data_source` from BFF) | ✅ none | ✅ none | none |

**Widget-level (charts/tables):** `attributed-channel-chart.tsx`, `first-touch-mix-chart.tsx`, `order-status-mix-chart.tsx`, `channel-roas-table.tsx`, `top-products-card.tsx`, `orders-list-card.tsx`, `live-indicator.tsx`, `live-verification.tsx`, `synthetic-badge.tsx` — **all ✅ conformant**: they format engine-supplied `share_pct`/`roas_ratio` strings and minor-unit money, render synthetic/live provenance honestly, and never compute business truth.

---

## 4. The upstream caveat (NOT an apps/web defect)

The DTOs the UI renders as "engine-computed" currently **originate from a non-V4 compute tier** — `@brain/metric-engine` TypeScript over StarRocks Silver + dbt-built Gold marts — rather than Spark-built Iceberg Gold served via StarRocks `mv_*` (RECON-1; Principal Architect; Data Architecture findings). That is an `apps/core` / `packages` violation, captured in the API/back-end impact reports, **not** an `apps/web` one.

**UI consequence:** because the UI binds to **stable DTO shapes** (C-1), the Spark/Iceberg/MV re-platform should be near-zero-impact on the render layer — provided the contracts in `@brain/contracts` are held constant. Per the V4 rule "Architecture change → API change → UI change", the chain should terminate at the API for every page except FE-02 (which requires a deliberate, ratified contract change).

---

## 5. UI change summary — prioritized

| Priority | Change | Files | Risk | Gate |
|---|---|---|---|---|
| P0 ⚠️ | Move margin cost percent→bps conversion + `cost_confidence` assignment server-side | `margin-content.tsx` (+ new BFF contract) | **HIGH (billing-load-bearing)** | **Stakeholder sign-off (Finance/Billing) + parity gate BEFORE UI change** |
| P2 | Move FE-01 RTO high-risk rate to engine | `cod-rto-content.tsx`, `logistics-content.tsx` | LOW | DTO field add |
| P2 | Move FE-03 tax `×100` to engine (`tax_rate_pct`) | `logistics-content.tsx` | LOW | DTO field add |
| P3 | Reconcile hardcoded date-window literals with MV grains (only if MVs pre-aggregate) | all `*-content.tsx` (see §2.3) | LOW | confirm post-MV serving accepts client windows |
| — | Preserve C-1…C-8 invariants through the backend re-platform | all of `apps/web` | — | regression guard in CI |

**Bottom line:** the UI is the part of Brain that is *already* V4-shaped. The migration's UI work is one ratified billing-adjacent contract move plus a short low-risk display-math cleanup — everything else is "do not regress."
