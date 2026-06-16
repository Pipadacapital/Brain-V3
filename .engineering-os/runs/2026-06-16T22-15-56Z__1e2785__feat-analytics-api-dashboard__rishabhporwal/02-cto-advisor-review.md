# CTO Advisor Review — feat-analytics-api-dashboard
**Stage:** 1 (intake, personas folded — compressed adversarial pass)
**Decision:** ADVANCE
**Reviewed at:** 2026-06-17T02:35:00Z
**Reviewer:** cto-advisor (Sonnet)

---

## Lane confirmation

| Field | Value |
|---|---|
| Feature class | `high_stakes` |
| Trigger surfaces | `metric_engine` · `money` · `multi_tenancy` |
| Surface additions | none — scan correct; all three are confirmed present |
| Paradigm | Tier-0 deterministic throughout (engine call → format → render). Zero model calls. |

---

## Dependency pre-flight

All declared blockers are `shipped`:

| Blocker | Status |
|---|---|
| feat-metric-engine-parity | shipped (facacfe) — `computeRealizedRevenue`, `computeProvisionalRevenue`, `withBrandTxn` live |
| feat-realized-revenue-ledger | shipped (353bfd6) — `realized_gmv_as_of()`, `provisional_gmv_as_of()` live in DB |
| feat-identity-graph | shipped |
| feat-data-plane-ingest-spine | shipped |

No dependency gate fires. Proceed.

---

## "Make it less dumb first" pass

The requirement is already lean. The scaffolds (`analytics/index.ts` stub, `internal/.gitkeep`, four existing BFF dashboard routes, four existing web cards, `bffFetch` + `dashboardApi` pattern) are in place and the engine is the in-process library. The correct scope: wire the existing scaffolds, expose one new BFF route, add one new card. No new deployable, no new DB migration (read-only), no new dependency.

One simplification to note: the Stakeholder proposed `GET /api/v1/metrics?metric_id=realized_revenue`. The existing BFF pattern is `/api/v1/dashboard/*`. The architect MUST bind the route to the BFF pattern (see D-1 below) — the generic `/metrics` path would create a second read surface outside the BFF pattern and is in tension with ADR-002's sole-read-path intent. The BFF is the only surface the web app talks to; the analytics module is the sole read-path internally.

---

## Folded adversarial stress findings (severity-ranked)

### CRITICAL

None. The engine, the ledger, and the RLS mechanics are already shipped and verified. The risks here are implementation-time bugs in wiring, not design flaws.

---

### HIGH-1: Honest-empty-state signal — the `0` ambiguity (metric_engine + money surfaces)

**File:** `packages/metric-engine/src/realized-revenue.ts:71`
```
const raw = result.rows[0]?.realized_gmv_as_of ?? '0';
```

The engine returns `Map<CurrencyCode, bigint>` with value `0n` when a brand has finalized rows that sum to zero, AND also returns `Map<CurrencyCode, bigint>` with value `0n` when there are no finalized rows at all (`realized_gmv_as_of()` returns NULL → coerced to `'0'`). The API layer cannot distinguish "real ₹0 net revenue" from "no data exists yet." The BRD §8 / THE-MOAT.md honesty principle says the API MUST surface an explicit signal, not an ambiguous 0.

Similarly, `computeProvisionalRevenue` returns an empty Map when no provisional rows exist — that IS distinguishable (empty Map vs Map with a value) but the realized path is not.

**Required fix (D-2):** the Analytics API endpoint MUST query whether the brand has ANY finalized ledger rows (a simple `EXISTS` check, not a SUM — the engine gives the number, existence is a separate flag). The response envelope must include an explicit `state` field: `'no_data'` when there are zero finalized rows, `'has_data'` when at least one exists. The UI renders "No data yet" on `state:'no_data'` regardless of the value field. This is the ONLY correct honest-empty-state signal — a bare 0 is banned.

---

### HIGH-2: Sole-read-path enforcement — no ad-hoc SUM (metric_engine surface)

**File:** `apps/core/src/modules/analytics/index.ts:7` — currently `export {}` (a stub)

