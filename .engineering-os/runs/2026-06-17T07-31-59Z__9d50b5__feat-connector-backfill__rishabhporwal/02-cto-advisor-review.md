# 02 — Engineering Advisor (CTO) Intake Review
## feat-connector-backfill

| Field | Value |
|-------|-------|
| **req_id** | `feat-connector-backfill` |
| **Stage** | 1 — Intake |
| **Lane** | **high_stakes** — CONFIRMED |
| **Surfaces confirmed** | `auth`, `connectors`, `metric_engine`, `money`, `multi_tenancy`, `pii`, `schema_proto`, `outbound_channel` |
| **Surfaces added** | none (scan was complete; `schema_proto` covers the new Bronze-event mapping + `backfill_job` table shape; `outbound_channel` covers the job-status GET endpoint) |
| **Decision** | **ADVANCE** |
| **Reviewed at** | 2026-06-17T10:45:00Z |

---

## Lane Confirmation

High-stakes confirmed. The deterministic scan surface list is accurate and complete. This is the first real third-party data through the spine: auth (owner/brand_admin-only gate), connectors (Shopify Admin API pull, secrets seam), money (GMV recognition in the realized-revenue ledger, minor-units, no fees), multi_tenancy (brand_id asserted on every backfill event, RLS FORCE), pii (real customer data from Shopify orders — email/phone must hash into identity_link, never raw in graph or logs), schema_proto (new `order.backfill.v1` event shape + new `backfill_job` progress record), outbound_channel (the new GET /connectors/:id/jobs endpoint plus the in-flight "collecting your data" progress state surfaced to the dashboard).

No surface was removed from the scan. One latent surface worth flagging: the `connector_sync_status` state machine is reused or extended — it already has `syncing` — but the requirement calls for a separate `backfill_job` progress record. The Architect must bind whether `connector_sync_status` is repurposed or a new `backfill_job` table is added (I lean toward new: the two differ in schema requirements — `records_processed`, `estimated_total`, `cursor_date`, `achieved_depth_label` have no home in the current state machine).

---

## Dependency Pre-flight

All declared blockers are shipped:
- `feat-connector-marketplace` — shipped (connector_instance, secret_ref, brand_admin+ gate on the 501 stub, LocalSecretsManager/AwsSecretsManager seam, ShopifyAdminClient)
- `feat-data-plane-ingest-spine` — shipped (collector, Redpanda, stream-worker, Bronze, Redis dedup)
- `feat-identity-graph` — shipped (brain_id resolution, identity_link, salted hashes)
- `feat-realized-revenue-ledger` — shipped (provisional_recognition, finalization, horizon logic, revenue-finalization job)
- `feat-metric-engine-parity` — shipped (realized_revenue metric, parity oracle)
- `feat-analytics-api-dashboard` — shipped (the card that will show the real number)

Dependency pre-flight: GREEN. No blocked-on-dependency stop needed.

---

## Make it Less Dumb First

1. **The collector is not the right post box for backfill.** The existing `POST /collect` route is the accept-before-validate path for live/pixel events from external producers. Routing backfill events through the collector's HTTP endpoint adds a round-trip spool + drainer cycle for data the worker already owns. The correct pattern: the backfill worker emits directly to Redpanda on the `*.backfill.*` topic (bypassing the HTTP spool entirely). The collector is not a gateway obligation — it is the external-event durability boundary. Internal workers should use the Kafka producer directly. This is simpler and avoids the collector's spool table bloating with synthetic events. The Architect must bind this explicitly.

2. **estimated_total must come from `countOrders()` before pagination begins, not fabricated.** The ShopifyAdminClient already has `countOrders()` (status=any). This is the one legitimate call to make before starting the page loop, so the progress bar is real from the first page. Do not defer this to "later" — it is the honesty invariant. One count call per backfill is cheap.

