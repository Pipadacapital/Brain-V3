# Build Report — feat-ad-connectors (Slice 1)

| Field | Value |
|---|---|
| **req_id** | `feat-ad-connectors` |
| **Stage** | 3 — Build (complete) → handing to Stage 4/5 review |
| **Build vehicle** | dynamic Workflow `wsofg2myl` (4 parallel tracks, opus agents) |
| **Branch** | `feat/ad-connectors-slice1` |
| **Built at** | 2026-06-18T06:28Z |
| **Dev-honesty** | OAuth proven against synthetic/state-signed flow; real platform app credentials + public callback are an explicit platform follow-up (same boundary Shopify/Razorpay declared) |

## Track outcomes

### Track 1 — OAuth Connect (Meta + Google) — COMPLETE / READY-FOR-SECURITY
- Catalog registry flip `meta` + `google_ads` → `available` (`apps/core/.../connector/catalog/registry.ts`).
- OAuth dispatch extended beyond Shopify: Meta + Google commands under `apps/core/.../connector/sources/advertising/{meta,google}/`. Brand from the signed state, **never** the body; tokens via the secrets seam, never logged. No HMAC (OAuth-code exchange, not webhook).
- 134 connector tests PASS. Track 1 also corrected pre-existing stale `connector-marketplace.live.test.ts` assertions (the two providers are no longer `coming_soon`).

### Track 2 — Spend ingestion (the trailing re-pull) — COMPLETE (dev-honest)
- Migration `0029_ad_spend.sql` applied + idempotent: `ad_spend_ledger` (append-only, FORCE-RLS, ON CONFLICT dedup), `ad_spend_as_of(uuid,date,date)` SECURITY INVOKER read seam (sole spend read path), `list_ad_connectors_for_spend_repull()` SECURITY DEFINER enumeration, migration-time assertions (prosecdef / search_path / grant), money `spend_minor` BIGINT.
- `@brain/ad-spend-mapper` — `spend.live.v1`, `uuidV5FromSpendRow` deterministic dedup id — **13 unit PASS**.
- stream-worker jobs `meta-spend-repull` + `google-ads-spend-repull` (trailing ~28-day re-read cursor, overlap-locked, Google two-error backoff). Bug caught + fixed in review: `String(err).startsWith(CODE)` → `.includes()` (error code is embedded, not a prefix).
- `SpendLedgerConsumer` wired in `main.ts` (import:32, start:233); `LedgerWriter.writeAdSpend`.
- `spend-ledger-wiring.e2e` **7 PASS**, `spend-repull-smoke.e2e` **2 PASS**, settlement-wiring regression **6 PASS** (no regression).

### Track 3 — Spend/ROAS metrics — COMPLETE
- `packages/metric-engine/src/{ad-spend-timeseries,blended-roas}.ts` (sole-read-path, money minor units).
- BFF queries `get-ad-spend-timeseries.ts` + `get-blended-roas.ts` (read inside `withBrandTxn`, RLS-scoped).
- `metric-engine` typecheck clean; registry tests updated.

### Track 4 — Spend/ROAS UI (stakeholder-visible) — COMPLETE
- `apps/web/app/(dashboard)/analytics/spend/` route + `components/analytics/ad-spend-trend-chart.tsx` (shadcn/Recharts, currency-aware, honest empty state).
- Marketplace Meta/Google tiles become connectable (OAuth flow).
- e2e `analytics-spend.spec.ts`.

## Dev-honest verification (this session, pre-commit)
- `@brain/ad-spend-mapper` `tsc --noEmit` — clean.
- `@brain/metric-engine` `tsc --noEmit` — clean.
- Full isolation-under-brain_app + real-network smoke + metric parity are the Stage 5 QA gate's job (re-run there, not asserted here).

## Carried into review
- Real Meta/Google app credentials + public OAuth callback (platform follow-up — dev boundary, declared).
- Migration renumber 0028→0029 documented in the SQL header (0028 taken by collection-foundation).
