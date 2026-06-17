# 05 — Connectors, Commerce Truth & Cart Stitch (D5 / D6 / D7)

> Scope: the connector platform (D5), the Platform→Brain→Realized revenue truth chain (D6), and cart-stitch
> (D7). Grounded against the **shipped** connector framework (`connector_instance` / `connector_cursor` /
> `connector_sync_status`, marketplace registry, backfill+live+repull jobs, Shopify live, Razorpay settlement)
> and `realized_revenue_ledger`. **D5 and D6 are overwhelmingly Present/Equivalent. The one genuine net-new
> capability in this entire cluster is cart-stitch (D7).**
>
> Tag legend: **[Present]** shipped in code · **[Equivalent]** a shipped seam covers it, extend don't rebuild ·
> **[Missing]** genuinely net-new · **[Raw-Only]** lands raw in Bronze, modeled later · **[Reject]** would drift.
>
> Hard rule applied throughout: **no new deployable, no new topic, no new envelope, no `connector_definition`
> DB table, no `*_token`/`*_secret`/`*_ciphertext` column.** Every build extends a named existing seam.

---

## D5 — Connector Platform

### D5.1 Connection flow & auth — **[Present]**
Two connect methods are shipped and are the only two the catalog models (`ConnectMethod = 'oauth' | 'credential' | 'coming_soon'`, `registry.ts:25`):

- **OAuth** (Shopify): full initiate/callback. `InitiateOAuthCommand.ts`, `HandleOAuthCallbackCommand.ts`, state-nonce CSRF guard (`OAuthStateNonce.ts`), HMAC verify (`ShopifyHmac.ts`). Token bytes go to AWS Secrets Manager; `connector_instance.secret_ref` holds the ARN only (NN-2, `0006_connector.sql:24`).
- **Credential** (Razorpay): connect/disconnect with key-id/secret to Secrets Manager, `razorpay_account_id` persisted for webhook brand-resolution (`0027` part A).

**No new auth pattern is needed for any new connector category.** A new source picks `oauth` or `credential` and reuses the same secret_ref discipline. **[Reject]** treating `install_token` or any provider key as a Postgres-stored secret — NN-2 semgrep DDL scan blocks it.

### D5.2 Marketplace / catalog — **[Present]**
Static TS registry is the SoR (ADR-CM-1): `CONNECTOR_CATALOG` in `registry.ts`. All **7 categories** populated — `storefront, ads, payments, logistics, messaging, crm, analytics` (`ConnectorCategory`, `registry.ts:16`). Today: 2 available (Shopify, Razorpay), 6 `coming_soon` (WooCommerce, Meta, Google Ads, Shiprocket, WhatsApp, HubSpot, GA4).

- The task brief lists "messaging/CRM/future" categories — they **already exist as tiles**. Adding a real backend = a new `sources/<category>/<provider>/` module + extending the `provider` CHECK additively (the exact pattern `0027` used to add `'razorpay'`). **No catalog table.**
- **[Reject]** a `connector_definition` DB table — ADR-CM-1; catalog change = code deploy by design.

### D5.3 Extraction, sync strategy, cursor mgmt — **[Present]**
- **Cursor**: `connector_cursor` with idempotent upsert key `UNIQUE(brand_id, connector_instance_id, resource)` (`0006_connector.sql:91`, I-ST04). Replay-safe by construction.
- **Sync state**: `connector_sync_status` (`connected|syncing|waiting_for_data|error`) + 7-state `health_state` + 3-state `safety_rating` (`0021_connector_health.sql`).
- **Same-code-path live + backfill**: the headline shipped property. Live lane (`LiveOrderConsumer.ts`) and backfill (`shopify-backfill/run.ts`) both terminate in the same `ProcessEventUseCase → Bronze` path; **no separate ingest topic** — `order.live.v1` / `order.backfill.v1` multiplex on the existing `dev.collector.event.v1` lane via distinct deterministic `event_id` namespaces (`shopify-mapper` D-6: `uuidV5FromOrderBackfill` vs `uuidV5FromOrderLive`).
- **35-day re-pull** correction window: `shopify-repull/run.ts`; settlement re-pull: `razorpay-settlement-repull/`.

A new connector category reuses this exact spine: a `sources/.../client.ts` + a `<provider>-mapper` package emitting onto the existing collector wire shape.