3. **Do not re-implement the finalization job.** The `revenue-finalization` job in stream-worker already finalizes `provisional_recognition` rows past their horizon. Backfilled orders (occurred_at in the past) will have their finalization handled by the existing cron job — no special case needed. The architect must verify that `occurred_at` (the Shopify order's `processed_at`) is the field written as `occurred_at` in the ledger row, because the finalization query uses `l.occurred_at + horizon_days < NOW()`. If the backfilled order's `occurred_at` is 18 months ago, the cron fires on its next scheduled run and finalizes it. No custom backfill finalization logic needed. Scope this out explicitly.

4. **No GraphQL bulk operations for M1.** The Shopify GraphQL Bulk Operations API exists and is the right tool for a production 24-month pull. For M1 / Boddactive at expected order volume (thousands, not millions), REST `since_id` + Link-header pagination is sufficient and simpler to implement, test, and resume. Defer GraphQL bulk to Phase 2 scale. Bind this as a scope cut.

5. **One new migration, additive only.** The `backfill_job` table is new. `connector_cursor` already exists (the watermark). `connector_sync_status` has no `records_processed`/`estimated_total`/`achieved_depth_label` columns and should not be extended (different semantic contract). The Architect adds one new migration for `backfill_job`. RLS FORCE + NN-1 two-arg + brain_app grants required.

---

## Domain Check Against Product Canon

The requirement is well-aligned. Specific Canon checks:

- **Money:** `amount_minor BIGINT` + `currency_code CHAR(3)` required on every order event. The ShopifyAdminClient returns `current_total_price` as a decimal string (Shopify does not use minor units). The event mapping must convert to minor units at the worker boundary, never pass a decimal string through to Bronze or the ledger. This is an I-S07 hard rule.
- **Identity:** `customer` field in Shopify order response must be hashed (phone/email via `sha256(brand-salt || normalized-value)`) before it enters the graph. The raw customer object must never appear in the event payload, a log line, or the Bronze row's `payload` JSONB. I-S02.
- **Ledger finalization:** Confirmed the `revenue-finalization` job's query is `occurred_at + horizon_days < NOW()`. Historical orders with `occurred_at` well in the past satisfy this condition on the very next cron run. No special-case code needed.
- **DPDP posture:** Pulling real customer data from a connected Shopify store — customer name, email, phone, address — is data processing under DPDP. Brain is a data processor; the brand-controller holds the lawful basis. The processing here is for analytics measurement, which is within the declared purpose-limitation (COMPLIANCE.md §1). No DPDP escalation is required for M1 provided: (a) no raw PII enters Bronze or logs; (b) the hash path is validated as it is for all other identity data. Compliance posture is clear — no ambiguity requiring Stakeholder escalation.
- **Audit trail:** `connector.sync_started` event must be emitted when the backfill begins (the contract already exists in m1.events.v1.ts). The audit log must record the trigger (brand_admin invoking backfill, including the `connector_instance_id` and actor). I-S06.
- **The Moat:** Backfill is a direct strengthener of the moat — it populates the realized-revenue ledger with real historical data from the brand's actual COD/prepaid order mix. This directly deepens attribution history and the Decision Log substrate. The requirement is sound from a moat perspective. No weakening of measurement honesty detected.

---

## Persona Stress-Test (inhabited — high-stakes compressed lane)

### Persona 1 — Integration Realist

**Concern IR-1 (HIGH): The "24 months" target is real for Shopify REST orders.** Shopify's REST Orders API does not cap history by time — a brand can retrieve all orders since store creation. The `since_id` cursor with the Link header is the correct pagination mechanism (NOT `created_at_min`/`created_at_max` for primary iteration, because since_id is more stable). However: Shopify's `orders/count.json?status=any` endpoint does NOT accept date filters easily — the count is total orders, not date-range orders. If we fetch `estimated_total` as the raw count and then only pull 24 months of history, the progress percentage will be wrong (denominator = all-time, numerator = 24 months). The Architect must bound: either (a) estimated_total = total order count and achieved depth = date of oldest retrieved order, label honestly; or (b) use `created_at_min` for the count call too (GET /orders/count.json?status=any&created_at_min=2Y-ago) so numerator and denominator match. Option (b) is more honest.

**Concern IR-2 (HIGH): Rate-limit model — the leaky-bucket is per-endpoint-type.** Shopify Admin REST uses a "leaky bucket" algorithm: each request costs points, the bucket drains at 2 points/second, max 80 points. A `GET /orders.json` with limit=250 costs 1 point. At 2 req/s sustained, a 10K-order store would take ~80 seconds of API time (10000/250 = 40 pages; well within rate). But the current `ShopifyAdminClient.getOrders(limit=50)` is under-batched — `limit=250` is the max and should be the default for backfill. The worker must also respect `Retry-After` headers on 429s and implement exponential backoff. The current `get<T>()` method throws on non-OK but does not extract or honor `Retry-After`. This is a gap the worker implementation must fill.

**Concern IR-3 (MEDIUM): `event_id` derivation for dedup stability.** The existing Bronze pipeline uses `event_id` as the Redis dedup key and the Postgres PK backstop. For backfill events derived from Shopify orders, the `event_id` must be deterministic and stable across re-runs: `sha256(brand_id || shopify_order_id || 'order.backfill.v1')` (hex). Using a `randomUUID()` at emit time is prohibited — a re-run would double-insert. The Architect must bind this derivation formula explicitly (it belongs in the worker, not in the event contract itself, but must be documented as D-N).

**Concern IR-4 (LOW): Shopify `processed_at` vs `created_at` for `occurred_at`.** For COD-heavy India DTC, `processed_at` (when the order was confirmed as placed, often equal to `created_at`) is the right anchor for the ledger's `occurred_at`. The `updated_at` field changes with fulfillment status — using it as `occurred_at` would cause incorrect horizon calculations. The Architect must bind `processed_at ?? created_at` as the `occurred_at` source.

**Disposition:** IR-1 and IR-2 are binding architect decisions. IR-3 is a binding architect decision (it is the dedup invariant). IR-4 is a binding note.

---

### Persona 2 — Scale / Isolation Skeptic

**Concern SI-1 (HIGH): Does the stream-worker actually support a second topic + capped consumer group without a new deployable?**

Reading `apps/stream-worker/src/main.ts` directly: the worker starts two consumers — `CollectorEventConsumer` (topic=`dev.collector.event.v1`, group=`stream-worker-live`) and `IdentityBridgeConsumer` (same topic, group=`identity-bridge-live`). Both are instantiated in the same `main()` function. Adding a third consumer — `BackfillOrderConsumer` (topic=`dev.collector.order.backfill.v1`, group=`stream-worker-backfill`) — follows the same pattern with no new deployable. The concurrency cap is implemented by setting `Kafka` consumer's `maxBytesPerPartition` / `sessionTimeout` and Redpanda's topic partition count. A single-partition backfill topic with a consumer group of 1 naturally caps throughput without a configuration layer. This is implementable.

**Concern SI-2 (HIGH): The backfill worker itself — where does it run?**

The requirement's hard rule is "no new deployable." Options:
- **In-core async job** (running inside the Fastify process): a bad choice — a 24-month pull that takes minutes to hours must not run inside a web server's event loop. A crash loses state. A SIGTERM mid-pull loses the cursor (unless checkpointed). Not recommended.
- **stream-worker job** (a new `src/jobs/shopify-backfill.ts` invoked via `node dist/jobs/shopify-backfill.js`): follows the exact same pattern as `revenue-finalization.ts` which is already a standalone invocable job inside the stream-worker deployable. This is the correct answer. The stream-worker process is already the right home for data pipeline jobs; the existing pattern is established and consistent with I-E05.
- **collector-driven**: would require the collector to know about connector credentials and Shopify API calls — a wrong-layer coupling.

**Binding: backfill worker = `apps/stream-worker/src/jobs/shopify-backfill.ts`, invoked via the POST /connectors/:id/backfill trigger in core (which spawns a child process or queues a job).**

But there is a sub-concern: the trigger in core (main.ts) must kick off the job without holding the HTTP connection open. The simplest M1 pattern: trigger writes a `backfill_job` row with status=`queued`, returns 202, and the stream-worker's job scheduler picks it up (poll or listen). This avoids `spawn()` from the web process across a deployable boundary. The Architect must bind the trigger-to-worker handoff mechanism.

**Concern SI-3 (MEDIUM): Live-path lag during backfill storm.** If the backfill topic is `dev.collector.order.backfill.v1` (separate from `dev.collector.event.v1`), and the backfill consumer group is distinct (`stream-worker-backfill`), then by definition Redpanda partitioning prevents the backfill consumer from blocking the live consumer. The key invariant: the backfill topic MUST be a separate named topic, NOT a separate consumer group on the same topic. A separate consumer group on the same topic would still cause the producer to wait for all groups to catch up on retention policies. The two-topic model is the correct isolation guarantee. This must be explicitly tested (backfill consumer group should not appear in the offset lag metric for the live topic).

**Disposition:** SI-1 is resolved — in-process pattern works. SI-2 is a binding architect decision (stream-worker job). SI-3 is a binding architect decision (separate topic, not same-topic different group).

---

### Persona 3 — Money / Correctness Skeptic

**Concern MC-1 (HIGH): Do historical orders finalize through the existing ledger?**

Reading `revenue-finalization.ts` line by line: the query is `WHERE l.event_type = 'provisional_recognition' AND l.occurred_at + ($2 || ' days')::interval < NOW()`. If a backfilled order has `occurred_at = '2024-06-15'` (18 months ago) and the brand's `cod_recognition_horizon_days = 25`, then `2024-06-15 + 25 days < NOW()` is true on the next job run. The job will finalize it. This is correct and no special-case code is needed.

**Critical caveat:** the `backfill_job` landing path must write `occurred_at = shopify_order.processed_at` to the ledger row (not `NOW()`). If `occurred_at` is set to the current ingest time, the horizon calculation will not fire for 25 days — every backfilled order will sit provisional for a full horizon window. This is a correctness bug that would make the dashboard show provisional GMV for weeks after a successful backfill. The Architect must bind: **`occurred_at` in the ledger row = the Shopify order's `processed_at` timestamp**.

**Concern MC-2 (HIGH): Gross-of-fees labeling is mandatory.**

The realized GMV computed from backfilled orders is revenue-from-Shopify, which is gross of Razorpay settlement fees (the brand's actual net-of-fees is the Razorpay slice). This must be labeled on the dashboard. The Analytics API and metric engine already surfaced the `realized_revenue` metric, which is defined as GMV recognized by the ledger — and the current ledger carries no fee data. The dashboard card showing "Realized GMV" from backfill is accurate as-labeled IF and ONLY IF it is explicitly called "Gross GMV" or "Gross Revenue" (not "Net Revenue" or "Realized Net"), and a callout explains "Settlement fees not yet applied." Showing a gross number without labeling it as gross is an honesty violation (it would overstate what the brand actually banked). This label requirement must be in the acceptance criteria.

**Concern MC-3 (MEDIUM): `amount_minor` conversion from Shopify decimal strings.**

Shopify returns `"current_total_price": "1250.00"` (a decimal string in the store's currency). The worker must parse this correctly: `Math.round(parseFloat("1250.00") * 100)` is adequate for INR (paisa), but `parseFloat` on long decimal strings can introduce floating-point error at large amounts. The correct approach: parse the decimal string by splitting on `.`, asserting at most 2 decimal places, and computing `major * 100 + minor` with integer arithmetic. This is an I-S07 requirement. The Architect must specify the conversion function explicitly.

**Disposition:** MC-1 is a binding architect decision (occurred_at source). MC-2 is an acceptance criterion (honest label on the dashboard). MC-3 is a binding implementation note (integer-arithmetic conversion, not parseFloat).

---

### Persona 4 — Security / PII Skeptic

**Concern SP-1 (HIGH): Dev in-memory token lost on restart — bad first experience.**

`LocalSecretsManager` is an in-memory `Map`. A core process restart (which is routine in dev when the engineer changes code, runs `npm run dev` with hot-reload, or the process crashes) loses the token. On the next backfill trigger, `getSecret(secretArn)` returns `null`, the worker can't authenticate to Shopify, and the backfill fails mid-pull with an opaque auth error.

**Decision bind (see D-7):** The requirement explicitly asks the architect to bind this. The two options are:
- **(a) Reconnect-before-backfill protocol:** The POST /connectors/:id/backfill endpoint checks whether `getSecret(connector.secret_ref)` returns a non-null value BEFORE accepting the request. If null, return 409 with a `{"error": "RECONNECT_REQUIRED"}` and the UI surfaces "Please reconnect your Shopify store before backfilling." This is zero-infra, honest, and fast to implement.
- **(b) Durable dev secret store:** Persist the dev token to a `dev_secrets` table (or a local `.dev-secrets.json` behind the `ISecretsManager` seam) so it survives restarts.

**Recommendation: Option (a).** Option (b) requires a new table (or file-system coupling) and is a distraction from the main slice. Option (a) is honest, doesn't surprise the engineer, and is already testable with the existing seam (check `getSecret()` returns non-null before proceeding). The production path (AwsSecretsManager) is durable by design and has no restart problem. This is a dev-only concern; do not over-engineer it.

**Concern SP-2 (HIGH): Shopify order payload carries raw PII — `customer.email`, `customer.phone`, `billing_address`, `shipping_address`.**

The `ShopifyAdminClient.getOrders()` currently fetches the `customer` field (visible in the `fields` list). The backfill worker must strip all raw PII fields from the Shopify order response BEFORE emitting the event. The event payload must contain:
- `shopify_order_id` (numeric — not PII)
- `hashed_customer_phone = sha256(brand_salt || normalize(customer.phone))` if present
- `hashed_customer_email = sha256(brand_salt || normalize(customer.email))` if present
- Financial fields (amount_minor, currency_code, financial_status, etc.)
- NO raw email, phone, name, address fields

The `customer` field must be consumed for identity resolution only and then discarded at the worker boundary. This is I-S02. The Architect must specify the mapping explicitly, and the no-PII schema-lint CI gate must cover the new event schema.

**Concern SP-3 (MEDIUM): Token lifecycle during multi-page pull.**

If the Shopify OAuth token is revoked or expired mid-backfill (rare but possible if the brand disconnects during a long pull), the worker will receive a 401 from Shopify. The worker must handle 401 by: marking the `backfill_job` as `failed` with `reason: "SHOPIFY_AUTH_ERROR"`, persisting the `cursor_value` checkpoint, and NOT retrying with the same token (retrying a revoked token just burns rate-limit). The brand must reconnect before resuming. The cursor is preserved so the next backfill trigger can resume from the checkpoint.

**Concern SP-4 (LOW): DPDP purpose-limitation check.**

Pulling real customer data from Shopify orders is covered by the brand's analytics purpose-limitation declaration (COMPLIANCE.md §1). No new consent surface is required for backfill — the brand consented to analytics processing when they connected the store. The DPA covers Brain as a processor. Compliant for M1. No escalation needed.

**Disposition:** SP-1 is resolved by D-7 (reconnect-before-backfill protocol, option a). SP-2 is a binding architect decision (PII strip at worker boundary, event mapping spec). SP-3 is a binding architect decision (401 handling + cursor checkpoint). SP-4 is clear — no escalation.

---

### Persona 5 — Honesty / Product Skeptic

**Concern HP-1 (HIGH): Progress bar honesty depends on the count call timing.**

`estimated_total` must be fetched from `countOrders()` before the first page is pulled. If the count call fails (unlikely but possible — Shopify returns count separately and the endpoint can timeout), the backfill should not proceed with `estimated_total = 0` (which would make progress show as `0/0` or `Infinity%`). The fallback: if the count call fails, mark `estimated_total = null` and the UI shows "Collecting your data..." without a percentage — still honest. Never substitute a fabricated number.

**Concern HP-2 (HIGH): Overlap-lock must be in the database, not in-process.**

The overlap-lock (one backfill per connector at a time) must be enforced by a database-level constraint, not an in-process check. A `UNIQUE` index or `status='running'` check in the `backfill_job` table with `SELECT ... FOR UPDATE SKIP LOCKED` is the correct implementation. An in-process check has a race condition (two simultaneous HTTP requests, both read "no running job," both start). The Architect must bind the overlap-lock mechanism.

**Concern HP-3 (MEDIUM): Achieved-depth label for Shopify.**

Shopify has no hard time-cap on the REST Orders API. "Achieved depth" for backfill is determined by: `cursor_date = oldest_order_processed_at` retrieved. If the brand's store is 3 years old, the worker pulls 24 months back and stops at `created_at_min = now() - 24mo`. The UI label is "24 months" (honest). If the brand's store was created 8 months ago, all orders are pulled; the label is "since store creation (8 months)." The worker must compute and write `achieved_depth_label` to the `backfill_job` row at completion, not guess it upfront.

**Concern HP-4 (LOW): Terminal state must be explicit — not "still running."**

A backfill that finishes with all pages processed must write `status = 'completed'`. One that exhausts all Retry-After retries or hits a hard error on a page must write `status = 'failed'` with a `failure_reason`. A partial pull (stopped at a cursor, recoverable) must write `status = 'partial'` with `cursor_value` saved. The UI must show these distinct states. "Collecting your data" forever is a product honesty failure.

**Disposition:** HP-1 is a binding architect decision (count-before-first-page, null-fallback for display). HP-2 is a binding architect decision (DB-level overlap lock). HP-3 and HP-4 are binding acceptance criteria.

---

### Persona 6 — Multi-tenancy Skeptic

**Concern MT-1 (HIGH): brand_id assertion on every emitted event.**

The backfill worker emits events on behalf of a specific brand (the one whose connector was triggered). The `brand_id` must be taken from the `connector_instance.brand_id` at job start and asserted on every emitted Bronze event. It must NEVER be taken from the Shopify API response (Shopify has no concept of Brain's brand_id) or from a worker-level environment variable. The binding: `brand_id = connector_instance.brand_id` fetched under `SET ROLE brain_app + set_config GUC` at job start.

**Concern MT-2 (HIGH): Dev superuser masks RLS — isolation tests must use brain_app.**

As documented in MEMORY.md: the dev DB connects as superuser `brain`; RLS is only truly enforced under `brain_app`. Every isolation test for this slice — cross-brand Bronze query, backfill_job query, connector_cursor query — must execute under `SET ROLE brain_app` with the GUC set. The superuser path is a false-pass trap that has already caused two prior bounces in this pipeline. The QA agent must enforce this.

**Concern MT-3 (MEDIUM): Bronze idempotency on event_id is the per-brand dedup.**

The existing Bronze pipeline uses `(brand_id, event_id)` as the dedup key (Redis NX + PG PK). The backfill event_id = `sha256(brand_id || shopify_order_id || schema_name)`. This is per-brand scoped (brand_id is in the hash input), so even if two brands both have a Shopify order with the same numeric ID (impossible in practice, since Shopify order IDs are global, but defensive programming requires it), the event_id will differ. The invariant holds.

**Concern MT-4 (LOW): `connector_cursor` upsert under RLS.**

The `connector_cursor` table has FORCE RLS under `brain_app`. The backfill job must write the cursor (upsert on `(brand_id, connector_instance_id, resource)`) within a `set_config('app.current_brand_id', brand_id, true)` transaction. The job runs as brain_app (same as the finalization job). This is consistent with the established pattern.

**Disposition:** MT-1 is a binding architect decision (brand_id source). MT-2 is a QA directive. MT-3 and MT-4 are binding implementation notes.

---

## Scope Boundary (Guard — hard line)

**IN SCOPE (this slice):**
- The one-time history pull via Shopify Admin REST (since_id + Link header pagination)
- Two-lane isolation: `*.backfill.*` topic + `stream-worker-backfill` consumer group (separate, capped)
- Bronze landing via the existing stream-worker pipeline (backfill order → Bronze, same schema as live)
- Honest progress: `backfill_job` table with `records_processed / estimated_total / cursor_date / achieved_depth_label / status`
- Overlap-lock (one backfill per connector)
- Token health check before trigger (reconnect-if-null for dev)
- Identity resolution for backfilled orders (hashed phone/email → identity_link via existing bridge)
- Ledger feeding: provisional_recognition from backfilled orders flows to the existing finalization job
- Dashboard shows real realized GMV (the metric engine reads the ledger; no new computation)
- PII strip at the worker boundary: no raw customer data in events or Bronze
- Authz gate: owner/brand_admin only (existing gate on the 501 stub, now realized)
- Automated tests (all listed in the requirement)

**NOT IN SCOPE (hard boundary — do not scope-creep):**
- Live sync / webhooks / polling + cursor advancement (the 35-day re-pull window) — separate slice
- Settlement / Razorpay fees / net-of-fees recognition — Razorpay slice
- Meta / Google Ads / other connectors — Shopify orders only
- Full Argo Workflows orchestration — M1 uses stream-worker job pattern
- StarRocks / Silver / Gold dbt — backfill lands Bronze; Postgres ledger is the M1 read path
- Product / customer / inventory backfill — orders only (realized-revenue spine)
- A new deployable of any kind

---

## Numbered Binding Decisions (D-1..D-15)

The Architect MUST honor all of the following. No decision may be silently deviated from; a deviation requires a Challenge-Back to this review.

**D-1: Backfill worker placement = `apps/stream-worker/src/jobs/shopify-backfill.ts`**
Follows the `revenue-finalization.ts` pattern. Invoked as a standalone Node.js job (`node dist/jobs/shopify-backfill.js`). No new deployable. The stream-worker package is the sanctioned home for data-pipeline jobs (I-E05).

**D-2: Trigger-to-worker handoff = `backfill_job` table + poll-or-listen**
`POST /connectors/:id/backfill` (core) writes a `backfill_job` row with `status='queued'` and returns 202. The stream-worker job is invoked on a schedule (or triggered via a pg NOTIFY / simple poll) to pick up `status='queued'` rows. No `spawn()` from the web process into the job process. The handoff is database-mediated.

**D-3: Two-lane isolation = separate Redpanda topic, not same-topic different group**
Backfill events land on `{env}.collector.order.backfill.v1` (NOT `dev.collector.event.v1`). The backfill consumer group is `stream-worker-backfill`. The live consumer group (`stream-worker-live`) is never in the same consumer group as the backfill consumer. The topic partition count for the backfill topic is 1 (single partition = natural throughput cap). Verify in tests that live consumer group offset lag is unaffected by a backfill event storm.

**D-4: Backfill events are emitted directly to Redpanda by the worker (NOT via the collector HTTP endpoint)**
The backfill worker uses the Kafka producer directly (same pattern as the drainer in the collector). The collector HTTP endpoint (`POST /collect`) is the external-event accept-before-spool path; internal workers bypass it. This avoids spool table bloat with synthetic events and removes a round-trip.

**D-5: Stable event_id derivation = `sha256(brand_id || ':' || shopify_order_id || ':' || 'order.backfill.v1')`**
Deterministic across re-runs. Not a random UUID. `shopify_order_id` is the numeric Shopify order ID (always globally unique). The `brand_id` prefix ensures per-brand scoping. Output as lowercase hex. This is the Redis dedup key and the Bronze PK. A re-run of the backfill on the same connector must produce identical event_ids — the dedup layer (Redis NX + PG ON CONFLICT DO NOTHING) guarantees no double-insert.

**D-6: occurred_at in the ledger row = Shopify order `processed_at` (fallback: `created_at`)**
NOT `NOW()` at ingest time. This is the field the `revenue-finalization` job uses for the horizon calculation. If `processed_at` is null (uncommon), fall back to `created_at`. Document this in the event schema comment.

**D-7: Dev secret durability = reconnect-before-backfill protocol (option a)**
Before accepting a backfill trigger, `POST /connectors/:id/backfill` calls `secretsManager.getSecret(connector.secret_ref)`. If null, return 409 with `{"error": {"code": "RECONNECT_REQUIRED", "message": "Your Shopify connection has expired. Please reconnect the store before backfilling."}}`. The UI must surface this message. No new infra required. Prod (AwsSecretsManager) is durable; this check is a no-op in prod.

**D-8: estimated_total = `countOrders(status=any, created_at_min=2Y-ago)` before first page pull**
The count call uses the same date filter as the backfill traversal so numerator and denominator match. If the count call fails, set `estimated_total = null` and surface "Collecting your data..." without a percentage. Never substitute a fabricated number (honesty invariant, §2).

**D-9: Overlap-lock = database-level, using `backfill_job` `status='running'` + SELECT FOR UPDATE**
Before inserting a new `backfill_job` row, the trigger checks `SELECT id FROM backfill_job WHERE connector_instance_id = $1 AND status IN ('queued','running') FOR UPDATE SKIP LOCKED`. If a row is found, return 409 `{"error": {"code": "BACKFILL_ALREADY_RUNNING"}}`. The lock is at the DB level, not in-process.

**D-10: PII strip at the worker boundary — no raw customer data in events or Bronze**
The backfill worker consumes `customer.email` and `customer.phone` from the Shopify order response for identity hashing only. The event payload must contain `hashed_customer_phone` and `hashed_customer_email` (per existing identity_link conventions), never the raw strings. All other PII fields (`billing_address`, `shipping_address`, `customer.name`) are dropped at the mapping layer. The new event schema must pass the `no-pii-schema-lint` CI gate.

**D-11: GMV label on the dashboard = "Gross Revenue (ex-fees)" or equivalent honest label**
The dashboard card showing realized GMV from backfill must be labeled to indicate it is gross of settlement fees. A tooltip or sub-label stating "Settlement fees not yet applied" is required. This label stays until the Razorpay settlement slice ships and net revenue is computable. A gross number labeled as "Net Revenue" is a product honesty violation.

**D-12: backfill_job migration = one new additive migration (not an extension of connector_sync_status)**
The `backfill_job` table needs: `id UUID PK`, `brand_id UUID FK`, `connector_instance_id UUID FK`, `status TEXT CHECK (IN ('queued','running','completed','partial','failed'))`, `records_processed BIGINT DEFAULT 0`, `estimated_total BIGINT NULL`, `cursor_value TEXT NULL`, `achieved_depth_label TEXT NULL`, `failure_reason TEXT NULL`, `started_at TIMESTAMPTZ NULL`, `completed_at TIMESTAMPTZ NULL`, `created_at TIMESTAMPTZ DEFAULT NOW()`. RLS FORCE on `brand_id`. NN-1 two-arg policy. `brain_app` SELECT+INSERT+UPDATE. No DELETE grant.

**D-13: amount_minor conversion = integer arithmetic, not parseFloat**
Convert Shopify's decimal-string price to minor units by: split on `.`, assert at most 2 decimal places, compute `BigInt(wholePart) * 100n + BigInt(fractionalPart.padEnd(2, '0'))`. Do NOT use `Math.round(parseFloat(str) * 100)`. I-S07.

**D-14: Shopify pagination = REST since_id + Link header, limit=250, date-bounded by created_at_min**
Use `GET /orders.json?status=any&limit=250&created_at_min=<2Y-ago>&since_id=<cursor>`. Page until the Link header contains no `rel="next"` or until all pages within the date window are exhausted. Write `cursor_value = last_seen_since_id` to `connector_cursor` after every page (not just at completion). A mid-run crash is recoverable: restart from the saved cursor. Backoff: on 429, extract `Retry-After` header (integer seconds), sleep that duration before retrying.

**D-15: Authz gate = owner/brand_admin only — existing gate honored; manager returns 403**
The existing `requireRole('brand_admin')` hook on the 501 stub already implements this. The realized implementation inherits the same hook. The acceptance test must verify manager → 403 (a negative control that must be non-inert).

---

## Success Criteria (reviewers will check)

The following must all be demonstrably true at QA review:

1. `POST /connectors/:id/backfill` (brand_admin+) returns 202 with a `backfill_job_id`; manager returns 403 (non-inert negative control)
2. A second trigger while one is running returns 409 `BACKFILL_ALREADY_RUNNING`
3. A trigger on a connector with a lost dev token returns 409 `RECONNECT_REQUIRED`
4. Backfill worker pulls Shopify orders in pages of 250, writes cursor after every page, handles 429 + Retry-After
5. Each pulled order becomes a Bronze event on `{env}.collector.order.backfill.v1` (not the live topic); event_id is deterministic; a re-run produces zero new Bronze rows (dedup)
6. `GET /connectors/:id/jobs` returns real `records_processed`, `estimated_total` (non-null, non-fabricated), `cursor_date`, and a percent
7. `achieved_depth_label` is written at completion and reflects the actual oldest order date pulled (not a hardcoded "24 months")
8. Terminal states are explicit: `completed`, `partial`, or `failed` with `failure_reason`
9. No raw PII (email, phone, name, address) appears in Bronze event payloads, logs, or the identity_link table — hashed identifiers only
10. backfilled orders' `occurred_at` = Shopify `processed_at`; the existing revenue-finalization job finalizes them on its next run (verify by seeding a past-horizon order and running the finalization job)
11. Dashboard shows "Gross Revenue (ex-fees)" label; provisional and realized are shown separately, never summed
12. Cross-brand isolation: under `brain_app` + wrong `brand_id` GUC, `backfill_job` and `bronze_events` queries return 0 rows (non-inert, must be tested under brain_app not superuser)
13. Live consumer group (`stream-worker-live`) offset lag is unaffected by a backfill event storm (tested by flooding the backfill topic while measuring live topic consumer lag)
14. The audit log records the backfill trigger event (actor, connector_instance_id, brand_id)

---

## Scope Cuts Declared

| Cut | Rationale |
|-----|-----------|
| Shopify GraphQL Bulk Operations | REST since_id sufficient for M1 volumes; Bulk Op adds complexity, async webhook, file parsing; Phase 2 |
| Argo Workflows orchestration | stream-worker job pattern is the M1 runner; Argo is a platform follow-up |
| Option (b) durable dev secret store | Reconnect-before-backfill is sufficient; a dev table adds migration + complexity for a dev-only concern |
| `connector_sync_status` extension | New `backfill_job` table is cleaner; the sync-status state machine is a different contract |
| Per-Shopify-store-ID concurrency cap in config | Single partition on the backfill topic is the natural throughput cap; no config layer needed |

---

## Paradigm

Tier-0 deterministic throughout. The backfill worker is a data pipeline job: HTTP calls (Shopify REST), cursor upsert, Kafka produce, Bronze write. Zero model calls. Zero AI inference. Cost routing: $0/month in model spend. Applicable cost levers: none (no model calls). Batch/async API not applicable (Shopify REST is the external constraint, not a model call). The two-lane isolation is a topic + consumer group configuration — also $0.

---