ADR-002 (STACK.md locked choice 2 and 4) requires: the Analytics API is the sole component calling the metric engine; no ad-hoc `SUM(amount_minor)` anywhere in the API/BFF/web. The implementation risk is that the developer, seeing the stub and the existing BFF pattern of direct Postgres queries (`client.query(...)` in `bff.routes.ts`), copies that pattern and writes an ad-hoc SUM instead of calling the engine.

**Required fix (D-3):** the architect plan MUST explicitly prohibit ad-hoc SQL in the analytics module and the new BFF route. The new BFF route calls the analytics module; the analytics module calls `computeRealizedRevenue` / `computeProvisionalRevenue` from `@brain/metric-engine`. The engine already has the sole DB seam. The Architect must call this out as a verifiable constraint in the implementation plan, with a test that asserts the BFF route returns the engine's exact value for a seeded brand.

---

### HIGH-3: Envelope mismatch — the 9th instance risk (multi_tenancy surface)

**File:** `apps/web/lib/api/client.ts` — 8 prior envelope mismatch bugs documented in the requirement

The existing `dashboardApi` pattern is:
```typescript
const { data } = await bffFetch<BffEnvelope<RawT>>('/v1/dashboard/...');
```
The BFF returns `{ request_id, data: { ... } }` and the client destructures `.data`.

The risk: the new `dashboardApi.getRealizedRevenue()` call or the new BFF route deviates from this pattern — e.g. the BFF returns `{ request_id, realized, provisional }` flat (no `data` wrapper) or the client reads `.realized` directly without unwrapping `.data`. Eight prior bugs of exactly this type are documented.

**Required fix (D-1 + D-5):** the Architect MUST specify the exact response envelope for the new BFF route in the plan, keyed to the existing `BffEnvelope<T>` type. The client adapter MUST use the `{ data }` destructure pattern and be type-safe against it. This is a verifiable constraint: the e2e test must use the same path the web client uses (not a raw curl to the BFF).

---

### HIGH-4: Brand isolation — dev superuser masks RLS (multi_tenancy surface)