### D5.4 Retries, backfills, failure recovery, replay — **[Present]**
- **Backfill progress + resume**: `backfill_job` (`queued/running/completed/partial/failed`, resumable cursor, overlap-lock partial index, append-by-GRANT no DELETE — `0022_backfill_job.sql`).
- **Replay**: Bronze is the immutable SoR (`bronze_events`, append-only GRANT, `(brand_id,event_id)` PK); the ledger is explicitly **rebuildable from Bronze** (`0018` header line 48). Any connector mart can be dropped and replayed.
- **DLQ**: poisoned messages → `dev.collector.event.v1.dlq` at `MAX_RETRY=5` with forensic headers (`DlqProducer.ts`).
- **Webhook dedup**: Razorpay uses HMAC + Redis dedup; Shopify webhooks are HMAC-validated. Idempotency backstop is the ledger dedup `UNIQUE(brand_id, order_id, event_type, occurred-date)` (`0018:103`).

### D5.5 Observability & health — **[Present]**
`health_state`/`safety_rating` dispatch (`catalog/healthSafety.ts`, `dispatch.ts`); `connector_sync_status.last_error`/`last_sync_at`; pixel health surface (`GET /api/v1/pixel/health`).
- **[Missing — small]** A **per-connector freshness-SLA monitor** (e.g. "Shopify silent > N hours") as a structured signal feeding the metric-engine `dq_grade`. This is correctly the data-quality lane's job (see cluster 04 / `packages/contracts/src/dq` Freshness contract), not a connector-platform rebuild. Extend the DQ Freshness contract + a stream-worker freshness job; do **not** add a connector observability deployable.

### D5.6 Canonical mapping, schema evolution, versioning — **[Present / locked]**
- **Canonical mapping**: per-source frozen mapper packages — `@brain/shopify-mapper` (`ADR-LV-0 / D-12`, **FROZEN API**), `@brain/razorpay-mapper`. Each maps provider JSON → the collector envelope, hashing PII at the boundary (raw email/phone consumed and **dropped**, only hashed identifiers emitted — D-10/I-S02).
- **Schema evolution**: Avro `collector.event.v1.avsc` is `FULL_TRANSITIVE`, **additive-optional only**; new `event_type`+`payload` ride the existing envelope with no schema change (Apicurio-gated, `@brain/events`). **[Reject]** a new topic/envelope for any new connector event.
- **Versioning**: deterministic per-state `event_id` (live appends a new Bronze row per `updated_at`; backfill is one id/order) — the version axis is the event-time, not a mutable row.

> **D5 verdict:** the connector platform is mature and category-complete in shape. Net-new D5 work for a new
> connector = one `sources/` module + one mapper package + an additive `provider` CHECK extension. **No
> platform-level gap.** The only small additive ask is the freshness-SLA monitor, owned by the DQ lane.

---

## D6 — Commerce Truth

### D6.1 Event coverage: orders / updates / payments / settlements / refunds / chargebacks / RTO — **[Present]**
`realized_revenue_ledger` is one append-only ledger with an `event_type` discriminator (`0018` + `0027` additive). **Actual shipped event_type set (verified in migrations — 17 values):**

| Group | event_types (verbatim from `0018:67` + `0027:140`) |
|---|---|
| Order recognition (`0018`) | `provisional_recognition`, `finalization`, `rto_reversal`, `refund`, `chargeback`, `cancellation`, `settlement_fee_reversal`, `marketplace_adjustment`, `payment_adjustment`, `concession` |
| Settlement (`0027`) | `settlement_finalization`, `payment_fee`, `settlement_tax`, `rolling_reserve_deduction`, `rolling_reserve_release`, `settlement_reversal`, `settlement_adjustment` |

> **Correction to the ground map:** the ground-map text mixed the two sets (it listed `settlement_finalization/payment_fee/...` as if in 0018). Authoritative truth: the **base 10 live in `0018`'s CHECK**; the **7 settlement types are the `0027` additive extension**. Builders must read both migrations, not one.

- **RTO** = a `rto_reversal` negative row; the original sale row is **byte-identical / untouched** (verified in measurement live tests) — this is the revenue-truth invariant made structural.
- **Shipping / fulfillment status**: carried on the order event (`OrderProperties.fulfillment_status`, `shopify-mapper`) and in Bronze raw; not yet a separate logistics ledger event because **no logistics connector is live** (Shiprocket is `coming_soon`). **[Raw-Only]** until Shiprocket lands; then it rides the same ledger/event pattern, not a new store.

### D6.2 Platform Revenue → Brain Revenue → Realized Revenue (and why) — **[Present]**
This three-tier truth is the moat and is structurally enforced:

1. **Platform Revenue** = what Shopify's own dashboard shows (gross order value at checkout). Captured raw in Bronze on `order.live.v1`. Naive, inflated — counts COD orders that will RTO, counts orders that will refund.
2. **Brain Revenue** = Brain's recognition model applied: COD vs prepaid horizons (`brand.cod_recognition_horizon_days=25`, `prepaid=7`), `provisional_recognition` until the horizon, then `finalization`; RTO/refund/chargeback/cancellation post **negative** rows. The `revenue-finalization.ts` cron drives the horizon transitions. This is *order-truth net of returns*.
3. **Realized Revenue** = money that actually **settled into the merchant's bank net of fees**: Razorpay `settlement_finalization` (+) minus `payment_fee` (MDR −), `settlement_tax` (GST-on-MDR 18% −), `rolling_reserve_deduction` (−). Bridged via `connector_razorpay_order_map` (settlement.payment_id → shopify_order_id → ledger.order_id, raw payment_id internal-join-only, C1).

**Why the chain exists:** the Decision Engine cannot allocate spend against inflated platform GMV. `realized_gmv_as_of(brand, date)` (`0018:176`) is the **sole** no-double-count read path — it **excludes** `provisional_recognition` so provisional and finalized are never double-counted. Confidence (`recognition_label: provisional|settling|finalized`) is stamped on every row, making revenue-truth a first-class graded output, not a single number.

