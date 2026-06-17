# Feature Journal — feat-analytics-api-dashboard

**Status:** SHIPPED (Stage 8 complete)
**Branch:** `feat/analytics-api-dashboard`
**Milestone:** M1 finale
**Lane:** high_stakes (metric_engine, money, multi_tenancy)

---

## Summary

The M1 vertical spine finale. Adds the realized-revenue dashboard card + Analytics API to Brain V3. The spine is now complete: Bronze → identity → ledger → metric engine → Analytics API → dashboard.

**Paradigm:** Tier-0 deterministic. Zero model calls. $0/mo, 0 tokens/day. Every computation is a typed function over Postgres.

**Four invariants delivered and live-verified:**
1. **Honest-empty-state** — `state='no_data'` when no finalized rows exist; never a bare 0
2. **Sole-read-path** — engine-only (`computeRealizedRevenue` + `computeProvisionalRevenue`); no ad-hoc SUM anywhere in the analytics path
3. **No 9th envelope mismatch** — `const { data } = await bffFetch<BffEnvelope<RawRealizedRevenue>>(...)` unwrap enforced; raw + mapped types separate
4. **Isolation under brain_app** — `withBrandTxn` + RLS; EXISTS(finalized) check inside txn-scoped GUC; cross-brand negative test asserts `current_user='brain_app'`

---

## Key Files Shipped

**Backend (apps/core):**
- `src/modules/analytics/internal/domain/metrics/revenue-snapshot.ts` — `RevenueSnapshot` discriminated union + `serializeMoneyMap`
- `src/modules/analytics/internal/application/queries/get-revenue-metrics.ts` — `getRevenueMetrics` use-case; `@effort deterministic`; EXISTS(finalized) guard
- `src/modules/analytics/index.ts` — public export surface (replaces `export {}`)
- `src/modules/frontend-api/internal/bff.routes.ts` — `GET /api/v1/dashboard/realized-revenue` route added; `rawPool` param added to `registerBffRoutes`
- `src/main.ts` — `rawPgPool` threaded into `registerBffRoutes`
- `src/modules/analytics/tests/revenue-metrics.live.test.ts` — 20/20 live tests (dual-pool harness: superPool=brain, appPool=brain_app)

**Frontend (apps/web):**
- `lib/format/money-display.ts` — `formatMoneyDisplay(minorString, currencyCode)` using BigInt arithmetic, no parseFloat
- `lib/api/client.ts` — `dashboardApi.getRealizedRevenue()` + `RawRealizedRevenue` + `DashboardRealizedRevenueResponse`
- `lib/hooks/use-dashboard.ts` — `useRealizedRevenue()` keyed under `DASHBOARD_QUERY_KEY` (auto-invalidates on brand switch)
- `components/dashboard/realized-revenue-card.tsx` — card with all 4 testids; EmptyState on no_data; two separate blocks for realized vs provisional
- `app/(dashboard)/dashboard/page.tsx` — `<RealizedRevenueCard />` mounted
- `e2e/realized-revenue.spec.ts` — 4/4 e2e tests (smoke proxy)

---

## Route Contract

**GET /api/v1/dashboard/realized-revenue?as_of=YYYY-MM-DD**

Success 200:
```json
{
  "request_id": "uuid",
  "data": {
    "state": "no_data | has_data",
    "as_of": "2026-06-17",
    "realized": { "INR": "123450" } | null,
    "provisional": { "INR": "5000" } | {} | null
  }
}
```

- `state` driven by `EXISTS(finalized)` — NOT by value
- `realized` and `provisional` are sibling records, never summed/blended
- bigint serialized as decimal string (no JSON bigint, no float)
- `as_of` omitted → server-side `new Date()` (never client-trusted)
- `as_of` bad format → 400 INVALID_DATE
- No session → 401; no rawPool → 503

---

## Deploy Evidence

| Check | Result |
|---|---|
| Pre-flight typecheck @brain/core | EXIT 0 |
| Pre-flight typecheck @brain/web | EXIT 0 |
| New migrations (analytics-api-dashboard slice) | NONE (read-only, D-11) |
| Migration 0020 in dev DB | CONFIRMED (prosecdef=f) |
| GET /health | 200 OK |
| GET /api/v1/dashboard/realized-revenue (unauth) | 401 (not 5xx) |
| E2E realized-revenue.spec.ts | 4/4 PASS (24.4s) |
| 5xx during smoke | NONE |

---

## Tech-Debt Carried Forward

| ID | Severity | Description | Target |
|---|---|---|---|
| LOW-SEC-001 | LOW | Security reviewer deferred (accepted by Stakeholder) | M2 |
| QA-F-002 | LOW | QA deferred (accepted by Stakeholder) | M2 |
| F-SEC-02 | LOW/P2 | GetRealizedGmvAsOf GUC-reset defense-in-depth (old path; new analytics path correct) | Before Phase-2 |
| QA-3 | MED | audit_log.correlation_id on some paths | M2 |

---

## Commits (analytics-api-dashboard slice)

| SHA | Description |
|---|---|
| `a8f3361` | feat(web): client adapter + hook + money display formatter (D-1,D-4,D-5,D-6,D-7) |
| `18c6d18` | feat(web): realized-revenue card + dashboard mount (D-2,D-4,D-12) |
| `4789680` | test(web): realized-revenue e2e spec — no-data, real-number, envelope unwrap (D-2,D-4,D-5,D-7) |
| `9616d11` | test(analytics): engine==BFF, honest-empty, isolation under brain_app, sole-read-path (D-2,D-3,D-4,D-6) |

---

## M1 Completion Note

With this ship, M1 (Internal Alpha) exit criteria are met:
- Reconciling realized-revenue number on screen (real engine output, not fabricated)
- Isolation test passes (20 live tests under brain_app; e2e provisional-separate test)
- Parity oracle green on spine metrics (feat-metric-engine-parity, already shipped)

Branch→master merge is the Stakeholder's GitHub action.
