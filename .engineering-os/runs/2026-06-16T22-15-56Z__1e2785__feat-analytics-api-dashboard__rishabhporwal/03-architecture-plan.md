# Architecture Plan — feat-analytics-api-dashboard

**Stage:** 2 (architecture) · **Architect:** Opus 4.8 · **Decision:** ADVANCE
**req_id:** `feat-analytics-api-dashboard` · **Authored:** 2026-06-17
**Branch:** `feat/analytics-api-dashboard` (base = metric-engine HEAD / master+engine; already created)
**Bindings encoded:** D-1 .. D-12 (from `02-cto-advisor-review.md` — NOT re-derived; turned into a build plan)

> The M1 vertical spine finale: Bronze → identity → ledger → **metric engine → Analytics API → dashboard**. Put the reconciling number on screen — or an honest "No data yet" when there is nothing real to show. The heart of this slice is four invariants that prior bugs have repeatedly hit: **honest-empty-state signal** (never a bare 0), **sole-read-path** (engine-only, no ad-hoc SUM), **no 9th envelope mismatch** ({request_id, data} unwrap), and **isolation under `brain_app`** (dev superuser masks RLS).

---

## 1. Cost-routing paradigm

**Tier-0 deterministic, throughout. Zero model calls. $0/mo, 0 tokens/day.**

Every computation is a typed function over Postgres: `computeRealizedRevenue` / `computeProvisionalRevenue` (named-fn reads, no ad-hoc SUM) → `EXISTS(finalized)` boolean → bigint→string serialization → `Intl.NumberFormat` display. A model call anywhere on this path is a paradigm-bypass (METRICS.md: Tier-0 "the only tier that produces numbers"). The analytics service function carries a `// @effort deterministic` doc-marker (no decorator pattern exists in the repo — grep `@effort` returns nothing; do NOT invent one). Justification: the answer is a deterministic ledger read; statistical/ML/model tiers are strictly more expensive and less correct for a reconciling financial number.

---

## 2. Single-Primitive sweep — CLEAN (extend-only)

| Concern | The ONE primitive | This slice |
|---|---|---|
| Revenue computation | `@brain/metric-engine` `computeRealizedRevenue` / `computeProvisionalRevenue` (`packages/metric-engine/src/{realized,provisional}-revenue.ts`) | **consume** — no second computation path; no ad-hoc SUM |
| RLS brand scoping | `withBrandTxn` (`packages/metric-engine/src/deps.ts:39`) | **consume** — same txn-scoped GUC; do NOT regress F-SEC-02 |
| Money math | `@brain/money` `money()` VO + minor-units table (`packages/money/src/index.ts:55,113`) | **consume** for the value object; **add** one UI display formatter (locale grouping) — `formatMoney(m: Money)` at `:123` is log-only ("NOT for rendering") so the card needs a thin display wrapper, NOT a second money model |
| BFF envelope | `{ request_id, data }` + `BffEnvelope<T>` (`bff.routes.ts`, `client.ts:621`) | **consume** — exact pattern, no flat shape |
| Dashboard card shell | `EmptyState` / `Card` / `Skeleton` / `ErrorCard` + `data-status-card.tsx` template | **consume** — new card mirrors the template |
| Dashboard query cache | `DASHBOARD_QUERY_KEY` + `use-dashboard.ts` hooks; brand-switcher already invalidates it (`brand-switcher.tsx:13`) | **consume** — new hook keyed under `DASHBOARD_QUERY_KEY` → auto-invalidates on brand switch (Open-Q3 answered: zero extra work) |
| RLS isolation test harness | dual-pool brain_app harness (`realized-revenue-ledger.live.test.ts:41-90`) | **consume** — copy the `superPool`/`appPool`/`setBrandGuc` pattern |

**No new service, no new table-family, no new queue, no new deployable, no new ADR.** New artifacts: one analytics-service file, one BFF route block, one card, one client adapter, one display formatter, three test files. All additive.

---

## 3. Codebase grounding (file:line — the wiring nuances that bite)

