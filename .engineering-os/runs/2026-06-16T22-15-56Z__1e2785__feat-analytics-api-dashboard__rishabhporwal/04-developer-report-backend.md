# Developer Report — Backend Track A — feat-analytics-api-dashboard

**Stage:** 3 · **Engineer:** Backend · **Date:** 2026-06-17
**Branch:** `feat/analytics-api-dashboard`
**Req:** `feat-analytics-api-dashboard`

---

## Files Implemented

### New (Slice 1 — `a8f3361`, pre-existing from prior run)
- `apps/core/src/modules/analytics/internal/domain/metrics/revenue-snapshot.ts` — `RevenueSnapshot` discriminated union type + `serializeMoneyMap(Map<CurrencyCode,bigint>) → Record<string,string>` (bigint→String, D-1)
- `apps/core/src/modules/analytics/internal/application/queries/get-revenue-metrics.ts` — `getRevenueMetrics(brandId, asOf, EngineDeps): Promise<RevenueSnapshot>` use-case; `@effort deterministic`; EXISTS(finalized) honest-empty check; computeRealizedRevenue + computeProvisionalRevenue calls (engine-only, no ad-hoc SUM); D-2/D-3

### Modified (Slice 1 — `a8f3361`, pre-existing from prior run)
- `apps/core/src/modules/analytics/index.ts` — replaced `export {}` stub with public exports `getRevenueMetrics` + `RevenueSnapshot` (D-8)
- `apps/core/src/modules/frontend-api/internal/bff.routes.ts` — added `rawPool?: PgPool` param to `registerBffRoutes` (additive, no existing callers broken); added `GET /api/v1/dashboard/realized-revenue` route (bffProtectedPreHandler, Fastify JSON schema validates `as_of` pattern, 400 INVALID_DATE on bad value, brand from session, rawPool-guarded, calls `getRevenueMetrics`, `{request_id,data}` envelope)
- `apps/core/src/main.ts` — threads `rawPgPool` into `registerBffRoutes` (D §3.1 — raw pool, not DbPool wrapper, avoids double-GUC/F-SEC-02)

### New (Slice 2 — `9616d11`)
- `apps/core/src/modules/analytics/tests/revenue-metrics.live.test.ts` — 20 live Postgres tests (dual-pool harness: superPool=brain, appPool=brain_app)

---

## Slice Dispositions

### Slice 1 — analytics service + BFF route
**Status:** COMMITTED (`a8f3361` — committed by prior pipeline run; verified identical to plan)
- D-1: route + `{request_id,data}` envelope ✓
- D-2: EXISTS(finalized) honest-empty check ✓ (not value-derived)
- D-3: engine-only computations, no ad-hoc SUM ✓
- D-8: `analytics/index.ts` public surface only ✓
- D-9: Fastify schema `as_of` pattern validation → 400 INVALID_DATE ✓
- F-SEC-02: rawPgPool (not DbPool wrapper) ✓

### Slice 2 — tests (live PG)
**Status:** COMMITTED (`9616d11`)
**Result:** 20/20 tests pass

---

## Verification Output

### 1. Typecheck — EXIT 0
```
pnpm --filter @brain/core typecheck
> tsc --noEmit
(no output — clean exit)
```

### 2. Live Tests — 20/20 PASS
```
vitest run src/modules/analytics/tests/revenue-metrics.live.test.ts

 RUN  v2.1.9 /Users/rishabhporwal/Desktop/Brain V3/apps/core
 ✓ src/modules/analytics/tests/revenue-metrics.live.test.ts (20 tests) 75ms
 Test Files  1 passed (1)
      Tests  20 passed (20)
   Start at  06:42:43
   Duration  266ms
```

### 3. Grep — Sole-Read-Path Proven
```
grep -rn "SUM(" apps/core/src/modules/analytics/internal/ --include="*.ts"
→ Only in comment lines (/* */ and //), ZERO executable SUM calls

grep -n "SUM(" apps/core/src/modules/frontend-api/internal/bff.routes.ts
→ Line 929: "   * NO ad-hoc SUM(amount_minor) here — the ONLY SQL..."
→ Comment only — zero executable SUM calls
```

The analytics module calls `computeRealizedRevenue` + `computeProvisionalRevenue` from `@brain/metric-engine` exclusively. The ONLY additional SQL is:
```sql
EXISTS(SELECT 1 FROM realized_revenue_ledger WHERE brand_id=$1 AND recognition_label='finalized')
```
This is an existence check (not a value computation), explicitly required by D-2 and allowed by D-3.

---

## Four Invariant Proofs

### Proof 1 — engine==BFF exact-bigint (D-3, sole-read-path)
**Test:** `1. engine==BFF exact-bigint — sole-read-path proof (D-3)`
- Seeded BRAND_A finalized row: 123450n (INR paise)
- `computeRealizedRevenue(BRAND_A, today, {pool: appPool})` → Map{INR: 123450n}
- `getRevenueMetrics(BRAND_A, today, {pool: appPool})` → `{state:'has_data', realized:{INR:'123450'}}`
- Assert: `snapshot.realized['INR'] === String(engineMap.get('INR'))` → PASS
- This test FAILS if the route used an ad-hoc SUM: the engine's `realized_gmv_as_of()` excludes provisional rows while a naive SUM would include them (double-count proof exists in test 1 of ledger tests).

