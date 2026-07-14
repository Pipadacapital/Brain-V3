# Shiprocket Connector — Gap-Fill Plan

> **Writer note (ADR-0010, 2026-07-05):** `bronze_materialize.py` referenced below was removed —
> Bronze is landed verbatim by the Kafka Connect sink with NO Bronze-side gate; the
> `SERVER_TRUSTED` admit set now lives only in `silver_collector_event.py` (one edit, not two).

> Status: PLAN · Owner: Connector Platform · Brand under test: Bodd Active (`1a6adb32-eb0d-41f9-8409-dc423240e444`)
> Companion: `docs/architecture/gokwik-connector-reimplementation.md`. **Serialize implementation AFTER the GoKwik build** — both touch `silver_collector_event.py` and `bronze_materialize.py`.

Shiprocket is India's logistics / post-purchase fulfillment layer and is the **LOGISTICS TRUTH** for Brain. Unlike GoKwik (which was modeled on a wrong AWB assumption and is being reimplemented), Shiprocket is the **established, correct** logistics connector. This document is honest about how much is already BUILT, and scopes the GENUINE gaps: the missing forward lifecycle statuses, the entirely-absent RETURN event family, the non-functional webhook path, backfill hardening, customer identity, and the missing connect/observability UI.

---

## (a) Current state + live verdict

| Question | Verdict | Evidence |
|---|---|---|
| Connected (Bodd Active or any brand)? | **NO** | No `connector_instance` row for provider `shiprocket`; `sync_status` 0 rows; webhook archive 0 rows. |
| Data flowing? | **NO** | `iceberg.brain_bronze.collector_events` has no shiprocket event types; `silver_collector_event`, `silver_shipment`, `silver_shipment_event`, `mv_silver_shipment` all 0 rows. |
| Pipeline plumbed end-to-end? | **YES** | Admit-lists in `bronze_materialize.py` + `silver_collector_event.py` already trust `shiprocket.shipment_status.v1`; shipment marts + serving view exist. |

**Root cause of "no data" is connection, not code.** The downstream is fully built but **starved** — there is no source. The recent `silver_collector_event` keystone repoint and the shipment-outcomes `CAST` fix are correct but have no effect until a Shiprocket connector is connected for a brand. The first deliverable is therefore a way to actually connect Shiprocket (UI + credential + secret provisioning), not more pipeline.

**Two ingestion paths exist, with very different maturity:**
- **REPULL (REST poll) — LIVE-WIRED and functional.** `shiprocket-shipment-repull` is dispatched on a schedule (`REPULL_DISPATCH`) and on-demand (`RequestConnectorSyncCommand` → provider `shipment.lifecycle`). It emits canonical `shiprocket.shipment_status.v1` on the live collector lane, which is `SERVER_TRUSTED`-admitted and folds into `silver_shipment_event` → `silver_shipment` → gold → Trino. This is the only working source today.
- **WEBHOOK (push) — NOT functional end-to-end.** This is the spec's PRIMARY path but is blocked by three independent gaps (missing DB resolver fn, never-provisioned `webhook_secret`, narrow topic allowlist). See GAP-1/2/3.

---

## (b) BUILT inventory (do NOT rebuild)

| Component | Path | Status |
|---|---|---|
| Canonical mapper | `packages/shiprocket-mapper/src/index.ts` | **OK** — `mapShiprocketShipment()` → `shiprocket.shipment_status.v1`; AWB sha256-hashed at boundary, raw dropped; deterministic UUIDv5 dedup key (`brand:awb:status:status_changed_at`); status passed verbatim so forward states survive as strings; payment_method/pincode/courier captured. |
| Status authority | `packages/logistics-status/src/index.ts` | **OK (partial coverage)** — frozen `classifyShipmentStatus()`; `delivered→DELIVERED_TERMINAL`, 11 RTO variants→`RTO_TERMINAL`, `cancelled/lost/destroyed→OTHER_TERMINAL`. Shared with GoKwik — must stay byte-identical. |
| Repull job | `apps/stream-worker/src/jobs/shiprocket-shipment-repull/run.ts` | **OK** — enumerate (no GUC) → GUC-after-enumerate (MT-1) → single `shipment.lifecycle` cursor `FOR UPDATE SKIP LOCKED` → 45-day restatement window → map → emit canonical on live lane. Auth-error → `RECONNECT_REQUIRED` + backoff. |
| Token provider | `apps/stream-worker/src/jobs/shiprocket-shipment-repull/shiprocket-token-provider.ts` | **OK** — `/v1/external/auth/login` → 10-day JWT, cached 9 days, `invalidate()` on 401/403. Never logs creds. (Redis multi-replica cache noted but not built.) |
| Shipment marts | `db/iceberg/spark/silver/silver_shipment_event.py`, `silver_shipment.py` | **OK** — fold canonical status events into a per-`(brand,event_id)` transition log (idempotent MERGE, Stage-1 DQ); collapse to current-state per `(brand,order_id)` with terminal-wins; `is_rto`/`is_delivered` from terminal_class. |
| Live-lane admission | `db/iceberg/spark/bronze_materialize.py` (L106), `silver_collector_event.py` (L76-78) | **OK** — `shiprocket.shipment_status.v1` `SERVER_TRUSTED` in both; brand_id taken as-is; flows without quarantine. |
| Webhook strategy (shell) | `apps/core/src/modules/connector/webhooks/strategies/ShiprocketWebhookStrategy.ts` | **PARTIAL** — emits canonical via shared mapper with `X-Api-Key` timingSafe compare; structurally correct but blocked (GAP-1/2/3). |
| Route registration | `apps/core/src/modules/connector/webhooks/platform/registerWebhookRoutes.ts` (L136-165) | **PARTIAL** — `POST /api/v1/webhooks/shiprocket` registered with header lookup `x-shiprocket-channel-id`; resolver fn missing (GAP-1). |
| Registry + migration | `apps/core/src/modules/connector/catalog/registry.ts` (L251), `db/migrations/0059_shiprocket_connector.sql` | **PARTIAL** — provider CHECK, `shiprocket_channel_id` column + partial index, `list_shiprocket_connectors_for_repull()` enum fn. No webhook resolver, no `webhook_secret` provisioning. |

