# Requirement: Connector lifecycle + real-data regression suite

| Field | Value |
|-------|-------|
| **req_id** | `chore-connector-lifecycle-regression` |
| **Title** | Regression suite — connector connect→disconnect→reconnect lifecycle + real Shopify pagination + the GUC/secret edges |
| **Submitted by** | rishabhporwal |
| **Submitted at** | 2026-06-17T12:35:15Z |
| **Tier impact** | Connector connect/backfill path — the test coverage that the marketplace + backfill slices missed |
| **Region impact** | India (INR brand); single-currency-per-brand |

---

## Lane *(advisor to confirm — deterministic scan: high_stakes; surfaces: multi_tenancy, connectors, oauth/secrets, pii, schema_proto)*

---

## Raw text (from the Stakeholder)

> Build the **connector lifecycle + real-data regression suite** — the test coverage whose absence produced EIGHT live fixes on `fix/dev-token-reach`. The connector-marketplace and connector-backfill slices were verified with single-connect fixtures and never exercised the connect→disconnect→reconnect lifecycle, real Shopify pagination, or the worker's RLS/secret edges. This requirement closes that gap so those classes of bug can't silently regress. It also subsumes two tracked debts (SEC-DTR-L1 NIL-uuid negative control; the lifecycle/pagination regression debt).
>
> DELIVER (tests + the minimal test-harness they need — NOT product behavior changes):
> 1. **Connect→disconnect→reconnect lifecycle (Playwright e2e + the supporting API/DB assertions):** connect Shopify → tile shows Connected/Healthy → disconnect → tile returns to **"Connect"** (NOT a failing tile), connector_instance.status=disconnected, sync clean → **reconnect** → no `23505`, the `connector_instance` row is REACTIVATED (UPSERT, same id), exactly **one** `connector_sync_status` row (no duplicate, no stale 'error'), the dashboard Connection Status shows **Connected**. Each transition asserted at the UI + the DB.
> 2. **OAuth callback contract:** the callback **302-redirects** to `/settings/connectors?connected=<type>` (success) or `?connect_error=<code>` (failure) — NEVER raw JSON; the redirect target is the fixed appBaseUrl (no open-redirect); no token/PII in the redirect URL; HMAC-first + state-nonce still reject a forged callback.
> 3. **Real Shopify pagination walk (integration test with a mock/stub Shopify Admin API):** a stubbed store with **>500 orders** (e.g. 600–10,000) → the backfill `shopify-paged-client` walks ALL pages via `since_id` starting at 0 (the bug was stalling at 499) → asserts the full count emitted, the cursor advances monotonically, and a re-run dedups (event_id). No real network — a fixture/mock Admin API.
> 4. **Worker RLS/GUC negative controls (under `SET ROLE brain_app`):** the backfill worker's `loadConnectorInstance` succeeds with a stale empty-string user/workspace GUC (the NIL-uuid fix) AND a non-inert negative control proving brand A's connector/brand rows are NOT visible to brand B under `brain_app` (count=0; asserts `current_user='brain_app'`, `is_superuser=false`). Covers SEC-DTR-L1.
> 5. **Sync-status + currency edges:** reconnect resets `connector_sync_status` to a clean state (no stale 'error'); a completed backfill flips it to `connected`; a brand-currency vs order-currency mismatch is surfaced/rejected by the ledger trigger (the AED-vs-INR class) — a test asserting the trigger fires (and the intended resolution path).
> 6. **dev_secret cross-process round-trip (integration):** core's `LocalSecretsManager` writes a token to `dev_secret` → the worker's `WorkerLocalSecretsManager` reads it back (same token) → disconnect deletes it; prod-hard-fail asserted (both managers throw under NODE_ENV=production).

---

## Problem statement

Every one of the 8 fixes on `fix/dev-token-reach` (disconnected-tile-as-failing, reconnect-23505, callback-JSON, duplicate sync-status, worker brand-GUC crash, provisional-hidden, pagination-stall-at-499, sync-status-stuck-waiting) was a real defect that shipped because the connector slices were verified with single-connect fixtures — never the lifecycle, never real pagination, never the worker's RLS/secret edges under `brain_app`. There is currently no automated guard against any of these regressing. This suite is that guard.

