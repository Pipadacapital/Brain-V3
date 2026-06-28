# GoKwik Connector — Reimplementation Plan (webhook-first, canonical-events)

Status: PLAN (ready to build). Owner: Connector Platform.
Brand under test: **Bodd Active** = `1a6adb32-eb0d-41f9-8409-dc423240e444`.

GoKwik is a **checkout / payments-optimisation** source for India e-commerce. Its real-time
seam is **webhooks** (POC-mediated: GoKwik points the webhook at our URL with a shared signing
secret). GoKwik has **no AWB-read API** — the earlier `gokwik.awb_status.v1` logistics model was
a synthetic mistake and is retired here. Logistics truth = Shiprocket, not GoKwik.

---

## (a) Root cause of the current break

GoKwik is "connected but no data" for two compounding reasons — one operational, one in code.

**R1 — No connector instance (Stage-0 starvation, the active blocker).**
There is **no `connectors.connector_instance` row for `provider='gokwik'`** — not for Bodd Active,
not for any brand (the brand has only 6 meta + 1 shopify instances). With no instance row there is
no `secret_ref`, no `gokwik_appid`, no `webhook_secret`, and no `connector_sync_status`. Therefore:
- inbound webhooks cannot resolve a brand — `resolve_gokwik_connector_by_merchant(appid)` (0108)
  has nothing to match → events are rejected;
- producer-side enumeration returns 0 rows → nothing is produced to Kafka.

Bronze confirms total starvation: `brain_bronze.collector_events` for the brand holds only
`order.live.v1` (813, Shopify) + `spend.live.v1` (968, Meta) — zero gokwik/checkout/payment types;
`gokwik_events_raw` exists with 0 rows; no gokwik Kafka topics; no gokwik secret in LocalStack.

**R2 — Even with an instance, the code dead-ends (the design defect).**
`GokwikWebhookStrategy.payloadMap` emits a single **opaque `gokwik.webhook.v1`** envelope
(content-hash + probed scalar allowlist). That event lands in Bronze but has **no Silver
canonicalization** — no order/checkout/payment mart reads it. So "connected" would still produce no
dashboard data. Meanwhile the *only* live Silver path is `silver_collector_event` reading
`collector_events`; the `silver_gokwik_normalize.py` → `gokwik_events_raw` raw lane has **no
producer** (the G1 gap), self-skips on 0 rows, writes a `_shadow` table, and is referenced by no
orchestrator — dead code. And the entire AWB stack (repull job, synthetic client, `mapGokwikAwb`,
`gokwik.awb_status.v1`) is the **wrong source model**.

Fix = persist a real GoKwik instance **and** upgrade the webhook from an opaque envelope to
**discriminated canonical events** on the collector lane, so `connected` actually means data flows.

---

## (b) REUSE vs REPLACE

### REUSE (correct, keep as-is or extend)
- **Webhook route + pipeline** — `registerWebhookRoutes.ts` GoKwik block (POST `/api/v1/webhooks/gokwik`),
  `WebhookPipeline` (produces to the collector lane `prod.collector.event.v1`), `IWebhookStrategy`
  contract. The pipeline already does Kafka produce, dedup, age-gate, sync-status touch — the strategy
  only supplies `signatureVerify` + `payloadMap`.
- **Brand resolution (MT-1)** — `resolve_gokwik_connector_by_merchant(appid)` (0108, SECURITY DEFINER):
  appid only *selects* the row; `brand_id` comes from the connector row, never the body.
- **HMAC plumbing** — `buildGokwikHmacConfig()` (`HmacConfig.ts`), env-overridable header/encoding,
  fail-closed on missing `webhook_secret`.
- **Catalog + generic connect** — the `'gokwik'` catalog entry (`registry.ts`: appid/appsecret/optional
  webhook_secret, `instanceColumn=gokwik_appid`) drives `planCredentialConnect` — the path that
  actually persists an instance.
- **RTO-Predict mapper half** — `mapGokwikRtoPredict` + `normalizeRiskFlag` (categorical, verbatim
  `risk_flag_raw`, never fabricates a number) → `gokwik.rto_predict.v1`. Already admitted by
  `silver_collector_event` + `silver_checkout_signal`.
- **Canonical order contract** — `@brain/shopify-mapper` `OrderProperties` / `uuidV5FromOrderLive` /
  `decimalStringToMinor` / `ORDER_LIVE_V1_EVENT_NAME`. GoKwik orders reuse this exact shape
  (`source:'gokwik'`) → `silver_order_state` → recognition → revenue/attribution Gold, unchanged.
- **Boundary crypto** — `hashIdentifier(value,'email'|'phone',saltHex,'IN')` + `normalizePhone`
  (identity-core), `hashToUuidShaped` (connector-core).
