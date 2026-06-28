# Shopflo Connector — Verification & Reimplementation Plan

**Reviewer:** Lead connector review (merged from 3 code-audit dimensions + 1 live diagnosis)
**Date:** 2026-06-27
**Verdict:** `major_gaps` — production-quality but ~15% spec coverage; checkout-signal-only, not an order source; live on zero brands.

---

## 1. Bottom line

**Is Shopflo correct vs the spec?** The one slice that exists is *correct* (HMAC fail-closed, bigint-minor money + `currency_code`, boundary PII hashing with per-brand salt, deterministic dedup, MT-1 brand authority from the connector row). **But it is not complete:** it implements **1 of ~14 spec events** — only `checkout_abandoned → shopflo.checkout_abandoned.v1`.

**What flows vs what's missing:**

- **Flows (code-correct):** `checkout_abandoned` → `shopflo.checkout_abandoned.v1` → `silver_checkout_signal` (`signal_type='checkout_abandoned'`, `source='shopflo'`). HMAC verify, money discipline, PII boundary hashing, brand resolution are sound.
- **Missing entirely:** the full **Order lifecycle** (`order.created/paid/failed/cancelled/refunded/fulfilled`), both **Payment** events (`payment.attempted/authorized`), and **3 of 4 Checkout** events (`started/step_completed/completed`). The strategy hard-skips them: `ShopfloWebhookStrategy.ts:80` — `if (eventName !== 'checkout_abandoned') return { ...skip: true }`. The mapper `@brain/shopflo-mapper` exports only `mapShopfloCheckoutAbandoned`.

**Checkout-signal-only or full order source?** **Checkout-signal-only.** This is the critical finding: `silver_order_state.py:184` reads only `event_type='order.live.v1'` (+ shiprocket), and `@brain/shopflo-mapper` is a *frozen allowlist* (`src/index.ts:10`) that cannot emit order canon. **Shopflo order revenue is invisible — it reaches neither `silver_order_state`, nor `silver_order_recognition`, nor the Gold revenue ledger.** As an order/conversion platform Shopflo contributes ZERO revenue truth.

**Live on any brand?** **No.** `connectors.connector_instance WHERE provider='shopflo'` → 0 rows (only gokwik/meta/shopify/woocommerce). `iceberg.brain_bronze.shopflo_checkout_raw` → 0 rows; zero `shopflo%` event_types in `collector_events`. `silver_shopflo_normalize.py:247-249` self-skips on the empty raw table. **All correctness claims are code-only and untested live.**

**Why the reimplementation is cheap:** Shopflo shares its checkout/payment/order Silver pipeline with **GoKwik**, which already covers the full lifecycle (`order.live.v1`, `checkout.abandoned.v1`, `gokwik.checkout_started/step.v1`, `payment.attempted/authorized.v1`). The canonical order/payment event names are **already in both `SERVER_TRUSTED` admit sets** (`bronze_materialize.py:122`, `silver_collector_event.py:77`) and `silver_order_state`/`silver_payment` already ingest them source-neutrally. So most of the work is **new Shopflo mapper functions + strategy branches emitting existing canonical names** — not new marts.

---

## 2. Findings table (critical → low, de-duped)

