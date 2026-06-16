# Requirement: Analytics API + dashboard — realized_revenue on screen (the M1 finale)

| Field | Value |
|-------|-------|
| **req_id** | `feat-analytics-api-dashboard` |
| **Title** | Analytics API (sole read path) + dashboard — surface realized_revenue, honest empty state |
| **Submitted by** | rishabhporwal |
| **Submitted at** | 2026-06-16T22:15:56Z |
| **Tier impact** | M1 data-plane critical path — the FINAL layer (metric engine → **Analytics API → dashboard**) |
| **Region impact** | India (per-currency display, single-currency-per-brand) |

---

## Lane *(advisor to confirm — deterministic scan: high_stakes; surfaces: metric_engine, money, multi_tenancy)*

---

## Raw text (from the Stakeholder)

> Build the **Analytics API + dashboard** — the last layer of the M1 vertical spine (after `feat-metric-engine-parity`, shipped). Put the reconciling number ON SCREEN. This is the connector-ingestion epic's §6→Analytics + §9 "Analytics-API-as-sole-read-path". Wire the EXISTING scaffolds: `apps/core/src/modules/analytics`, the BFF dashboard routes, the web dashboard cards.
>
> DELIVER:
> 1. **Analytics API (the SOLE read path, ADR-002):** a read-only endpoint in the `analytics` module — `GET /api/v1/metrics?metric_id=realized_revenue&as_of=<date>` (and `provisional_revenue`) — that calls the shipped metric engine (`packages/metric-engine` — the sole emitter) under the brand's RLS context (txn-scoped GUC via `withBrandTxn`, do NOT regress F-SEC-02), and returns the per-`currency_code` result. realized + provisional returned SEPARATELY (NEVER blended). No ad-hoc SUM — the engine is the only computation. Surfaced to the web through the BFF (`/api/v1/dashboard/*` pattern).
> 2. **Honest empty state (the §8 / BRD honesty principle):** when a brand has no finalized ledger data, the API returns an explicit "no data yet" signal — NEVER a fabricated or zero-disguised-as-real number. The dashboard renders "No data yet" (a guided empty state), never a fake number.
> 3. **Dashboard card:** a realized-revenue card on the dashboard that fetches via the BFF, renders the per-currency number (money formatted from minor units + currency_code) with `provisional_revenue` shown ALONGSIDE (clearly labeled, never blended), or the honest empty state. data-testids for e2e.
> 4. **Money discipline:** minor units + currency_code formatted for display (no float math; format only); per-currency; never blend currencies.
> 5. **Per-brand isolation (the ONE invariant + §9):** the Analytics API is brand-scoped; the metric engine reads under the caller's brand RLS; switching brands shows that brand's number; cross-brand = 0 under `SET ROLE brain_app`; no PII.
> 6. **Automated tests:** the API returns the engine's number (== the metric-engine output) for a seeded brand; honest empty state when no data; isolation negative-control under `brain_app` (brand A's API never returns brand B's number); a Playwright e2e — onboard → (seed a finalized ledger row) → dashboard shows the realized-revenue number (not a fake), and a no-data brand shows "No data yet".

---

## Problem statement

The metric engine computes `realized_revenue` and the parity oracle guarantees it can't drift from the ledger — but nothing SURFACES it. The Analytics API (the sole read path per ADR-002/§9) + a dashboard card are the last layer that completes the M1 vertical spine end-to-end: an order's economic truth, from Bronze → identity → ledger → metric engine, finally rendered as the reconciling number on screen — or an honest "no data yet" when there's nothing real to show.

## Target user

Owner / Brand Admin viewing the dashboard. India DTC brand, M1.

## Success metric

For a brand with finalized ledger data, the dashboard shows the realized-revenue number that EQUALS the metric engine's output (per-currency), with provisional shown separately; a brand with no data shows an honest "No data yet" (never a fabricated number); cross-brand isolation holds (brand A never sees brand B's number under `brain_app`). The M1 vertical spine is complete end-to-end (the reconciling number on screen).

## Constraints

- **Analytics API = the SOLE read path** (ADR-002 / §9) — the metric engine is the only computation (no ad-hoc SUM in the API/BFF/web); the API reads via the engine.
- **Honesty (BRD / §8):** never display a fabricated, zero-disguised, or estimated-as-real number; "no data yet" is explicit and first-class.
- **Money:** minor units + currency_code; format for display only (no float math); per-currency; never blend currencies.
- Absolute brand/tenant isolation (the ONE invariant); brand-scoped reads; verify under `SET ROLE brain_app` (dev superuser masks RLS). No PII. Do NOT regress F-SEC-02 (read under `withBrandTxn` txn-scoped GUC).
- Hard rule: no NEW deployable — the analytics module in the existing core + the existing web/BFF; the metric engine is an in-process library.
- Migrations additive (I-E02) if any (likely none — read-only).

## Non-goals

- The OTHER metrics (cm1/cm2/attribution/identity_match_rate/...) — this surfaces `realized_revenue` (+ provisional). The API shape should generalize, but only these two are wired.
- StarRocks / the full Analytics API surface (MCP read tools, the analytics query language) — M1 reads the Postgres ledger via the engine.
- Connectors / backfill / live-sync / settlement / Silver-Gold-dbt (other epic slices).
- Charts/timeseries/breakdowns — a single as-of realized-revenue card for M1 (timeseries is later).
- Real Shopify data (synthetic/seeded finalized ledger rows for tests; the deep Shopify connector is a separate epic slice).

## Linked prior runs

- feat-metric-engine-parity (the engine the API calls — the sole emitter)
- feat-realized-revenue-ledger, feat-identity-graph, feat-data-plane-ingest-spine (the spine)

## Notes

- Scaffolds: `apps/core/src/modules/analytics/{index.ts, internal}` (the sole-read-path module), the BFF dashboard routes (`apps/core/src/modules/frontend-api/internal/bff.routes.ts` — `GET /api/v1/dashboard/*` pattern + the `{request_id, data}` envelope — keep the envelope consistent so the web client unwraps correctly; we've fixed ~8 envelope-mismatch bugs, do NOT add a 9th), the web dashboard cards (`apps/web/components/dashboard/*` — add a realized-revenue card; client in `apps/web/lib/api/client.ts`).
- The engine seam: `packages/metric-engine` `computeRealizedRevenue(brandId, asOf, db)` / `computeProvisionalRevenue(...)` → `Map<CurrencyCode, bigint>`, read under `withBrandTxn`. The Analytics API calls these.
- **Architect must bind:** the API route shape (`/api/v1/metrics` vs a `/dashboard/realized-revenue` BFF route) + the response envelope (consistent with the dashboard `{request_id, data}` pattern so the web client unwraps `.data`); the per-currency display contract; the honest-empty-state signal (an explicit field, not an ambiguous 0); the BFF→engine wiring (the analytics module calls the engine in-process under brand RLS).
- Builder lesson: tight scopes + COMMIT PER SLICE. Tracks: **@backend-developer** (analytics API + BFF route + engine wiring) ∥ **@frontend-web-developer** (dashboard card + client + e2e). Verify isolation under `SET ROLE brain_app`.
- This COMPLETES the M1 vertical spine (Bronze → identity → ledger → metric → **Analytics API → dashboard**).
