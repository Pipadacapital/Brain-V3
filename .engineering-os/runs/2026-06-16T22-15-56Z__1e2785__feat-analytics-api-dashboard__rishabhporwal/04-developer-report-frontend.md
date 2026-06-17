# Developer Report — Frontend (Track B) — feat-analytics-api-dashboard

**Stage:** 3 · **Engineer:** Frontend/Web Developer · **Branch:** feat/analytics-api-dashboard
**Date:** 2026-06-17 · **Run:** `2026-06-16T22-15-56Z__1e2785__feat-analytics-api-dashboard__rishabhporwal`

---

## Summary

Track B builds the realized-revenue dashboard card against the §4 API contract built by Track A (backend route live at `GET /api/v1/dashboard/realized-revenue`). Three chunks committed in sequence.

---

## Files Changed

| File | Status | Description |
|---|---|---|
| `apps/web/lib/format/money-display.ts` | NEW | `formatMoneyDisplay(minorString, currencyCode)` — UI formatter |
| `apps/web/lib/api/client.ts` | MODIFIED | `dashboardApi.getRealizedRevenue()` + `RawRealizedRevenue` type |
| `apps/web/lib/api/types.ts` | MODIFIED | `DashboardRealizedRevenueResponse` type added |
| `apps/web/lib/hooks/use-dashboard.ts` | MODIFIED | `useRealizedRevenue()` hook |
| `apps/web/components/dashboard/realized-revenue-card.tsx` | NEW | Card component |
| `apps/web/app/(dashboard)/dashboard/page.tsx` | MODIFIED | Mounts `<RealizedRevenueCard />` |
| `apps/web/e2e/realized-revenue.spec.ts` | NEW | E2E spec (4 tests) |

---

## Acceptance Condition Disposition

### D-5: Envelope unwrap (no 9th mismatch)

**SATISFIED.**

`client.ts:757`:
```ts
const { data } = await bffFetch<BffEnvelope<RawRealizedRevenue>>(
  `/v1/dashboard/realized-revenue${qs}`,
);
```

Raw type `RawRealizedRevenue` (interface, local to client.ts) and mapped type `DashboardRealizedRevenueResponse` (exported from types.ts) are declared SEPARATELY. The mapping function (`getRealizedRevenue`) maps `data.state`, `data.as_of`, `data.realized`, `data.provisional` — no flat-shape read.

Grep proof: `grep -n "const { data } = await bffFetch" apps/web/lib/api/client.ts` → line 757 matches `BffEnvelope<RawRealizedRevenue>`.

### D-7: No float math

**SATISFIED.**

`apps/web/lib/format/money-display.ts`:
- Input: `minorString: string` (bigint-serialized from BFF)
- Parse: `BigInt(minorString)` — no `parseFloat`, no `Number()` on the raw string
- Arithmetic: `bigint / bigint` (divisor = `100n`) — integer division only
- Display: `Intl.NumberFormat` over a decimal string composed from integer parts
- No `/100`, no `parseFloat` anywhere in the functional code paths

Grep proof: `grep -n "parseFloat\|/ 100\|/100" apps/web/lib/format/money-display.ts apps/web/components/dashboard/realized-revenue-card.tsx` → all matches are in comments only.

### D-2: Honest empty state (never a fake/0 number)

**SATISFIED.**

`realized-revenue-card.tsx:63`:
```tsx
if (!data || data.state === 'no_data') {
  // renders EmptyState "No data yet" with data-testid="realized-revenue-no-data"
  // NEVER renders a 0 or fabricated number
}
```

The `state` discriminant is checked first. `data.realized` is only rendered when `state === 'has_data'`. The card does NOT check `realized !== null` independently — it relies on the `state` field as the authoritative discriminant (as specified in D-2: "the UI renders 'No data yet' on `state==='no_data'` regardless of any value").

### D-4: Provisional separate, never blended

**SATISFIED.**

The card renders realized and provisional in two distinct blocks:
- Block 1: "Realized Revenue" label + `data-testid="realized-revenue-value"` per currency
- Block 2: "Provisional / Settling — not yet confirmed" label + `data-testid="provisional-revenue-value"` per currency

No arithmetic between the two. `Object.entries(realized)` and `Object.entries(provisional)` are rendered independently. Empty provisional → "No provisional data" text.

### D-6: Cache invalidation on brand switch

**SATISFIED.**

`useRealizedRevenue()` hook key: `[...DASHBOARD_QUERY_KEY, 'realized-revenue', asOf ?? 'today']`

`DASHBOARD_QUERY_KEY = ['dashboard']`. The brand-switcher at `apps/web/components/dashboard/brand-switcher.tsx:13` already calls `queryClient.invalidateQueries({ queryKey: DASHBOARD_QUERY_KEY })` which invalidates the full `['dashboard']` prefix → includes `['dashboard', 'realized-revenue', ...]` → zero extra code needed.