| # | Sev | Dimension | Issue | Fix | SHARED w/ GoKwik? |
|---|-----|-----------|-------|-----|-------------------|
| 1 | **critical** | Bronze→Silver→Gold | **Shopflo order revenue invisible.** No Shopflo lane in `silver_order_state.py:184` (reads only `order.live.v1`); frozen mapper (`shopflo-mapper/src/index.ts:10`) cannot emit order canon → never reaches Gold revenue ledger. | Add `mapShopfloOrder` emitting **`order.live.v1`** (`source='shopflo'`). `order.live.v1` already in `SERVER_TRUSTED` + `silver_order_state` ingests source-neutrally → **zero Silver change.** | **SHARED** (reuse order lane; mapper SHOPFLO-ONLY) |
| 2 | high | Event coverage / Connect | **Order lifecycle missing** (`created/paid/failed/cancelled/refunded/fulfilled`). Strategy hard-skips (`ShopfloWebhookStrategy.ts:80`); only `mapShopfloCheckoutAbandoned` exists. GoKwik routes `t.startsWith('order')→mapGokwikOrder→order.live.v1` (`GokwikWebhookStrategy.ts:120`). | Map order events → `order.live.v1`; `order.refunded→refund.recorded.v1`; `order.fulfilled→fulfillment.recorded.v1`. All already admitted. | **SHARED** (canon + lanes); mapper SHOPFLO-ONLY |
| 3 | high | Event coverage / Live | **Payment events missing** (`attempted/authorized`). No payment branch/mapper. GoKwik: `GokwikWebhookStrategy.ts:147 → mapGokwikPayment → payment.attempted/authorized.v1`. | Add `mapShopfloPayment` → `payment.attempted.v1`/`payment.authorized.v1` (already admitted; `silver_payment.py:54` admits them). | **SHARED** (canon + lane); mapper SHOPFLO-ONLY |
| 4 | high | Bronze→Silver | **`silver_payment` source mislabel.** `silver_payment.py:147` hardcodes `lit('gokwik').alias('source')`; generic `payment.*.v1` names can't carry 2 sources via `event_type` alone. | Add a `source` discriminant (`payload.properties.source` or namespaced type); branch the source tag instead of hardcoding `'gokwik'`. | **SHARED** (must fix once for both) |
| 5 | high | Bronze→Silver | **`silver_checkout_signal` source mislabel** — `:133` hardcodes `'gokwik'` for `checkout.abandoned.v1`; started/step slots are gokwik-namespaced. | Same `source` discriminant; add shopflo `started/step/completed` `signal_type` CASE blocks mirroring gokwik pattern. | **SHARED** (discriminant); shopflo CASE blocks SHOPFLO-ONLY |
| 6 | high | Event coverage / Connect | **Checkout funnel incomplete** — only `abandoned`; no `started/step_completed/completed`. `checkout.completed` has no canonical event anywhere (GoKwik doesn't emit it either). | Add `shopflo.checkout_started.v1`/`shopflo.checkout_step.v1` (or source-neutral); admit to BOTH `SERVER_TRUSTED` sets byte-identical. Map `checkout.completed → order.live.v1` (design explicitly). | **SHARED-shaped** (pattern); new types SHOPFLO-ONLY |
| 7 | high | Connect / backfill | **No REST backfill** — webhook-only; cold-start brand has zero history. `list_shopflo_connectors()` seam (`0030:149-179`) exists but unconsumed; spec mandates REST backfill + DLQ. | Add cursor-paginated idempotent backfill off `list_shopflo_connectors()` re-emitting SAME canonical events through SAME mappers. Confirm DLQ. | **SHARED gap** (GoKwik also lacks); Shopflo client SHOPFLO-ONLY |
| 8 | high | Bronze→Silver | **`silver_shopflo_normalize` writes to SHADOW table by default** (`:72-74` `silver_collector_event_shopflo_shadow`), skip-guarded on empty raw, absent from `v4-refresh-loop.sh` → even abandoned canon may never reach the live mart. | Resolve normalization boundary (see Phase 0); cut to live `silver_collector_event` or commit to webhook-time TS mapping; add to refresh loop. | SHOPFLO-ONLY |
| 9 | high | Event coverage | **Attribution-blind** — `utm_params`, `referrer`, `discount_code` dropped even in the handled event. `ShopfloCheckoutProperties` (`shopflo-mapper:88-105`) lacks these fields; allowlist (`:238-255`) never copies them. Violates "Journey before attribution". | Extend properties + every new mapper with `utm_params`/`referrer`/`discount_code` (non-PII, pass allowlist directly). Thread `checkout_session_id` through normalize + signal projection. | SHOPFLO-ONLY (but mirror GoKwik mapper) |
| 10 | medium | Strategy / Live | **Idempotency window 5–10 min, not 24h.** `ShopfloWebhookStrategy.ts:27` `SHOPFLO_REPLAY_WINDOW_SECONDS=5*60`; `RedisDedupAdapter.ts:17` `DEDUP_TTL=10*60`. Spec: 24h on `(order_id/checkout_session_id+event_type)`. | Decouple: 24h Redis idempotency key on `(id+event_type)`; widen/remove the tight 5-min age-reject. Or ratify deterministic `event_id`+Bronze MERGE as the authoritative 24h layer. Apply uniformly. | **SHARED** (same `RedisDedupAdapter`) |
| 11 | medium | HMAC | **HMAC scheme is undocumented Razorpay-mirror default**, never verified vs real Shopflo signatures (`ShopfloHmac.ts:8-14,60`; header `x-shopflo-signature`). Verification itself is correct/fail-closed. | Confirm Shopflo's real signing scheme (header/encoding/timestamp+body) before go-live; add golden-vector test with a real sample. | SHOPFLO-ONLY |
| 12 | medium | Mapper | **Frozen single-event mapper is the upstream blocker** (`shopflo-mapper/src/index.ts:10,28`). | Extend mapper to full spec event set with same boundary contract. | SHOPFLO-ONLY |
| 13 | medium | Naming | **Convention divergence** — Shopflo abandoned = `shopflo.checkout_abandoned.v1` (namespaced) vs GoKwik `checkout.abandoned.v1` (source-neutral). | Prefer source-neutral canonical + `source` column. If keeping namespaced for back-compat, document it; never route Shopflo through `gokwik.*` types. | **SHARED** (convention) |
| 14 | low | Dead code | **Orphaned `shopfloWebhookHandler.ts`** registers the same `/api/v1/webhooks/shopflo` path (`:90`), unwired (only dist + tests reference). Duplicates HMAC/replay; will drift. | Delete it + its dead-path-only test; single source of truth = `ShopfloWebhookStrategy`. | SHOPFLO-ONLY |
| 15 | low | Spec wording | `event_id` is deterministic sha-shaped UUID, not UUIDv7 (`shopflo-mapper:123-129`). | No code change — deterministic id is *stronger* for idempotency. Reconcile spec wording; carry namespaced-seed per event type. | SHOPFLO-ONLY |
| — | info | All | **Keep verbatim:** `moneyToMinorString` (bigint-minor, no `parseFloat`, `:140-161`) + `currency_code`; boundary PII hash + raw drop (`:211-225`); MT-1 brand from connector row; connect/resolver/secret plumbing correct (`webhook_secret` provisioned at connect via required authField — **no fail-closed gap**). | Reuse as the template for every new mapper. | mixed |

---

## 3. Reimplementation plan (phased, EXTEND-not-rebuild)

Guiding principle: **emit existing GoKwik canonical event names wherever identical**, so the Silver/Gold marts need zero or additive change. Reuse the GoKwik webhook-first reimplementation as the template (`docs/architecture/gokwik-connector-reimplementation.md`). Mark each item **SHARED** (do once with GoKwik) or **SHOPFLO-ONLY**.

### Phase 0 — Decide the two cross-cutting seams first (blocking)
- **[SHARED] Source discriminant.** Generic `payment.*.v1` and `checkout.abandoned.v1` cannot carry two sources via `event_type` alone (findings #4, #5). Decide: `payload.properties.source` field (preferred) vs namespaced types. This decision drives `silver_payment.py:147` and `silver_checkout_signal.py:133` branching.
- **[SHOPFLO-ONLY] Normalization boundary.** Resolve the live-TS-mapping vs Spark-raw-normalize split (finding #8). Recommended: **commit to webhook-time TS mapping** (matches the working abandoned slice and GoKwik); then `silver_shopflo_normalize.py` becomes the cutover target only if raw-landing G1 feeds it. Do not build the lifecycle twice.
- **[SHARED] Idempotency policy.** Ratify 24h dedup on `(id+event_type)` vs deterministic-`event_id`+Bronze-MERGE-as-authority (finding #10), applied uniformly across `RedisDedupAdapter`.

### Phase 1 — Mapper expansion (`packages/shopflo-mapper/src/index.ts`)
- **[SHOPFLO-ONLY] `mapShopfloOrder`** → emits `order.live.v1` (`source='shopflo'`), mirroring `mapGokwikOrder` (reuses `@brain/shopify-mapper` `OrderProperties`/`ORDER_LIVE_V1_EVENT_NAME`). Also map `order.refunded→refund.recorded.v1`, `order.fulfilled→fulfillment.recorded.v1`. *(findings #1, #2)*
- **[SHOPFLO-ONLY] `mapShopfloPayment`** → `payment.attempted.v1`/`payment.authorized.v1`. *(finding #3)*
- **[SHOPFLO-ONLY] `mapShopfloCheckoutStarted` / `mapShopfloCheckoutStep`** → `shopflo.checkout_started.v1`/`shopflo.checkout_step.v1` (or source-neutral per Phase 0). `checkout.completed` → `order.live.v1`. *(finding #6)*
- **[SHOPFLO-ONLY] Extend `ShopfloCheckoutProperties` + all new mappers** with `utm_params`, `referrer`, `discount_code`, `checkout_session_id`. *(finding #9)*
- **Reuse verbatim:** `moneyToMinorString` (bigint-minor + `currency_code` on every order/payment/refund amount), `hashIdentifier`/`normalizePhone` boundary hashing, namespaced deterministic `event_id` seed per event type. *(info)*

### Phase 2 — Strategy dispatch (`apps/core/.../webhooks/strategies/ShopfloWebhookStrategy.ts`)
- **[SHOPFLO-ONLY]** Replace the single `if (eventName !== 'checkout_abandoned')` skip (`:80`) with a **per-event dispatch table** mirroring `GokwikWebhookStrategy` (`t.startsWith('order')`, `t.includes('payment')`, checkout branches). *(findings #2, #3, #6)*
- **[SHARED]** Apply the Phase-0 idempotency decision (`:27`). *(finding #10)*

### Phase 3 — Admit sets (do **once**, byte-identical in both files)
- **[SHARED] Already admitted (no change):** `order.live.v1`, `refund.recorded.v1`, `fulfillment.recorded.v1`, `payment.attempted.v1`, `payment.authorized.v1` — present in `bronze_materialize.py:122` (SERVER_TRUSTED_BRONZE) and `silver_collector_event.py:77` (SERVER_TRUSTED). *(findings #1–#3)*
- **[SHOPFLO-ONLY] New entries:** add `shopflo.checkout_started.v1`, `shopflo.checkout_step.v1` (if namespaced route chosen) to **both** files, kept byte-identical. *(finding #6)*

### Phase 4 — Silver marts (mostly additive / discriminant)
- **[SHARED — zero change]** `silver_order_state.py:184` ingests `order.live.v1` source-neutrally → Shopflo orders flow to `silver_order_recognition` → **Gold revenue ledger** automatically. *(finding #1)*
- **[SHARED — fix once]** `silver_payment.py:147` and `silver_checkout_signal.py:133`: replace hardcoded `lit('gokwik')` with the Phase-0 `source` discriminant. *(findings #4, #5)*
- **[SHOPFLO-ONLY]** Add shopflo `started/step/completed` `signal_type` CASE blocks in `silver_checkout_signal.py`; thread `utm_params`/`referrer`/`checkout_session_id` through normalize port + projection. *(findings #6, #9)*
- **[SHOPFLO-ONLY]** Per Phase-0: cut `silver_shopflo_normalize.py` off the shadow target and add to `tools/dev/v4-refresh-loop.sh`, OR retire it if committing to webhook-time TS mapping. *(finding #8)*

### Phase 5 — REST backfill + DLQ
- **[SHARED gap, SHOPFLO-specific client]** Add a cursor-paginated, idempotent REST backfill driven off `list_shopflo_connectors()` (`0030:149-179`): enumerate connected shopflo connectors → fetch `api_token` from the secret bundle → page Shopflo orders/checkouts → re-emit the **same canonical events through the same mappers/dedup** so backfill and live converge on identical Bronze keys. Persist `connector_cursor`. Confirm a DLQ for poison webhooks. *(finding #7)*

### Phase 6 — Cleanup, HMAC verification, live smoke
- **[SHOPFLO-ONLY]** Delete orphaned `shopfloWebhookHandler.ts` + its dead-path test (finding #14).
- **[SHOPFLO-ONLY]** Confirm Shopflo's real HMAC scheme (header/encoding/timestamp+body); add a golden-vector test with a real sample (finding #11).
- **[SHOPFLO-ONLY]** Reconcile spec wording: `event_id` is deterministic-derived by design, not UUIDv7 (finding #15).
- **[SHOPFLO-ONLY] Live smoke test** (nothing has ever flowed): connect Shopflo on one dev brand via `ConnectShopfloCommand`, POST a signed HMAC webhook per event type to `/api/v1/webhooks/shopflo`, assert rows land in `collector_events` → `silver_order_state`/`silver_payment`/`silver_checkout_signal` → Gold revenue. *(live finding)*

### Preserve (do not touch)
Connect/resolver/secret plumbing is correct: `ConnectShopfloCommand.ts` persists `connector_instance` + `sync_status`; `webhook_secret` provisioned at connect via required authField (no fail-closed gap); `resolve_shopflo_connector_by_merchant` (`0030:125`, SECURITY DEFINER, MT-1 brand from row). Money discipline and boundary PII handling are the template for all new mappers.

---

### SHARED-with-GoKwik summary (done once)
1. Source discriminant in `silver_payment.py` + `silver_checkout_signal.py` (replace hardcoded `'gokwik'`).
2. 24h idempotency policy in the shared `RedisDedupAdapter`.
3. Naming convention (source-neutral canonical + `source` column).
4. REST backfill + DLQ pattern (both connectors currently webhook-only).
5. Reuse of `order.live.v1` / `payment.*.v1` / `refund.recorded.v1` / `fulfillment.recorded.v1` canon + the `silver_order_state`→`silver_order_recognition`→Gold lane (already source-neutral, **zero change**).

### SHOPFLO-ONLY
Mapper functions (order/payment/checkout-funnel), strategy dispatch table, new `shopflo.checkout_*` admit entries, `silver_shopflo_normalize` boundary resolution, utm/referrer/discount/session threading, Shopflo REST client, HMAC scheme verification, dead-handler deletion, live smoke.