## Target user

Internal/platform (the regression safety net for the connector connect/backfill path). India DTC brand, M1.

## Success metric

A CI-runnable suite that FAILS if any of the 8 fixed defect classes regress: the lifecycle e2e (connect→disconnect→reconnect, clean tile + single sync row + dashboard connected), the callback 302 contract, the >500-order pagination walk, the worker GUC + cross-brand negative control under `brain_app`, the sync-status/currency edges, and the dev_secret round-trip + prod-hard-fail. All green on the current `master`; each would go RED if its corresponding fix were reverted (non-inert).

## Constraints

- **Tests + minimal harness only** — NO product behavior changes. If a test reveals a NEW bug, surface it (bounce) rather than silently changing product code.
- **No real network** — the Shopify pagination test uses a mock/stub Admin API (a local fixture server or an injected client), never the live store. (The real Boddactive validation already happened manually.)
- Isolation tests run under `SET ROLE brain_app` (NOSUPERUSER NOBYPASSRLS) — the dev superuser masks RLS; every isolation/negative-control asserts `current_user='brain_app'` + `is_superuser=false` (non-inert). Honor the adopted rule `system-job-force-rls-enumeration`.
- Tests seed + clean up their OWN brands — must NOT depend on or mutate the real Boddactive brand `60d543dc-...` (which now holds ~19.5k live ledger rows).
- Hard rule: no NEW deployable. Reuse the existing Playwright + vitest harnesses (apps/web/e2e, apps/core, apps/stream-worker tests). Migrations additive only if a test fixture truly needs one (prefer none).

## Non-goals

- Re-testing already-covered surfaces (the metric-engine parity oracle, the ledger closed-sum, identity merge — those have their own suites).
- Load/perf testing the backfill (a >500-order pagination correctness test, not a 10k throughput benchmark).
- Real Shopify/live-network tests (mock only).
- New product features or behavior changes (this is coverage, not function).
- A full connector-health detector / live-sync test (those slices aren't built).

## Linked prior runs

- fix-dev-token-reach (the 8 fixes this suite guards), feat-connector-marketplace, feat-connector-backfill (the slices with the coverage gap), feat-analytics-api-dashboard (the realized/provisional card the lifecycle touches).

## Notes

- The defect classes to pin (one assertion each, non-inert): disconnected→Connect tile (main.ts marketplace tile), reconnect UPSERT no-23505 (PgConnectorInstanceRepository), single sync row (0025 UNIQUE + PgConnectorSyncStatusRepository UPSERT), callback 302 (main.ts), provisional surfaced (get-revenue-metrics — already has a contract test from the bounce, extend if needed), pagination since_id=0 (shopify-paged-client), sync-status→connected on backfill (run.ts), worker brand-GUC (run.ts loadConnectorInstance), dev_secret round-trip (LocalSecretsManager/worker-secrets).
- **Architect must bind:** the e2e lifecycle structure (Playwright, reuse e2e/marketplace.spec.ts + the onboard helper) + how to drive disconnect/reconnect deterministically without a real Shopify authorize (the OAuth authorize needs a real store — bind whether the e2e stubs the callback / seeds a connector_instance directly, vs an integration test at the API/DB layer for the reconnect-UPSERT + sync-row assertions); the mock Shopify Admin API for the pagination walk (an injected fake client vs a local fixture HTTP server); where the worker GUC negative control lives (apps/stream-worker integration test under brain_app); the dev_secret round-trip test.
- Builder lesson (carried, reinforced — this very gap): tight scopes + COMMIT PER SLICE. Tracks: **@qa-agent/@frontend-web-developer** (the lifecycle e2e + callback contract) ∥ **@backend-developer** (the reconnect/sync-row/dev_secret integration tests) ∥ **@data-engineer** (the pagination-walk mock + the worker GUC negative control + the currency-edge trigger test). Verify under `SET ROLE brain_app`.
- This is the safety net that lets the connector path evolve without re-breaking the lifecycle. After it, the deep-Shopify live connector / Razorpay settlement slices can build on a guarded foundation.