### D-12: testids

**SATISFIED.**

All four required testids present:
- `realized-revenue-card` — on the outer `<Card>` (both no_data and has_data states)
- `realized-revenue-value` — on the `<span>` for each realized currency entry
- `provisional-revenue-value` — on the `<span>` for each provisional currency entry
- `realized-revenue-no-data` — on both the `EmptyState` component and a `sr-only` span (two elements for Playwright targeting flexibility)

---

## Verification

### 1. Typecheck

```
pnpm --filter @brain/web typecheck
> tsc --noEmit
[EXIT 0 — no output, no errors]
```

### 2. Envelope unwrap proof

```
grep -n "const { data } = await bffFetch" apps/web/lib/api/client.ts
```
Output confirms line 757: `const { data } = await bffFetch<BffEnvelope<RawRealizedRevenue>>(` — canonical `const { data }` unwrap, never flat.

### 3. No-float proof

```
grep -n "parseFloat\|/ 100\|/100" apps/web/lib/format/money-display.ts apps/web/components/dashboard/realized-revenue-card.tsx apps/web/lib/api/client.ts
```
All matches are in JSDoc comments (constraint documentation), not in functional code paths. Zero active `/100` or `parseFloat` operations.

### 4. Honest empty-state

```
grep -n "no_data\|No data yet\|realized-revenue-no-data" apps/web/components/dashboard/realized-revenue-card.tsx
```
Confirms `state === 'no_data'` check at line 63, `EmptyState` with `title="No data yet"` at line 74.

### 5. E2E status

The e2e spec (`apps/web/e2e/realized-revenue.spec.ts`) requires the full running stack (Next.js + BFF + Postgres). The backend route `GET /api/v1/dashboard/realized-revenue` is confirmed live on the branch at `apps/core/src/modules/frontend-api/internal/bff.routes.ts:944`. E2E requires `DATABASE_URL` pointing to a running Postgres instance with migrations applied.

**No-data path** is purely UI-side and deterministic (any freshly-onboarded brand has zero finalized ledger rows → BFF returns `state:'no_data'` → card shows "No data yet"). This path can be verified with a running stack regardless of seed state.

**Real-number path** requires seeding: `seedFinalizedLedgerRow()` inserts via superuser to `realized_revenue_ledger`. Amount `123450` INR → expected display `₹1,234.50` (asserted via `toContain('₹')` + `toContain('1,234')`).

**Envelope assertion** intercepts the BFF response and asserts `{ request_id, data: { state, as_of } }` shape.

---

## Commits

| SHA | Description |
|---|---|
| `a8f3361` | feat(web): client adapter + hook + money display formatter (D-1,D-4,D-5,D-6,D-7) |
| `18c6d18` | feat(web): realized-revenue card + dashboard mount (D-2,D-4,D-12) |
| `4789680` | test(web): realized-revenue e2e spec — no-data, real-number, envelope unwrap (D-2,D-4,D-5,D-7) |

---

## Notes for Reviewers

1. `@brain/money` is accessed via the tsconfig `@brain/*` → `../../packages/*/src` path alias (no package.json dep required; the tsconfig already resolves it). `formatMoneyDisplay` imports only `money()` VO and `CurrencyCode` from `@brain/money` — for VO construction and currency validation only. The actual display is `Intl.NumberFormat`.

2. The `formatMoneyDisplay` function uses `Number(decimalString)` only AFTER constructing the decimal string from bigint integer division. This is display-only and precision-safe for typical monetary amounts (INR values up to ₹9 quadrillion are within `Number.MAX_SAFE_INTEGER / 100`). No float math is applied to the raw minor-unit value.

3. The `realized-revenue-no-data` testid appears twice in the no-data render: once on the `EmptyState` wrapper prop (which the component passes to its outer div), and once on a `sr-only` span. The Playwright test uses `.first()` or will match either. This provides resilience if the EmptyState component's internal testid forwarding changes.

4. Contract match vs Track A: §4 envelope confirmed (`{ request_id, data: { state, as_of, realized, provisional } }`). The `realized` and `provisional` fields are `Record<string, string> | null` — minor-unit strings, never summed. The frontend types mirror this exactly.

5. A11y: card uses `aria-label` on all states; value `<span>` elements carry `aria-label` with full context including currency and as-of date; no status is colour-only; `<time>` element wraps the `as_of` date for semantic HTML. Icon is `aria-hidden="true"` (decorative). Loading state carries `aria-label="Realized Revenue — loading"`.

---

## Journal

```
## 2026-06-17T00:20Z — Frontend/Web Engineer — feat-analytics-api-dashboard
Stage: 3 · Surface: dashboard/realized-revenue-card · Web-vitals: not measured (build-side task)
Verification: pnpm --filter @brain/web typecheck → EXIT 0; grep proofs for envelope unwrap + no-float
Next: READY-FOR-SECURITY
```