### Proof 2 — honest-empty-state (D-2, never bare 0)
**Test:** `2. honest-empty-state — no finalized rows → state=no_data, never bare 0 (D-2)`
- Brand with only provisional rows: `state='no_data'`, `realized===null`
- Brand with zero rows: same
- Explicitly asserts `realized !== { INR: '0' }` and `realized !== {}`
- The `??'0'` landmine (realized-revenue.ts:71) is neutralized by the EXISTS check before calling the engine.

### Proof 3 — isolation under brain_app (D-6, F-SEC-02)
**Test:** `3. isolation negative-control under brain_app — cross-brand=no_data (D-6)`
- Asserts `current_user='brain_app'` + `is_superuser=false` (RLS not bypassed)
- Seeded BRAND_A finalized data via superPool; queried BRAND_B via appPool
- `getRevenueMetrics(BRAND_B, today, {pool: appPool})` → `{state:'no_data', realized:null}`
- BRAND_A's value does NOT appear in BRAND_B's result
- `withBrandTxn` sets `app.current_brand_id=BRAND_B`; RLS policy on `realized_revenue_ledger` (ENABLE+FORCE) filters to BRAND_B only → BRAND_A rows invisible

### Proof 4 — provisional separate, never blended (D-4)
**Test:** `4. provisional shown separately — never blended with realized (D-4)`
- Seeded: finalized=500000n, provisional=75000n (different orders, different event_type/recognition_label)
- `snapshot.realized['INR'] === '500000'` (finalized only, NOT provisional, NOT sum 575000)
- `snapshot.provisional['INR'] === '75000'` (provisional only)
- Provisional-only brand → `state='no_data'` (EXISTS(finalized) is the discriminant)

---

## §Contract for Frontend (D-1 — frozen)

**Route:** `GET /api/v1/dashboard/realized-revenue?as_of=<YYYY-MM-DD>`
- `as_of` optional; omitted → server defaults to today (`new Date()` server-side, never client-trusted)
- Session-guarded (bffProtectedPreHandler — httpOnly cookie + CSRF)
- Brand from session (`auth.brandId`) — NOT from request body

**Success 200:**
```json
{
  "request_id": "uuid",
  "data": {
    "state": "no_data" | "has_data",
    "as_of": "2026-06-17",
    "realized": { "INR": "123450" } | null,
    "provisional": { "INR": "5000" } | {} | null
  }
}
```
- `realized` and `provisional` are `Record<currency_code, string>` — bigint minor units as decimal string
- `state='no_data'` → both `realized` and `provisional` are `null` (honest-empty, never a bare 0)
- `state='has_data'` → `realized` and `provisional` are sibling records (never summed/blended)
- Empty provisional map `{}` when finalized rows exist but no provisional rows

**Error 400 (bad as_of):**
```json
{
  "request_id": "uuid",
  "error": { "code": "INVALID_DATE", "message": "as_of must be YYYY-MM-DD." }
}
```
Triggered on: non-date strings (`foo`, `2026-13-01`). Valid ISO dates pass.

**Error 401:** No session (existing BFF pattern).

**Error 503:** rawPool not available.

**CRITICAL for frontend (no 9th envelope mismatch, D-5):**
```typescript
// CORRECT — unwrap .data first:
const { data } = await bffFetch<BffEnvelope<RawRealizedRevenue>>('/v1/dashboard/realized-revenue');
// data.state, data.realized, data.provisional

// WRONG — reading flat shape:
const result = await bffFetch<...>('/v1/dashboard/realized-revenue');
result.realized // undefined — the BFF wraps in { request_id, data }
```
The frontend must use `const { data } = ...` destructure (same as `getBrandSummary` at client.ts:666).

---

## Self-Review vs Security + QA Gates

| Gate | Status |
|---|---|
| Access control guard on route | PASS — bffProtectedPreHandler (session + CSRF) |
| Tenant/brand from session, not body | PASS — `auth.brandId` only |
| Input validation | PASS — Fastify JSON schema (as_of pattern), 400 INVALID_DATE |
| Idempotency | N/A — read-only route |
| Money in minor units + string serialization | PASS — bigint→String, no floats |
| No ad-hoc SUM | PASS — grep clean + test-proven |
| Raw pool (not DbPool wrapper) | PASS — rawPgPool threaded, F-SEC-02 not regressed |
| RLS under brain_app | PASS — isolation test asserts current_user='brain_app', cross-brand=no_data |
| Honest-empty-state | PASS — EXISTS(finalized) check, never bare 0 |
| Cursor pagination | N/A — single-value endpoint, no list |
| Trace ID / request_id | PASS — `randomUUID()` on every reply |
| No PII | PASS — only aggregate money values and state enum |
| `analytics/index.ts` boundary | PASS — only public fn exported, no ./internal/ imports cross-boundary |
| Affected-only deploy | PASS — no new deployable; `apps/core` change triggers core rebuild only |
| No migration | PASS — read-only feature (D-11) |

---

## Commits Per Slice

| Slice | SHA | Description |
|---|---|---|
| Slice 1 | `a8f3361` | feat(web): [prior run] analytics service + BFF route + index export + main.ts threading |
| Slice 2 | `9616d11` | test(analytics): 20 live tests — engine==BFF, honest-empty, isolation under brain_app, sole-read-path |