**Source:** `memory/dev-db-superuser-masks-rls.md` (user's memory); confirmed in STACK.md ADR-001 and the `feat-metric-engine-parity` deferred item F-SEC-02.

The dev database connects as superuser `brain` which BYPASSES RLS. F-SEC-02 (deferred from feat-realized-revenue-ledger and feat-metric-engine-parity) documents that the GUC-reset defense-in-depth is not yet in place. In this feature, `withBrandTxn` sets the GUC correctly (transaction-scoped, is_local=true — this is good and was the F-SEC-02 carry-in fix). But the isolation negative-control test MUST run under `brain_app` (the non-owner role that DOES have NOBYPASSRLS — confirmed in feat-metric-engine-parity's `parity_gate` note: "postgres:16 service + brain_app NOBYPASSRLS"). If the test seeds brand A data and queries as brand B under `brain_app`, it must get 0 rows / empty map. This CANNOT be tested correctly against the dev superuser.

**Required fix (D-6):** The isolation test must use the `brain_app` role (NOBYPASSRLS). The CI pipeline already has this gate from feat-metric-engine-parity — reuse the same postgres service configuration. The architect must call this out explicitly in the test plan.

---

### MEDIUM-1: Provisional shown separately — never blended (metric_engine + money surfaces)

**Files:** `packages/metric-engine/src/provisional-revenue.ts:7-12` (invariant documented); response shape TBD

The engine correctly enforces disjoint predicates (realized uses `WHERE event_type <> 'provisional_recognition'`; provisional uses `WHERE recognition_label IN ('provisional','settling')`). But the response shape of the BFF route must keep them in separate fields — the Architect must specify `realized` and `provisional` as sibling fields under `data`, NEVER summed or blended in the BFF or the web card. The web card must display them with distinct labels ("Realized Revenue" and "Provisional / Settling — not yet confirmed"). METRICS.md Rule: "never fed to billing or high-stakes recommendations."

**Required fix (D-4):** explicit per-field in the response envelope contract. The card must label both fields. Never a combined total.

---

### MEDIUM-2: Per-currency display — minor units, no float math (money surface)

**Files:** `packages/metric-engine/src/realized-revenue.ts` (returns `Map<CurrencyCode, bigint>`); web card TBD

The engine correctly returns `bigint` minor units per `CurrencyCode`. M1: one currency per brand (enforced by the 0018 trigger). The web card must format from minor units (INR: divide by 100 for display; AED/SAR: same). The STACK.md / METRICS.md rule: no floats for money, format for display only.

Risk: the developer uses `Number(bigint)` then `/100` then `toLocaleString()` — this is acceptable for display formatting (no monetary computation), but must not propagate the `Number` value back as a data value or into any arithmetic. A lint rule (`no-float-money`) already exists from prior work.

**Required fix (D-7):** the card formats minor units for display using a dedicated `formatMoney(minor: bigint, currencyCode: CurrencyCode): string` utility (either from `@brain/money` if it exists or a new small utility). No `parseFloat`, no `/100` inline in component code. The existing `no-float-money` lint rule must cover this path.

---

### LOW-1: `analytics/index.ts` export stub

**File:** `apps/core/src/modules/analytics/index.ts:7`

Currently `export {}`. The ESLint boundary rule enforces that other modules import only from this file. The new analytics service must be exported here. This is a wire-up task, not a design risk — but the Architect must note it so the developer doesn't accidentally import from `./internal/` directly.

---

### LOW-2: as_of date parameter validation

The BFF route accepts `as_of` as a query param. The Architect must bind a schema validation (Fastify schema or Zod) for the ISO date format. An invalid or missing `as_of` must return a 400, not a runtime exception from `new Date(undefined)`.

---

## Architect decision bindings

| ID | Binding |
|---|---|
| **D-1** | BFF route: `GET /api/v1/dashboard/realized-revenue?as_of=<YYYY-MM-DD>` (not `/api/v1/metrics` — stays in the BFF dashboard pattern; the analytics module is called in-process from the BFF). Response envelope: `{ request_id: string, data: { state: 'no_data' \| 'has_data', as_of: string, realized: { [currency_code]: string } \| null, provisional: { [currency_code]: string } \| null } }`. `realized` and `provisional` are null when `state = 'no_data'`. |
| **D-2** | Explicit honest-empty-state signal: the BFF route checks `EXISTS (SELECT 1 FROM realized_revenue_ledger WHERE brand_id = $1 AND recognition_label = 'finalized')` — or delegates this check to the analytics module — before calling the engine. Sets `state: 'no_data'` when no finalized rows exist, regardless of the engine's numeric output. NEVER returns `{ realized: { INR: '0' } }` with no state discriminant. |
| **D-3** | Sole-read-path enforcement: the analytics module (`apps/core/src/modules/analytics/internal/`) calls `computeRealizedRevenue` and `computeProvisionalRevenue` from `@brain/metric-engine`. No ad-hoc `SUM(amount_minor)` in the analytics module, the BFF route handler, or the web client. The backend-developer integration test must assert engine output == BFF response value for a seeded brand (exact bigint match, no rounding). |
| **D-4** | Provisional shown separately: the response envelope has `realized` and `provisional` as sibling fields under `data`. The web card renders them with distinct labels. No blending, no summing. If `provisional` Map is empty (no provisional rows), `provisional` field is `{}` or `null` — explicitly labeled "No provisional data" or omitted with a clear label in the card. |
| **D-5** | BFF envelope: matches the existing `BffEnvelope<T>` pattern (`{ request_id, data }`). The `dashboardApi.getRealizedRevenue()` client function uses `const { data } = await bffFetch<BffEnvelope<RawRealized>>('/v1/dashboard/realized-revenue')` and maps `data` to the component type. No deviation from the established unwrap pattern. Type the raw shape and the mapped shape separately (following the connector/pixel pattern in client.ts). |
| **D-6** | Brand isolation test: the negative-control test runs under `brain_app` (NOBYPASSRLS). Seeds brand A data, queries as brand B → expects `state: 'no_data'` or empty result. Reuses the CI postgres service config from feat-metric-engine-parity (postgres:16 + brain_app NOBYPASSRLS gate already in place). The test must not use the superuser for the assertion query. |
| **D-7** | Money formatting: `formatMoney(minor: bigint, currencyCode: CurrencyCode): string` utility (from `@brain/money` or a new `packages/money/src/format.ts`). No `parseFloat`, no inline `/100`. Web card uses this utility. Covered by existing `no-float-money` lint. |
| **D-8** | `analytics/index.ts` export: exports the public analytics service function (e.g. `getRevenueMetrics`) — no direct exports from `./internal/`. ESLint boundary rule enforced. |
| **D-9** | `as_of` validation: Fastify JSON schema on the BFF route validates `as_of` as a date string (`format: 'date'` or regex `^\d{4}-\d{2}-\d{2}$`). Missing or invalid → 400 with `{ request_id, error: { code: 'INVALID_DATE', message: ... } }`. |
| **D-10** | No new deployable: analytics module is in `apps/core` (existing monolith). Web card is in `apps/web` (existing Next.js app). No new service, no new package beyond possibly a format utility. |
| **D-11** | Migrations: none expected (read-only feature). If any migration is needed it must be additive (I-E02). |
| **D-12** | data-testids: the realized-revenue card must have `data-testid="realized-revenue-card"`, the value element `data-testid="realized-revenue-value"`, the provisional element `data-testid="provisional-revenue-value"`, and the no-data state `data-testid="realized-revenue-no-data"`. Required for the Playwright e2e. |

---

## Cost-routing audit

Every computation in this feature is Tier-0 deterministic (the metric engine is an in-process TypeScript function over Postgres — zero model calls, ~$0/mo). No cost-routing declaration is needed beyond noting the tier. The `@effort('deterministic')` annotation (or equivalent) must be present on the analytics module's service function per the cost-routing-paradigms skill.

---

## Tracks

- **@backend-developer:** analytics module internal service (`apps/core/src/modules/analytics/internal/`) + BFF route (`bff.routes.ts`) + engine wiring (`withBrandTxn`, `computeRealizedRevenue`, `computeProvisionalRevenue`) + isolation test under `brain_app`. Branch: stack on `feat/metric-engine-parity`.
- **@frontend-web-developer:** dashboard realized-revenue card (`apps/web/components/dashboard/realized-revenue-card.tsx`) + `dashboardApi.getRealizedRevenue()` in `apps/web/lib/api/client.ts` + Playwright e2e. Branch: same stack.

Both tracks are parallelizable after the BFF route contract (D-1 envelope shape) is locked by the Architect. The frontend can stub the API call while the backend implements; the contract is the coordination point.

---

## "No new deployable" confirmation

CONFIRMED. The analytics module is in `apps/core` (core monolith). The card is in `apps/web`. No new service, no new database, no new infrastructure. The metric engine is already an in-process library in `packages/metric-engine`.

---

## Domain check vs Product Canon

- THE-MOAT.md: this feature is the direct realization of moat wedge #1 ("realized-revenue CM2 as the headline number") and the honesty principle. It does not weaken any moat element; it completes the M1 spine.
- METRICS.md Rules: realized and provisional are correctly defined; the engine is the sole emitter; no float math; no blending. Finalized-only for the `realized` field.
- ADR-002: sole-read-path maintained — analytics module calls engine, no ad-hoc SQL.
- F-SEC-02 (deferred): `withBrandTxn` already implements the fix (transaction-scoped GUC). This feature must not regress it.

---

## Open questions for the Architect (not blockers)

1. Should `as_of` default to today (server-side `new Date()`) when omitted? Recommended: yes, with explicit server-side date computation, not client-supplied.
2. The `analytics/index.ts` public export surface — should it export a service class or a plain function? Recommend plain function (simpler, consistent with the metric engine pattern).
3. TanStack Query cache key for `getRealizedRevenue` — should it re-fetch on brand switch? Yes — the brand switch re-mints the session (BFF `set-brand`), so TanStack Query should invalidate dashboard queries on brand context change.
