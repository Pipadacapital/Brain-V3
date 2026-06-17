# Requirement: Connector backfill — pull Shopify order history → Bronze → real GMV on the dashboard

| Field | Value |
|-------|-------|
| **req_id** | `feat-connector-backfill` |
| **Title** | Connector backfill — paged Shopify order-history pull, two-lane isolated, honest progress → real realized revenue on screen |
| **Submitted by** | rishabhporwal |
| **Submitted at** | 2026-06-17T07:31:59Z |
| **Tier impact** | Connector-ingestion epic §2 (Backfill) — the slice that puts the FIRST real third-party data through the M1 spine |
| **Region impact** | India (COD recognition horizon already in the ledger; single-currency-per-brand) |

---

## Lane *(advisor to confirm — deterministic scan: high_stakes; surfaces: connectors, multi_tenancy, money, pii, schema_proto, outbound_channel)*

---

## Raw text (from the Stakeholder)

> Build the **connector backfill** — epic §2. Now that a brand can CONNECT a source (`feat-connector-marketplace`, shipped; Boddactive is live-connected), pull its **order history** through the EXISTING data-plane spine so the realized-revenue dashboard finally shows a REAL number instead of the honest empty state. Wire the EXISTING scaffolds: the `POST /api/v1/connectors/:id/backfill` 501 stub (main.ts:716, owner/brand_admin-gated), the empty `apps/core/src/modules/connector/sync/` dir, `connector_cursor` (0006), the collector accept-before-validate edge + Redpanda + stream-worker + Bronze (`feat-data-plane-ingest-spine`), and the contracts in `packages/contracts/src/events`.
>
> DELIVER:
> 1. **Backfill trigger (real, replacing the 501):** `POST /api/v1/connectors/:id/backfill` (owner/brand_admin ONLY — the gate already exists) returns 202 + a `backfill_job` id and emits a backfill request. Idempotent: a backfill already running for that connector does not start a second (overlap-lock per (connector, brand)).
> 2. **Paged, rate-limit-aware history pull:** a backfill worker pulls the connected Shopify store's **orders** via the Admin API using the stored token (the `secret_ref` → secrets seam), paging through history with a cursor (`since_id`/Link header), targeting **24 months** where the API permits. Respect Shopify rate limits (429 + Retry-After; bucket-aware). **Achieved depth is labeled honestly** — if the API caps at N days, the UI shows "N-day," never disguised as 24-month.
> 3. **Same code path as live, different LANE (the §2/governing principle):** each pulled order is emitted as a Bronze order event in the EXISTING event contract and lands in Bronze via the EXISTING collector→Redpanda→stream-worker path — but on a **separate backfill lane** (a `*.backfill.*` topic + a separate, concurrency-capped consumer group) so a 24-month backfill storm NEVER induces lag on the live/billable path. A recovered-history event looks identical to a never-missed one once in Bronze.
> 4. **Honest progress (the §2 honesty principle):** the brand sees backfill progress — `records_processed / estimated_total`, `%`, `cursor_date` — via `GET /api/v1/connectors/:id/jobs`. **Never zeros, never a fabricated total.** "Collecting your data" while it runs; a clear terminal state (completed / partial-with-reason / failed) when done.
> 5. **Flows through the existing spine to the number:** backfilled orders → Bronze → the existing identity-bridge (brain_id) → the realized-revenue ledger (provisional_recognition; historical orders past the COD/prepaid horizon finalize → realized) → the metric engine → the Analytics API → the dashboard card shows the brand's **real realized GMV** (+ provisional for in-horizon orders), per-currency, never blended. Honest empty state only when genuinely no data.
> 6. **Per-brand isolation + idempotency:** every backfilled event carries `brand_id` (asserted, never inferred); Bronze write is idempotent on `event_id` (no dup on replay/redelivery); cross-brand = 0 under `SET ROLE brain_app`; no raw PII in the graph (salted hashes, existing identity rules); the token is read from the secrets seam, never logged.
> 7. **Automated tests:** a backfill of a fixture/synthetic Shopify order set lands brand-scoped Bronze rows on the backfill lane (not the live topic); idempotent re-run produces no dups; the cursor advances + resumes; progress reports real counts (never 0/fabricated); achieved-depth labeling on a capped source; two-lane isolation (backfill consumer group is separate + capped); the realized number surfaces end-to-end (seeded order → dashboard shows the engine number); isolation negative-control under `brain_app`; the backfill authz gate (owner/admin only; manager 403).

---

## Problem statement

The spine can connect a source and compute/display the reconciling number, but no real third-party data has ever flowed through it — every number to date came from seeded rows. Backfill is the slice that pulls a connected store's **history** through the *same* collector→Bronze→identity→ledger→metric path the live sync will use, so the dashboard shows a brand's real realized revenue. India COD makes history non-trivial (status changes weeks after placement), which is exactly why backfill replays through the horizon-based ledger rather than trusting a point-in-time snapshot. The hard constraint is isolation: a multi-brand 24-month backfill storm must never lag the billable live path — hence the separate backfill lane.

## Target user

Owner / Brand Admin who just connected a store and wants their historical GMV visible. India DTC brand, M1. (Boddactive is the live validation target.)

## Success metric

Triggering backfill on a connected store pulls its order history (24 months where permitted, honestly labeled otherwise) through the existing spine on an isolated backfill lane; progress shows real `records_processed/estimated_total` (never zeros/fabricated); the orders land idempotently in brand-scoped Bronze, resolve identity, recognize through the ledger, and the dashboard card shows the brand's **real realized GMV** (per-currency, provisional shown separately); a re-run produces no duplicates; cross-brand = 0 under `brain_app`; the live path shows no lag during a backfill. Proven by automated tests + (validation) a real Boddactive backfill surfacing a real number.