1. **Pool type mismatch (load-bearing).** `registerBffRoutes` receives `pool?: DbPool` (`bff.routes.ts:60`) — the **context-wrapped** pool whose `client.query(ctx, sql, params)` injects GUCs. The engine's `withBrandTxn` needs a **raw `pg.Pool`** (it issues its own `BEGIN`/`set_config`/`COMMIT` — `deps.ts:44-51`). A raw pool **already exists**: `rawPgPool` at `main.ts:277` (used by transactional paths). **Binding: thread `rawPgPool` into `registerBffRoutes` as a new param** and hand it to the analytics service as `EngineDeps.pool`. Do NOT wrap the engine in `DbPool` (double-GUC), do NOT create a third pool.
2. **The `??'0'` landmine.** `realized-revenue.ts:71` coerces a NULL `realized_gmv_as_of()` (no finalized rows) to `'0'` → `0n`. This is indistinguishable from a real net-zero. The analytics service MUST do a **separate `EXISTS(finalized)` check** to set `state` — never infer `no_data` from the value (D-2).
3. **Brand-not-found already returns empty Map** (`realized-revenue.ts:56-59`) — distinguishable, but we do NOT rely on it; the `EXISTS` check is authoritative.
4. **BFF honest-empty precedent.** Existing dashboard routes return structured empty (not 404) on `!auth.brandId` (`bff.routes.ts:569,656,732`). The new route follows the same shape but uses the explicit `state` discriminant.
5. **Envelope unwrap precedent.** `client.ts:666-682` (`getBrandSummary`) is the exact `const { data } = await bffFetch<BffEnvelope<RawT>>(...)` + map-to-component-type pattern to copy. Eight prior bugs were flat-shape deviations.
6. **`analytics/index.ts` is `export {}`** (`:7`) — ESLint boundary rule means other modules import ONLY this file; internal impl lives under `./internal/`. Export the public function here (D-8).
7. **Ledger table for EXISTS.** `realized_revenue_ledger`, `recognition_label IN ('provisional','settling','finalized')`, RLS `ENABLE+FORCE` (`0018_realized_revenue_ledger.sql:61,88,112`). The finalized-existence check is `EXISTS(SELECT 1 FROM realized_revenue_ledger WHERE recognition_label='finalized')` — RLS scopes brand_id automatically inside `withBrandTxn`; do NOT add a manual `brand_id=$1` predicate as the isolation guarantee (RLS is the guarantee), though passing it is harmless.
8. **brain_app test harness exists.** `realized-revenue-ledger.live.test.ts:41-90`: `SUPERUSER_URL` (DDL/seed) + `BRAIN_APP_DATABASE_URL` (RLS assertions), `setBrandGuc`, deterministic brand UUIDs. Reuse verbatim.
9. **e2e exists — extend, don't create.** `apps/web/e2e/dashboard.spec.ts` + `helpers/onboard.ts` (`onboardToDashboard`). Add the realized-revenue cases here.

---

## 4. The contract (D-1 — LOCKED; this is the coordination point both tracks build against)

**Route:** `GET /api/v1/dashboard/realized-revenue?as_of=<YYYY-MM-DD>`
(BFF dashboard pattern — NOT `/api/v1/metrics`; keeps one read surface, honors ADR-002 sole-read-path. `as_of` optional → server defaults to today via `new Date()`, server-side, never client-trusted — Open-Q1 answered: yes, server-computed.)