- **silver_collector_event admission gate** — the real Silver entry; we only extend its IN-set.

### REPLACE / RETIRE (wrong model — remove honestly)
- **AWB everything** — `gokwik-awb-repull/` job + `gokwik-awb-client.ts` (synthetic, prod-gated to 0),
  `mapGokwikAwb` + AWB types + `uuidV5FromAwb` + `hashAwbNumber` + `GOKWIK_AWB_STATUS_V1_EVENT_NAME`,
  the `gokwik.awb_status.v1` bronze bridge, and the `_build_awb` seam in `silver_gokwik_normalize.py`.
- **Opaque envelope** — `gokwik.webhook.v1` (`GOKWIK_WEBHOOK_EVENT_NAME` + the probe-allowlist
  `payloadMap`). Replaced by discriminated canonical emits.
- **Synthetic RTO emit job** — `gokwik-rto-predict-emit/` (synthetic fixture, prod-gated, undispatched).
  RTO now arrives via the webhook `risk.scored` event on the collector lane.
- **Dead raw-lane normalizer** — `silver_gokwik_normalize.py` (reads producer-less `gokwik_events_raw`,
  `_shadow` target, unreferenced).
- **Stale enumeration / ledger types** — `list_gokwik_connectors_for_awb_repull()` (rename to a
  model-neutral enumerator) and the dead `cod_rto_clawback` / `cod_delivery_confirmed` ledger
  event-types from 0030 (`realized_revenue_ledger` was dropped in the medallion realignment).

---

## (c) Target design — webhook-first → canonical events → existing Silver/Gold

```
GoKwik POST /api/v1/webhooks/gokwik
  → signatureVerify: appid (header x-gokwik-appid | body) → resolve_gokwik_connector_by_merchant
      → HMAC-SHA256(rawBody, webhook_secret) fail-closed (401 on miss/mismatch)
  → payloadMap: DISCRIMINATE on normalized gokwik event_type → emit ONE canonical event
  → WebhookPipeline → Kafka producer → prod.collector.event.v1 (envelope brain.collector.event.v1)
  → bronze_materialize (SERVER_TRUSTED lane: brand server-derived, NO install_token/consent gate)
  → brain_bronze.collector_events
  → silver_collector_event (admits the gokwik canonical types)
  → silver_order_state / silver_checkout_signal / silver_payment
  → Gold (recognition, revenue, attribution, checkout-funnel) → Trino serving → UI
```

A single webhook maps to exactly **one** canonical event (the `PayloadMapResult` contract is
one-event-per-call), so discrimination is a clean switch on the GoKwik `event_type`:

| GoKwik event | Canonical Brain event | Silver target | New? |
|---|---|---|---|
| order.created / paid / failed / cancelled / refunded / updated | **order.live.v1** (`source:'gokwik'`); state via `financial_status` + `cancelled_at` + `refunds[]` | silver_order_state | reuse |
| order.failed | order.live.v1, `financial_status='voided'` (recognition gate recognises refunded/voided/cancelled, not "failed") | silver_order_state | reuse |
| risk.scored | **gokwik.rto_predict.v1** (categorical `risk_flag`, verbatim `risk_flag_raw`) | silver_checkout_signal | reuse |
| checkout.abandoned | **checkout.abandoned.v1** (source-neutral, NEW) | silver_checkout_signal | NEW |
| checkout.started | **gokwik.checkout_started.v1** (NEW funnel) | silver_checkout_signal (signal_type) | NEW |
| checkout.step_completed | **gokwik.checkout_step.v1** (NEW funnel) | silver_checkout_signal (signal_type) | NEW |
| payment.attempted | **payment.attempted.v1** | silver_payment (`payment_status='initiated'/'failed'`) | NEW |
| payment.authorized | **payment.authorized.v1** | silver_payment (`payment_status='authorized'`) | NEW |
| identity.email / phone | FIELD `hashed_customer_email` / `hashed_customer_phone` on the order/checkout event (NOT an event) | — | reuse |
| identity.customer_id | FIELD `storefront_customer_id` (NOT PII) | — | reuse |
| ~~gokwik.awb_status.v1~~ | RETIRE | — | remove |
| ~~gokwik.webhook.v1~~ | RETIRE | — | remove |