---

## (c) GAP REGISTER

Effort: S ≤0.5d · M ≈1-2d · L ≈3-5d. "Ships UI" = produces stakeholder-visible surface.

| # | Gap | Files | Priority | Effort | Ships UI |
|---|---|---|---|---|---|
| **SR-0** | **Connect Shiprocket for the brand (the actual blocker).** No `connector_instance` exists, so token provider can't resolve, repull never runs, webhook never receives. Need a Connect flow: credential capture (email/password/optional channel_id) + secret provisioning + first sync trigger, surfaced in the connector UI. Everything downstream is starved until this exists. | `apps/core/src/modules/connector/catalog/registry.ts`, `apps/core/src/modules/connector/credential-schema.ts`, `apps/web` connector pages | **high** | M | **yes** |
| **SR-1** | **Webhook resolver fn missing.** `registerWebhookRoutes` calls `resolve_shiprocket_connector_by_channel`, which exists in NO migration (0059 created only `list_shiprocket_connectors_for_repull`). Webhook can't resolve a tenant → route is dead. Clone `0108_resolve_gokwik_connector_by_merchant.sql` (SECURITY DEFINER, search_path-pinned, `brain_app` EXECUTE, sec-guard DO-blocks) resolving by `shiprocket_channel_id` (+ account-id fallback). | NEW `db/migrations/0118_resolve_shiprocket_connector_by_channel.sql` | **high** | S | no |
| **SR-2** | **`webhook_secret` never provisioned.** Strategy verifies `X-Api-Key` against `webhook_secret` in the secret bundle, but the credential schema/registry only provisions `email/password/channel_id` → verify always FAILS-CLOSED. Add `webhook_secret` to the credential plan + connect-time generation, and surface the per-tenant webhook URL + token in the Connect UI (paste into Shiprocket dashboard). | `apps/core/src/modules/connector/credential-schema.ts`, `apps/core/src/modules/connector/catalog/registry.ts`, `apps/web` connect page | **high** | M | **yes** |
| **SR-3** | **Webhook topic allowlist too narrow.** `SHIPMENT_TOPICS` lists only 7 topics; everything else is fast-acked `skip=true` (silently dropped). Missing: `delayed`, `exception`, `lost`, `destroyed` (status is in OTHER set but topic dropped → dedicated pushes lost), and ALL `return.*` topics. Widen the allowlist to the full spec lifecycle + return families. | `apps/core/src/modules/connector/webhooks/strategies/ShiprocketWebhookStrategy.ts` (L57-65, L176-186) | **high** | S | no |
| **SR-4** | **RETURN events entirely unmodeled (correctness bug).** `return.created/picked_up/delivered/completed` have no topic, no mapper concept, no classification. `return.completed` currently would mis-map to the DELIVERED class → **false delivery confirmation / revenue-truth corruption**. Add a sibling canonical `shiprocket.return_status.v1` + a `RETURN_*` class in the authority so returns are never confused with forward delivery or RTO. | `packages/logistics-status/src/index.ts`, `packages/shiprocket-mapper/src/index.ts`, `apps/core/.../ShiprocketWebhookStrategy.ts`, `db/iceberg/spark/silver/silver_collector_event.py` + `bronze_materialize.py` (admit new type), NEW `silver_return.py` mart | **high** | L | **yes** |
| **SR-5** | **Forward lifecycle not a state machine.** `created/pickup/picked_up/in_transit/out_for_delivery/delayed/exception` survive only as verbatim raw strings with `terminal_class='none'`; `delayed`/`exception` (NDR) are not modeled at all. Enumerate forward states + add a non-terminal `EXCEPTION`/`NDR` sub-class so delivery delays/NDR are queryable (high-signal for RTO prediction), not lumped into "in-flight". | `packages/logistics-status/src/index.ts`, `packages/shiprocket-mapper/src/index.ts`, `db/iceberg/spark/silver/silver_shiprocket_normalize.py` (keep authority in lockstep) | **medium** | M | no |
| **SR-6** | **Customer identity absent across every layer.** `ShiprocketShipmentRecord`, webhook, repull client, and silver normalize all omit `customer_phone`/`customer_email`. Spec requires phone+email hashed at the boundary (+ explicit merchant `order_id`). Without it, shipments can't link to the customer 360 / journey. Hash at the mapper boundary (same salt regime as AWB). | `packages/shiprocket-mapper/src/index.ts`, `apps/core/.../ShiprocketWebhookStrategy.ts`, `apps/stream-worker/src/jobs/shiprocket-shipment-repull/shiprocket-client.ts` | **medium** | M | no |
| **SR-7** | **Backfill client unverified against a real account.** Live HTTP path is production-shaped but the list endpoint (`/v1/external/orders`), pagination, and response field names are unconfirmed (defensive `pick()` maps). The documented per-AWB Shipment Tracking endpoint is unused. Dev fixture has only 7 statuses + no `return.*`. Verify against a real Shiprocket account, confirm field names, add the tracking endpoint for historical backfill, and extend the fixture. | `apps/stream-worker/src/jobs/shiprocket-shipment-repull/shiprocket-client.ts` | **medium** | M | no |
| **SR-8** | **`silver_shiprocket_normalize.py` (ADR-0006 verbatim→canonical) not on live path.** Skip-guards on empty raw lane; writes to shadow `silver_collector_event_shiprocket_shadow`. Its local copy of the authority must track SR-4/SR-5 changes. Decide: keep as dual-run parity shadow (and keep in lockstep) or retire if TS mapper remains the boundary. | `db/iceberg/spark/silver/silver_shiprocket_normalize.py` | **low** | S | no |
| **SR-9** | **Stale `gokwik.awb_status.v1` filter.** `silver_shipment_event` still filters on `gokwik.awb_status.v1`, which MEMORY records as a RETIRED gokwik event type (0117). Reconcile with the GoKwik reimplementation's new event type to avoid a dead/incorrect source filter. | `db/iceberg/spark/silver/silver_shipment_event.py` (L88-147) | **low** | S | no |
| **SR-10** | **No logistics observability UI.** Once flowing, surface shipment lifecycle health: connection/sync status, last webhook received, event-type counts, RTO/return funnel, NDR/exception list. Today the shipment-outcomes endpoint (`mv_silver_shipment`) exists but there's no connector-health surface to prove the connector works. | `apps/web` logistics/connector pages, `apps/core` shipment-outcomes endpoint | **medium** | M | **yes** |