- Money is `BIGINT *_minor` + `currency_code CHAR(3)` everywhere, with a no-float migration assertion (`0018` assertion-3, I-S07) and a per-brand single-currency BEFORE-INSERT trigger.
- **[Reject]** any per-event-type ledger table (doc-08 §0.4 #1 — one ledger, discriminator); **[Reject]** computing realized GMV via ad-hoc `SUM(amount_minor)` in app code — the named function is the only sanctioned path.

> **D6 verdict:** fully Present. The Platform→Brain→Realized chain is shipped and structurally guarded. The
> only forward work is additive event_types when a logistics/marketplace connector lands — same ledger, same
> pattern.

---

## D7 — Cart Stitch  ← **THE NET-NEW CAPABILITY OF THIS CLUSTER**

**Verified absent in code.** A repo-wide grep for `note_attributes|cart.attribute|stitched_anon|brain_anon|stitch_source|stitched_click|stitched_first_touch` across `apps/ packages/ db/ tools/` returns **exactly one hit** — a *doc comment* in `packages/pixel-sdk/src/index.ts:20` describing the deferred writer. Zero implementation. The frozen `ShopifyOrderShape` (`shopify-mapper/src/index.ts:30`) does **not** include `note_attributes` — confirming no parser reads it. Cart-stitch is spec'd (req docs 04/05/07/08/10) and **unbuilt**.

Cart-stitch closes the **anon → known → order** loop deterministically so Journey→Attribution→Decision-Engine can credit a pre-purchase touchpoint to a settled order. It is **deterministic** (read the exact `brain_anon_id` back from the order payload — never infer).

### D7.1 Captured identifiers — **[Missing]** (capture seam = `@brain/pixel-sdk`)
The pixel writes, into the cart, at first/last touch:
- `brain_anon_id` (the SDK anon-id — net-new, cluster 01 SDK scope)
- first-touch click IDs: `_fbc`, `_fbp`, `gclid`
- first-touch UTMs: `utm_source/medium/campaign/term/content`

**Seam:** extend `packages/pixel-sdk` (the designated `export {}` stub) — the cart-attribute **writer**. **[Reject]** a new SDK package or deployable; **[Reject]** capturing raw PII here (only the opaque anon-id + click/UTM tokens, which are not PII).

### D7.2 Storage locations & commerce-platform propagation — **[Missing]**
- **Browser→cart**: SDK writes to **Shopify `cart.attributes`** (and WooCommerce checkout-meta when that connector lands). These survive into the order payload as `note_attributes`.
- **Order payload→Brain**: the **webhook parser** recovers them server-side. **Seam:** extend `@brain/shopify-mapper` — add `note_attributes` to `ShopifyOrderShape` (additive) and a parse step in `mapOrderToEvent` that emits the stitch fields onto `OrderProperties`. Consumed by both the live webhook (`shopifyWebhookHandler.ts`) and backfill/re-pull (single frozen mapper, shared — D-12). **No new parser service.**
- **Persist**: a **new additive migration** introducing the `silver.order_state` stitch columns from doc-08 §35 — `stitched_anon_id`, `stitched_click_ids`, `stitched_first_touch_utms`, `stitch_source` — **mirroring `connector_razorpay_order_map`** for RLS-FORCE + replay-upsert discipline (`0027` part B is the precedent: per-brand, two-arg fail-closed, upsert-on-replay, raw join-IDs internal-only). **[Reject]** modeling these in an OLTP touchpoint table that drifts storage tiering — but note M1 has no StarRocks yet, so the pragmatic landing is a per-brand stitch table that the attribution module owns, replayable from Bronze, ready to project to Silver when StarRocks lands.

### D7.3 Order recovery — **[Reject]** (not a collection-plane concern)
Repo-wide grep (`cart/abandoned/recover/winback/reorder`) finds only crash/spool-recovery language. `TRIGGER-SURFACES.md` has no cart/abandon surface. **An abandoned-cart / order-recovery *action* is a Decision-Engine / outbound concern, not collection.** Brain is not a CDP/campaign tool. Cart-stitch exists ONLY to feed the identity→attribution→Decision-Engine loop. **[Reject]** any recovery-action scope in this cluster.

### D7.4 Attribution linkage — **[Equivalent]** destination exists, link is net-new
The recovered `stitched_anon_id` feeds the **shipped** deterministic identity resolver (`IdentityResolver.ts`, `ResolveIdentityUseCase.ts`) as a **backward merge** key: anon-id observed pre-purchase → linked to the `brain_id` minted at order. The `customer.anonymous_id` column and `identity_link` already exist as the destination (cluster 02). **Seam:** extend `ResolveIdentityUseCase` extraction to read the stitched anon-id from the order event and bind it via the existing `brain_id_alias` re-pointing. **[Reject]** probabilistic stitching (doc-10 §93 defers it; D-5 deterministic-first) — read the exact id back, never infer.

### D7.5 Failure / fallback — **[Missing]**
- **No cart attribute on order** (direct-traffic order, SDK blocked, consent-declined): order still flows to the ledger via the existing path with `stitch_source='none'`; identity resolves on strong identifiers (email/phone) only. Stitch is **additive enrichment, never a gate on revenue truth** — accept-before-validate posture preserved.
- **Malformed/forged anon-id**: validate format; on failure set `stitch_source='invalid'` and drop the stitch, never the order.
- **Replay**: upsert-on-conflict keyed by `(brand_id, order_id)` — idempotent, mirrors ledger dedup.

### D7.6 Verification, coverage calc, health, success metrics — **[Missing]**
- **Verification (E2E)**: a real browser→`cart.attributes`→Shopify order→webhook→parser→stitch-table proof. Extend the existing `tools/pixel-fixture` path; today's proof is a Node fixture only.
- **Coverage calc** (the key health metric): `stitch_coverage = count(orders with stitch_source IN ('shopify_cart_attribute',...)) / count(all orders)` per brand per window. This is a **metric-engine** output stamped with a `dq_grade`/confidence — built in the metric-engine/analytics path (METRICS.md), **not** as a new float column here.
- **Success metric / benchmark**: target server-side stitch coverage **≥ 85–90%** of identified orders (Elevar / Littledata server-side-GTM publish ~90%+ for first-party cart-attribute stitching vs ~40–60% for cookie-only browser attribution; Triple Whale's "pixel match rate" is the equivalent KPI). Coverage below a floor is itself a `dq_grade` downgrade that lowers attribution confidence — confidence-as-first-class.

> **D7 verdict — the only Missing capability in this cluster.** Build it by extending **three** existing seams,
> zero new deployables/topics/envelopes:
> 1. **Writer** → `packages/pixel-sdk` (cart-attribute writer).
> 2. **Parser** → `@brain/shopify-mapper` (`ShopifyOrderShape` + `mapOrderToEvent`, additive) — consumed by the
>    shipped webhook + backfill/re-pull.
> 3. **Persist + link** → new additive migration for `order_state` stitch columns (mirror
>    `connector_razorpay_order_map`) + extend `ResolveIdentityUseCase` for the backward anon→brain_id merge.

---

## Highest-risk decision

**Mutating the frozen `@brain/shopify-mapper` API to add the `note_attributes` parse step.** The package is
`ADR-LV-0 / D-12` **FROZEN** ("do not change after A0 commit without Architect sign-off") and is the **single
shared mapper** imported by three call sites — live webhook, backfill, and 35-day re-pull. A regression here
silently corrupts the entire commerce-truth ledger across all order paths simultaneously, not just stitch.
**Mitigation:** make the change **strictly additive** (`note_attributes?` optional on the input type; new stitch
fields optional on `OrderProperties`; absent → `stitch_source='none'`, existing deterministic `event_id`/money
semantics **unchanged**), gate it behind an explicit Architect sign-off per D-12, and require a regression test
proving byte-identical ledger output for orders **without** cart attributes before any stitch test passes.

## Competitor benchmarks cited
Elevar / Littledata server-side GTM (first-party cart-attribute stitch, ~90%+ order coverage vs ~40–60%
cookie-only) · Triple Whale "pixel match rate" KPI · Shopify Web Pixels API / Customer Events + `cart.attributes`
as the propagation channel. Each passes the no-drift gate: they validate the *deterministic server-side stitch*
pattern Brain already spec'd; none introduces a new Brain deployable.