## Constraints

- **Same code path, different lane (governing principle):** reuse the EXISTING collector edge + stream-worker + Bronze; backfill differs ONLY by topic/consumer-group (a separate, concurrency-capped lane). Do NOT fork a parallel ingest implementation.
- **Honesty (§2):** progress is real (`records_processed/estimated_total/%/cursor_date`), never zeros, never a fabricated total; achieved depth labeled truthfully (a 60-day-cap source shows "60-day," never "24-month").
- **Two-lane isolation:** a backfill storm must not lag the live/billable path — separate `*.backfill.*` topic + capped consumer group; verify the live consumer group is unaffected.
- **Money:** the ledger already owns recognition (minor units + currency_code, horizon-based finalization, dual-date) — backfill FEEDS it, never re-implements a sum; per-currency, never blended.
- Absolute brand/tenant isolation (the ONE invariant); `brand_id` asserted on every event; RLS FORCE; verify under `SET ROLE brain_app` (dev superuser masks RLS). No raw PII in the graph; token from the secrets seam, never logged.
- **Idempotent + replayable (I-ST04):** Bronze insert-if-absent on `event_id`; cursor upsert on `connector_cursor`; a re-run/redelivery never double-counts.
- Hard rule: **no NEW deployable.** The backfill worker runs inside an EXISTING deployable (stream-worker or an in-core/collector-adjacent job — architect to bind), orchestrated as an existing job type — NOT a new service. Migrations additive (I-E02).

## Non-goals

- **Live sync** (webhooks order placed/paid/shipped, polling+cursor advancement, the 35-day re-pull window) — the deep-Shopify *live* connector is a separate slice. This slice is the one-time *history* pull (the same Bronze mapping is shared and reusable).
- **Settlement / net-of-fees / Razorpay** (the realized number from backfill is horizon-finalized GMV; settlement-driven finalization + fees is the Razorpay slice). Marketplace/MDR fees not applied here.
- **Meta / Google Ads / other connectors** — Shopify orders only for this slice (the pattern generalizes via the connector seam later).
- **Full Argo Workflows orchestration** — M1 uses a simpler job runner inside an existing deployable (no new deployable); the Argo/cron production orchestration is a platform follow-up.
- **StarRocks / Silver / Gold dbt** — backfill lands Bronze; the existing Postgres ledger path is the M1 read.
- **The product/customer/inventory backfill** — orders only (the realized-revenue spine); products/customers as needed only to resolve order identity.

## Linked prior runs

- feat-connector-marketplace (the connect + secret_ref + the 501 backfill stub + owner/admin gate this realizes)
- feat-data-plane-ingest-spine (the collector→Redpanda→stream-worker→Bronze path + the lane concept)
- feat-identity-graph (brain_id resolution off Bronze), feat-realized-revenue-ledger (horizon recognition), feat-metric-engine-parity (the engine), feat-analytics-api-dashboard (the card that will show the real number)

## Notes

- **The dev token caveat (must address):** `LocalSecretsManager` holds the dev OAuth token in an **in-memory Map** — a core restart loses it (the code says so). For backfill to pull in dev, either (a) the brand reconnects right before backfill, or (b) make the dev secret store survive a restart (a dev table/file behind the same `ISecretsManager` seam). Architect to bind — backfill that dies on a lost token mid-pull is a bad first experience. (Prod AWS Secrets Manager is durable; this is dev-only.)
- Scaffolds: the 501 stub `apps/core/src/main.ts:716` (`POST /connectors/:id/backfill`, brand_admin+ gate live); `apps/core/src/modules/connector/sync/` (empty); `connector_cursor` (0006: brand_id, connector_instance_id, resource, cursor_value, upsert key — the watermark store); `connector_sync_status` (state machine); the Shopify `ShopifyAdminClient` (`infrastructure/api/`) for the Admin API calls; the collector `collect.route` edge; the stream-worker consumers/pipeline/sinks; the Bronze table; the event contracts `packages/contracts/src/events/m1.events.v1.ts`.
- **Architect must bind:** the backfill job model (a `backfill_job`/progress record vs reusing connector_sync_status — needs records_processed/estimated_total/cursor_date/status); the lane mechanism (the `*.backfill.*` topic name + the capped consumer group, and how the stream-worker tells lanes apart but writes the same Bronze); where the worker runs (no new deployable — stream-worker job vs in-core async vs collector-driven); the Shopify order→Bronze-event mapping (the contract shape + dedup key = event_id derivation, stable so re-runs dedup); the estimated_total source (Shopify order count endpoint) so progress is real not fabricated; the achieved-depth label; the overlap-lock; the dev-secret durability decision; how historical (past-horizon) orders finalize to realized in the ledger.
- Builder lesson (carried, reinforced THIS run — a Stage-8 agent just died on the infra socket timeout): tight scopes + **COMMIT PER SLICE**. Tracks: **@data-engineer** (the backfill worker + lane + Bronze landing + cursor/idempotency — the data plane's) ∥ **@backend-developer** (the trigger→job→progress API + overlap-lock + secrets/token read + authz) ∥ **@frontend-web-developer** (the "collecting your data" progress UX + achieved-depth label + the dashboard finally showing the real number; e2e). Verify isolation under `SET ROLE brain_app`.
- This is the PAYOFF slice: the first real third-party data through the M1 spine → the reconciling number on screen is finally a REAL brand's number.