---

## (d) Canonical-event target

**Extend, do not rebuild.** Keep `RTO_TERMINAL` / `DELIVERED_TERMINAL` / `OTHER_TERMINAL` / `none` **byte-identical** for GoKwik parity. Add:

1. **`shiprocket.shipment_status.v1`** (exists) — forward + terminal shipment lifecycle. Enumerate the forward states; add a non-terminal `EXCEPTION`/`NDR` class for `delayed`/`exception`; ensure `lost`/`destroyed` dedicated webhook pushes are admitted (SR-3), not just caught via repull.
2. **`shiprocket.return_status.v1`** (NEW) — `return.created/picked_up/delivered/completed`, classified to a new `RETURN_*` class. **Never** maps to DELIVERED (fixes the false-delivery bug, SR-4).

Both carry hashed `customer_phone`/`customer_email` + explicit merchant `order_id` (SR-6), AWB-hashed at the boundary, deterministic UUIDv5 dedup, and are `SERVER_TRUSTED`-admitted in `bronze_materialize.py` + `silver_collector_event.py`.

Spec → canonical coverage: 6 shipment events fully covered today; `created/pickup/picked_up/in_transit` partial (none-fallthrough); `lost/destroyed` partial (classed but topic-dropped); `delayed/exception` new; all 4 `return.*` new.

---

## (e) Phased build plan

**Phase 1 — Make it connectable + close the webhook (high priority).** SR-0 (connect flow + UI), SR-1 (resolver migration 0118), SR-2 (`webhook_secret` provisioning + per-tenant URL UI), SR-3 (widen allowlist). Exit: a brand can connect Shiprocket, webhooks resolve + verify + admit, repull already works. First real shipment data flows for Bodd Active.

**Phase 2 — Correctness: returns + lifecycle + identity (high/medium).** SR-4 (`shiprocket.return_status.v1` + `RETURN_*` class + `silver_return` mart — fixes the false-delivery bug), SR-5 (forward state machine + NDR class), SR-6 (hashed identity + merchant order_id). Exit: returns distinct from RTO/delivery; NDR/delays queryable; shipments link to customer 360.

**Phase 3 — Backfill + observability + cleanup (medium/low).** SR-7 (verify live client against real account + tracking-endpoint backfill + richer fixture), SR-10 (logistics/connector health UI), SR-8 (shadow-normalize decision), SR-9 (stale gokwik filter reconcile).

**Sequencing note:** SR-4 edits `silver_collector_event.py` + `bronze_materialize.py` — run AFTER the GoKwik reimplementation lands to avoid file conflicts on the shared admit-lists.