**Order field mapping** (`order.* → order.live.v1` properties, `source='gokwik'`):
`order_id ← moid|merchant_order_id|gokwik_order_id|order_id` (passthrough, ledger spine key, not PII);
`amount_minor ← total → ×100 BIGINT` via `decimalStringToMinor` (integer math, never float, string-encoded);
`currency_code ← currency|currency_code` default `'INR'`;
`payment_method ← cod|prepaid` (cod/cash_on_delivery→cod; prepaid/online/paid→prepaid);
`financial_status ←` normalized to `paid|pending|refunded|voided|cancelled`;
`cancelled_at ←` set on order.cancelled else null;
`hashed_customer_email ← hashIdentifier(email,'email',saltHex,'IN')` (raw dropped in-scope);
`hashed_customer_phone ← hashIdentifier(normalizePhone(phone,'IN').normalized,'phone',saltHex,'IN')` (raw dropped);
`storefront_customer_id ←` GoKwik customer_id;
`occurred_at ← created_at|updated_at|event_time` (ISO-8601);
`event_id ← uuidV5FromOrderLive(brand:order_id:updatedAtMs:order.live.v1)` → per-state idempotent restatement;
optional `line_items[]`, `tax_total_minor`, `discount_total_minor`, `refunds[]`/`refund_total_minor` (all bigint minor).

**PII boundary**: raw email/phone are hashed at the strategy boundary with the per-brand salt and
**dropped** — only salted hashes are emitted (identical to Shopify). Money is always bigint **minor
units + sibling `currency_code`**, never a float, never blended.

**Lane invariant**: because brand is server-derived, every new GoKwik canonical event_type MUST be
added to **both** `SERVER_TRUSTED` (silver_collector_event) and `SERVER_TRUSTED_BRONZE`
(bronze_materialize). Omitting either routes the event into the PIXEL lane and quarantines it for a
missing `install_token`/`consent_flags`.

---

## (d) Build plan (file-level) — see structured `build_steps`

Numbered steps with exact files + verification are returned in the structured output. Highlights:

1. **Persist a real GoKwik instance for Bodd** (root cause R1) — via `planCredentialConnect`
   (catalog already defines it): store `{appid, appsecret, webhook_secret}` + `gokwik_appid`.
2. **Mapper**: retire AWB half; add `mapGokwikOrder` (→order.live.v1, OrderProperties shape),
   `mapGokwikCheckout` (started/step/abandoned), `mapGokwikPayment` (attempted/authorized); keep RTO.
3. **Strategy**: rewrite `payloadMap` to discriminate on event_type → canonical emit; delete the
   opaque envelope path; keep `signatureVerify` (HMAC fail-closed).
4. **Silver/Bronze admission**: add the new canonical types to `silver_collector_event` +
   `bronze_materialize`; extend `silver_checkout_signal` + `silver_payment` IN-lists; remove the
   retired `gokwik.awb_status.v1` / `gokwik.webhook.v1`.
5. **Retire AWB/synthetic jobs + dead normalizer + bronze bridge** for awb_status.
6. **Migration 0117**: rename the enumerator to model-neutral, drop dead AWB ledger event-types,
   doc-comment the AWB retirement.
7. **Secrets/env**: webhook_secret on the bundle; `GOKWIK_SIG_HEADER`/`GOKWIK_SIG_ENCODING`; dev
   LocalStack seed.
8. **Tests** for each mapper + strategy discrimination + the lane membership guard.

---

## (e) What ships UI

- **Connector health**: GoKwik on the connectors page flips to **Connected + receiving events**
  with a live `last_event_at` (driven by `connector_sync_status` touched by the webhook pipeline) —
  no more silent "connected but no data".
- **Checkout-funnel + RTO-risk surfaces** light up from `silver_checkout_signal` (checkout
  started/step/abandoned + RTO risk badge — categorical High/Medium/Low/Control, never a fake score).
- **Payment funnel** from `silver_payment` (attempted → authorized).
- **Revenue / attribution** dashboards gain GoKwik orders via `order.live.v1` → recognition →
  revenue/attribution Gold, identical to Shopify orders.

---

## Verification (live)

- **Endpoint**: `curl -XPOST .../api/v1/webhooks/gokwik` with `x-gokwik-appid` + a valid HMAC for a
  sample `order.created` / `checkout.abandoned` / `risk.scored` payload → 200; bad HMAC → 401.
- **Instance**: `SELECT id,brand_id,gokwik_appid,status FROM connectors.connector_instance WHERE
  provider='gokwik';` → 1 row for Bodd.
- **Bronze (Trino)**: `SELECT event_type,count(*) FROM iceberg.brain_bronze.collector_events WHERE
  brand_id='1a6adb32-eb0d-41f9-8409-dc423240e444' AND event_type LIKE '%gokwik%' OR event_type IN
  ('order.live.v1','checkout.abandoned.v1','payment.attempted.v1','payment.authorized.v1') GROUP BY 1`
  → non-zero gokwik-sourced rows.
- **Silver (Trino)**: rows appear in `silver_order_state` / `silver_checkout_signal` / `silver_payment`
  for the brand; `risk_flag_raw` preserved verbatim.
- **Negative**: zero `gokwik.awb_status.v1` / `gokwik.webhook.v1` produced after the cutover.