**Success envelope (200):**
```jsonc
{
  "request_id": "uuid",
  "data": {
    "state": "no_data" | "has_data",         // D-2 — explicit discriminant, EXISTS(finalized)-driven
    "as_of": "2026-06-17",                    // echoed resolved date (server-resolved if omitted)
    "realized":    { "INR": "123450" } | null, // D-1/D-4 — bigint minor units AS STRING; null iff state=no_data
    "provisional": { "INR": "5000" } | {} | null // D-4 — SIBLING field, never blended; {} when no provisional rows, null iff no_data
  }
}
```
- `realized`/`provisional` are `Record<currency_code, string>` — **bigint serialized to string** (JSON has no bigint; matches the engine's pg-string convention). Per-currency map; M1 = one entry.
- `state:'no_data'` ⇒ both `realized` and `provisional` are `null`. The UI renders "No data yet" on `state==='no_data'` **regardless of any value** (D-2).
- `realized` and `provisional` are **never summed** anywhere — BFF, service, or card (D-4).

**Error envelope (400 — bad as_of, D-9):**
```jsonc
{ "request_id": "uuid", "error": { "code": "INVALID_DATE", "message": "as_of must be YYYY-MM-DD." } }
```
**503** (no pool) and **401** (no session) follow the existing BFF precedent exactly.

This block is frozen first. The frontend may stub against it immediately and proceed in parallel with the backend.

---

## 5. Service shape (DDD — analytics bounded context)

```
apps/core/src/modules/analytics/
  index.ts                                  # D-8: export { getRevenueMetrics } — ONLY public surface
  internal/
    application/queries/get-revenue-metrics.ts   # the service fn (use-case)
    domain/metrics/revenue-snapshot.ts           # RevenueSnapshot type + serialize(Map)->Record<string,string>
```
- `getRevenueMetrics(brandId, asOf, deps: EngineDeps): Promise<RevenueSnapshot>` — the use-case. It (a) runs the `EXISTS(finalized)` check inside `withBrandTxn`, (b) if no finalized rows → `{ state:'no_data', as_of, realized:null, provisional:null }`, (c) else calls `computeRealizedRevenue` + `computeProvisionalRevenue`, serializes each `Map<CurrencyCode,bigint>` → `Record<string,string>` (bigint→string), returns `{ state:'has_data', as_of, realized, provisional }`.
- **No ad-hoc SQL beyond the single `EXISTS` existence check** (D-3). The numbers come ONLY from the engine. The `EXISTS` check is existence, not a value — explicitly allowed and required by D-2; it is NOT a `SUM`.
- Domain imports no Fastify, no pg driver directly beyond the injected `EngineDeps` (which is `{ pool }`). Pure use-case orchestration; the value-object `RevenueSnapshot` holds the shape.
- The BFF route handler is THIN: parse/validate `as_of` (D-9) → guard `auth.brandId` (honest empty if null) → call `getRevenueMetrics(auth.brandId, asOf, { pool: rawPgPool })` → wrap in `{ request_id, data }`.

---

## 6. Slices — smallest-first, COMMIT PER SLICE

### Slice 1 — analytics service + BFF route  ·  @backend-developer  ·  commit `feat(analytics): revenue-metrics service + BFF route (D-1..D-3,D-8,D-9)`
1. `analytics/internal/domain/metrics/revenue-snapshot.ts`: `RevenueSnapshot` type + `serializeMoneyMap(m: Map<CurrencyCode,bigint>): Record<string,string>` (bigint→`String(v)`).
2. `analytics/internal/application/queries/get-revenue-metrics.ts`: `getRevenueMetrics(brandId, asOf, deps)`. `withBrandTxn(deps.pool, brandId, …)` → `EXISTS(SELECT 1 FROM realized_revenue_ledger WHERE recognition_label='finalized')`. `no_data` → null fields. Else call both engine fns (each opens its own `withBrandTxn` — acceptable; or pass the client — keep it simple: call the engine fns with `deps`). `// @effort deterministic` doc-marker.
3. `analytics/index.ts`: replace `export {}` with `export { getRevenueMetrics, type RevenueSnapshot }` (D-8).
4. `main.ts:314`: add `rawPgPool` arg to `registerBffRoutes(app, authService, pool, config.cookieSecret, rateLimiter, rawPgPool)`; widen the signature (`bff.routes.ts:57-63`) with `rawPool?: pg.Pool`.
5. `bff.routes.ts`: new route block `GET /api/v1/dashboard/realized-revenue` under `bffProtectedPreHandler`. Fastify JSON schema validates `as_of` (`pattern: '^\\d{4}-\\d{2}-\\d{2}$'`, optional) → 400 `INVALID_DATE` on bad value (D-9). `!auth.brandId` → `{ data:{ state:'no_data', as_of, realized:null, provisional:null } }`. `!rawPool` → 503. Else `getRevenueMetrics(auth.brandId, asOf ?? today, { pool: rawPool })` → `{ request_id, data }`.

### Slice 2 — web card + client + display formatter  ·  @frontend-web-developer  ·  commit `feat(web): realized-revenue card + client adapter + money display (D-4..D-7,D-12)`
1. `apps/web/lib/format/money-display.ts`: `formatMoneyDisplay(minor: bigint, currency: CurrencyCode): string` — builds `money(minor, currency)` VO (`@brain/money`) then `Intl.NumberFormat('en-IN', { style:'currency', currency })` over the major/minor split from the VO's minor-units. **No `parseFloat`, no inline `/100`** in component code (D-7). Covered by `no-float-money` lint. (Wraps the ONE money model; does not duplicate it.)
2. `apps/web/lib/api/client.ts`: add `dashboardApi.getRealizedRevenue(asOf?)` — `const { data } = await bffFetch<BffEnvelope<RawRevenue>>('/v1/dashboard/realized-revenue' + qs)`. Type `RawRevenue` (raw) and `RevenueCardModel` (mapped) **separately** (D-5, mirror `getBrandSummary` at `:666`). Map `state`/`as_of`/`realized`/`provisional`; do NOT collapse `null` into `{}`.
3. `apps/web/lib/hooks/use-dashboard.ts`: `useRealizedRevenue()` keyed `[...DASHBOARD_QUERY_KEY, 'realized-revenue']` → auto-invalidates on brand switch (D-6 cache).
4. `apps/web/components/dashboard/realized-revenue-card.tsx`: mirror `data-status-card.tsx`. States: loading (`Skeleton`), error (`ErrorCard`), `state==='no_data'` → `EmptyState` "No data yet" (D-2 — NEVER a 0). `has_data` → realized per-currency via `formatMoneyDisplay`, labeled **"Realized Revenue"**; provisional rendered in a sibling block labeled **"Provisional / Settling — not yet confirmed"** (D-4 — distinct label, never blended; empty provisional → "No provisional data"). testids (D-12): `realized-revenue-card`, `realized-revenue-value`, `provisional-revenue-value`, `realized-revenue-no-data`.
5. `apps/web/app/(dashboard)/dashboard/page.tsx`: mount `<RealizedRevenueCard />`.

### Slice 3 — tests + e2e  ·  both tracks  ·  commit `test(analytics): engine==BFF, honest-empty, isolation under brain_app + e2e (D-3,D-2,D-6)`
- **Backend** `apps/core/src/modules/analytics/tests/revenue-metrics.live.test.ts` (reuse `realized-revenue-ledger.live.test.ts:41-90` dual-pool harness):
  - **engine==BFF exact-bigint (sole-read-path proof, D-3):** seed finalized rows for BRAND_A; call `computeRealizedRevenue` directly AND call `getRevenueMetrics`; assert `getRevenueMetrics.realized[ccy] === String(engineMap.get(ccy))` — exact, no rounding.
  - **honest-empty-state (D-2):** brand with ZERO finalized rows (and optionally a provisional row to prove the value path would say 0) → `state==='no_data'`, `realized===null`. Assert it is NOT `{INR:'0'}`.
  - **isolation negative-control under `brain_app` (D-6):** seed BRAND_A finalized data (superPool); run `getRevenueMetrics(BRAND_A,…)` with the **`appPool`** GUC set to BRAND_B → `state:'no_data'` / empty. Assert `current_user='brain_app'`. MUST NOT use the superuser for the assertion (dev `brain` masks RLS — `memory/dev-db-superuser-masks-rls.md`).
  - **provisional-shown-separately (D-4):** seed finalized + provisional → both fields populated, disjoint, never summed.
- **Frontend** extend `apps/web/e2e/dashboard.spec.ts`:
  - **real-number e2e:** `onboardToDashboard` → seed a finalized ledger row (via the existing seed helper / a small BFF-adjacent fixture under brain_app) → `getByTestId('realized-revenue-value')` shows the real formatted number (not a fake/0).
  - **no-data e2e:** a freshly-onboarded brand (no finalized rows) → `getByTestId('realized-revenue-no-data')` visible, value testid absent.
  - **no-float display (D-7):** assert the rendered string matches the `formatMoneyDisplay` output for the seeded minor value (e.g. `123450` INR → `₹1,234.50`).

> Slice 1 unblocks nothing on the frontend beyond the frozen §4 contract — both tracks run in parallel from the start; Slice 3 lands after both. Commit per slice.

---

## 7. Deploy track  ·  @backend-developer (owns the pipeline step)

**No new deployable** (D-10) — analytics module is inside `apps/core` (existing monolith), card is inside `apps/web`. Affected-only: a change touching `apps/core` rebuilds + redeploys the **core** app; a change touching `apps/web` rebuilds + redeploys **web**. Reuse the existing per-service pipeline + ArgoCD sync from prior M1 slices (honors the Phase-4 canary deferral, ADR-010 — same as `feat-realized-revenue-ledger`). No new GitOps app, no new manifest, no migration to gate (D-11 — read-only; zero migrations). Pipeline step in Slice 1's PR: affected-only build → image → per-service deploy app → ArgoCD sync. No deploy-all.

---

## 8. Test strategy summary (in-lane DoD)

| Guarantee | Test | Layer |
|---|---|---|
| Sole-read-path (engine==BFF, exact bigint) | `revenue-metrics.live.test.ts` | backend live |
| Honest empty (no_data, not 0) | `revenue-metrics.live.test.ts` + e2e | backend + e2e |
| Isolation (cross-brand=0 under brain_app) | `revenue-metrics.live.test.ts` | backend live (brain_app pool) |
| Provisional separate, never blended | `revenue-metrics.live.test.ts` + e2e | backend + e2e |
| No-float money display | e2e assertion + `no-float-money` lint | web |
| Envelope unwrap (no 9th mismatch) | e2e uses the SAME client path the app uses | web e2e |
| as_of validation → 400 | route schema test (or e2e) | backend |
| Real-network smoke | e2e onboard→seed→dashboard real number | web e2e |

---

## 9. Reversibility & risk

- **Migrations:** none (read-only, D-11). Nothing to roll back at the DB layer.
- **Code reversibility:** every change is additive — new files + one new route + one new `registerBffRoutes` param (defaulted optional) + one card mount. Revert = drop the files + the route block + the page mount line. No public surface broken.
- **Top risk = the four invariants.** Each is pinned to a REQUIRED pass-1 acceptance item below; each has a test that fails RED if violated.

---

## 10. Acceptance contracts (every persona must-fix folded as REQUIRED pass-1)

### @backend-developer — REQUIRED pass-1
- [ ] Route `GET /api/v1/dashboard/realized-revenue?as_of=` returns the EXACT §4 envelope; `realized`/`provisional` are sibling `Record<ccy,string>` (bigint→string), never summed (D-1,D-4).
- [ ] `state` is driven by `EXISTS(finalized)`, NOT by the value; `no_data` ⇒ `realized:null, provisional:null`; a real net-zero with finalized rows ⇒ `has_data` + `{ccy:'0'}` (D-2 — the `??'0'` landmine is neutralized).
- [ ] Numbers come ONLY from `computeRealizedRevenue`/`computeProvisionalRevenue`; the ONLY ad-hoc SQL is the `EXISTS` existence check; NO `SUM(amount_minor)` anywhere (D-3).
- [ ] Engine reads via `withBrandTxn` (txn-scoped GUC); F-SEC-02 not regressed (D-3, F-SEC-02). The service receives the **raw `pg.Pool`** (`rawPgPool`), not the `DbPool` wrapper.
- [ ] `analytics/index.ts` exports the public fn; nothing imports from `./internal/` across the boundary (D-8).
- [ ] `as_of` schema-validated → 400 `INVALID_DATE` on bad/garbage; omitted → server-side `new Date()` (D-9, Open-Q1).
- [ ] Live tests pass: engine==BFF exact-bigint; honest-empty (not 0); isolation cross-brand=0 **under `brain_app`** (`BRAIN_APP_DATABASE_URL`, assert `current_user='brain_app'`); provisional-separate (D-2,D-3,D-4,D-6).
- [ ] Affected-only deploy step for `apps/core` in the slice PR; no migration (D-10,D-11).
- [ ] Commit per slice.

### @frontend-web-developer — REQUIRED pass-1
- [ ] `dashboardApi.getRealizedRevenue()` uses `const { data } = await bffFetch<BffEnvelope<RawRevenue>>(...)`; raw + mapped types declared SEPARATELY; no flat-shape read — no 9th envelope mismatch (D-5).
- [ ] Card renders "No data yet" on `state==='no_data'` regardless of value; `realized-revenue-no-data` testid present; NEVER a 0/fabricated number (D-2).
- [ ] Realized labeled "Realized Revenue"; provisional in a sibling block labeled "Provisional / Settling — not yet confirmed"; never blended/summed; empty provisional → "No provisional data" (D-4).
- [ ] Money via `formatMoneyDisplay(minor: bigint, currency)` — no `parseFloat`, no inline `/100`; `no-float-money` lint green (D-7).
- [ ] testids: `realized-revenue-card`, `realized-revenue-value`, `provisional-revenue-value`, `realized-revenue-no-data` (D-12).
- [ ] `useRealizedRevenue()` keyed under `DASHBOARD_QUERY_KEY` → invalidates on brand switch (D-6 cache, Open-Q3).
- [ ] e2e (extend `dashboard.spec.ts`): onboard→seed finalized row→real number shown; no-data brand→"No data yet"; uses the SAME client path the app uses (D-2,D-5).
- [ ] Affected-only deploy step for `apps/web`; commit per slice.

---

## 11. ADR check

**No new ADR.** Within ADR-002 (Analytics-API-as-sole-read-path — this IS its realization), ADR-001 (RLS), ADR-010 (deploy, honors Phase-4 canary deferral), I-S07 (money minor-units), I-E02 (additive). Decision-log note: `registerBffRoutes` gains an optional `rawPool` param to thread the existing `rawPgPool` for the in-process engine call — additive, no signature break for existing callers.

---

## Open questions — RESOLVED by the Architect
1. `as_of` omitted → server-side `new Date()` (server-computed, never client-trusted). ✅
2. `index.ts` exports a plain function (`getRevenueMetrics`), not a class — consistent with the engine. ✅
3. TanStack cache: key under `DASHBOARD_QUERY_KEY`; brand-switcher already invalidates that prefix (`brand-switcher.tsx:13`) → re-fetches on brand switch with zero extra code. ✅
