# 05 — Architecture Plan (Stage 2, BINDING) — feat-razorpay-settlement-connector

**Stage:** 2 · **Architect** · **Verdict:** ADVANCE → builders (Stage 3)
**Paradigm:** tier-0 deterministic ($0/mo incremental — pure Kafka produce/consume + Postgres inserts + Razorpay REST + HMAC + sha256 hashing + Redis SET NX. NO LLM/ML/model path anywhere. Reconciliation is a deterministic join + signed-sum. Cost-routing gate: PASS — a model call here would be a paradigm-bypass.)
**Scope:** ONE slice, NO new deployable. Webhook receiver in `apps/core`; settlement re-pull as a `stream-worker` job; `SettlementLedgerConsumer` in `stream-worker`; one new workspace package `@brain/razorpay-mapper`; one additive migration `0027`. Reuses the SHIPPED Shopify-live connector pattern end-to-end.

This plan resolves all 13 binding decisions (MB-1..MB-7 + C1..C6). Every seam below is bound with a one-line ADR.

---

## 0. Reuse-first inventory (Single-Primitive sweep — CLEAN, extend-only)

Grepped the SHIPPED Shopify-live connector (merged to master). Reused verbatim or extended — **nothing forked**:

| Primitive | Source `file:line` | How Razorpay reuses it |
|---|---|---|
| Boundary-hash + uuidv5-shaped mapper pkg | `packages/shopify-mapper/src/index.ts:123` (`hashToUuidShaped`), `:151/:167` (seeds) | NEW sibling pkg `@brain/razorpay-mapper` — copies the `hashToUuidShaped` algorithm + `decimalStringToMinor`; adds settlement seeds + field allowlist + `utr_hash`/`payment_id_hash` |
| SECURITY DEFINER enumeration fn + 3 assertion DO-blocks | `db/migrations/0026_live_connector_security_definer_fns.sql:46-132` | `0027` mirrors EXACTLY for `list_razorpay_connectors_for_settlement_repull()` (multi-resource) |
| Re-pull job (enumerate → GUC-after → overlap-lock → cursor → live-lane emit) | `apps/stream-worker/src/jobs/shopify-repull/run.ts:80-310` | New `jobs/razorpay-settlement-repull/run.ts` — same skeleton, **multi-cursor** loop (3 resources) |
| Overlap-lock `FOR UPDATE SKIP LOCKED` on `connector_cursor` | `shopify-repull/run.ts:323-379` | Reused verbatim, locked PER cursor resource |
| Ledger feed (`writeProvisionalRecognition`/`writeReversal`, GUC-first, `ON CONFLICT DO NOTHING`) | `apps/stream-worker/src/infrastructure/pg/LedgerWriter.ts:77/:173` | EXTENDED: new `writeSettlementFinalization()` + `writeFeeLines()` + `writeBrandLevelSettlement()` (same class, same dedup discipline) |
| Live-lane consumer wired in `main.ts` (filter event_name → route → ledger) | `LiveLedgerBridgeConsumer.ts:42`, `main.ts:101-149` | NEW `SettlementLedgerConsumer` mirrors it; **wired in `main.ts` identically (MB-4)** |
| HMAC-first webhook receiver (raw-body, SECURITY DEFINER brand resolve, brand from ROW not body) | `shopifyWebhookHandler.ts:74-285` | NEW `razorpayWebhookHandler.ts` — same security order + adds replay protection (C3) + map-table populate (MB-1) |
| Disconnect flow (mark disconnected + delete secret + emit) | `DisconnectCommand.ts:37-71` | EXTENDED for 3-cred + webhook deregister (C2) |
| `connector_cursor` (upsert key `(brand_id, ci_id, resource)`) | `db/migrations/0006_connector.sql:82-91` | Reused; 3 new `resource` VALUES (no schema change to the table — C6 rides existing columns) |
| `realized_revenue_ledger` (dual-date, event_type CHECK, append-only GRANT, currency trigger, dedup unique idx) | `db/migrations/0018_realized_revenue_ledger.sql:61-104` | EXTENDED in `0027`: ADD event_type CHECK values + `reconciliation_type` + `tax_code` + `fee_minor` cols; **fix dedup index for brand_level rows** |
| FROZEN lifecycle fixtures + `assertBrainApp` | `apps/stream-worker/src/tests/helpers/connector-lifecycle-fixtures.ts:274` | Reused in every isolation test (dual-pool, `c07ec701`/`c07ec702` brands) |
| `connector_sync_status` touch + state machine | `shopify-repull/run.ts:445`, `shopifyWebhookHandler.ts:296` | Reused verbatim |
| `pan-cvv-column-lint` / nightly log-grep gates | Canon `COMPLIANCE.md:158/:172`, eslint-rule home `tools/eslint-rules/` | EXTENDED (C4/C5) |

**Single-Primitive verdict: CLEAN.** New artifacts: 1 package, 1 migration, 1 webhook wire, 1 re-pull job, 1 consumer, 3 LedgerWriter methods, 2 lint-gate extensions. No new deployable, no new lane, no new topic, no per-channel fork.

**Dependency gate (from synthesis §5):** `feat-shopify-live-connector` is SHIPPED/merged to master (confirmed — `@brain/shopify-mapper` and `0026` are on master). The conditional is satisfied; builders may import the patterns.

---

## 1. Seam bindings (one-line ADR each)

### ADR-RZ-1 — `@brain/razorpay-mapper` (C1 + C4 + MB-2) [data-engineer, A0 FROZEN, FIRST COMMIT]
A NEW workspace package `packages/razorpay-mapper` (mirror `@brain/money` / `@brain/shopify-mapper` — real dual-imported pkg consumed by both `apps/core` webhook and `apps/stream-worker` re-pull), exporting: `mapSettlementItemToEvent()`, `mapPaymentWebhookToMapRow()`, `hashRazorpayId()` (= `sha256(per-brand-salt ‖ normalized_value)` reusing `hashToUuidShaped`'s digest discipline from shopify-mapper:123), `RAZORPAY_FIELD_ALLOWLIST`, and the uuidv5 seed fns below. It (a) hashes `utr→utr_hash` and `payment_id→payment_id_hash` BEFORE any Bronze write; (b) applies a HARD field **allowlist** `{settlement_id, payment_id, order_id, amount, fee, tax, utr, status, created_at, settled_at, currency, entity_type}` — every other field, including all `card.*`, is dropped at the boundary; (c) NEVER logs raw values at any level; (d) raw IDs exist only in-memory in this layer and are dropped after hashing. **`settlement_id` PII assessment (C1.2):** `settlement_id` identifies a settlement BATCH, not a payment → NOT linkable to a natural person → stored as an opaque operational reference (un-hashed) in Bronze/ledger; documented as a PII-data-catalog entry in the dev guide. **`razorpay_payment_id` raw** is carried ONLY in the `connector_razorpay_order_map` table (internal join use, RLS-protected) — never in Bronze events, ledger, or logs.

### ADR-RZ-2 — uuidv5 settlement seeds (MB-2, FINALIZED) [in `@brain/razorpay-mapper`]
Three seed fns, all via `hashToUuidShaped`:
- `uuidV5FromSettlementItem(brandId, settlementId, paymentId, entityType)` = `sha256(\`${brandId}:${settlementId}:${paymentId}:${entityType}:settlement.live.v1\`)` — `entityType ∈ {payment, refund, adjustment, reserve_deduction}`. The `entityType` discriminator is what prevents corrections (same `settlement_id`, different entity) from collapsing.
- `uuidV5FromSettlementSummary(brandId, settlementId)` = `sha256(\`${brandId}:${settlementId}:summary:settlement.live.v1\`)` — brand-level events (reserve releases, adjustment batches) use the literal `:summary:` token in place of `paymentId`.
- `uuidV5FromRazorpayWebhook(brandId, razorpayWebhookEventId)` = `sha256(\`${brandId}:${razorpayWebhookEventId}:settlement.webhook.v1\`)`.
All three are **provably non-colliding** with `order.live.v1` / `order.backfill.v1` (distinct namespace suffix). Bronze `ON CONFLICT DO NOTHING` unchanged.

### ADR-RZ-3 — migration `0027` (MB-1 table + MB-3 ledger cols + MB-5 fn + C6 cursors) [data-engineer]
ADDITIVE ONLY (`CREATE TABLE IF NOT EXISTS`, `ALTER … ADD COLUMN IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`). Latest is `0026`. Four parts:

**(a) `connector_razorpay_order_map` (MB-1):**
```
connector_razorpay_order_map(
  brand_id              UUID NOT NULL,        -- RLS anchor (I-S01)
  razorpay_order_id     TEXT NULL,            -- order_XXXX (Razorpay-native; NULL for order-keyless)
  shopify_order_id      TEXT NOT NULL,        -- the Brain ledger spine key
  razorpay_payment_id   TEXT NOT NULL,        -- raw Razorpay payment id (internal join only; never Bronze)
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (brand_id, razorpay_payment_id))
-- indexes: (brand_id, razorpay_payment_id), (brand_id, razorpay_order_id)
-- ENABLE + FORCE RLS; two-arg fail-closed policy (copy 0018:111-117 exactly)
-- GRANT SELECT, INSERT, UPDATE TO brain_app (webhook upserts on re-delivery; NOT append-only — it's a lookup table)
```
**(b) `realized_revenue_ledger` additive ALTERs (MB-3 + MB-7):**
- Extend the `event_type` CHECK to ADD: `settlement_finalization`, `payment_fee`, `settlement_tax`, `rolling_reserve_deduction`, `rolling_reserve_release`, `settlement_reversal`, `settlement_adjustment`. (Drop+recreate the CHECK constraint additively; keeps all existing values.)
- `ADD COLUMN IF NOT EXISTS reconciliation_type TEXT NULL CHECK (reconciliation_type IN ('per_order','brand_level'))`.
- `ADD COLUMN IF NOT EXISTS tax_code TEXT NULL` (carries `'GST_18'` on `settlement_tax` rows for ITC reconciliation).
- `ADD COLUMN IF NOT EXISTS fee_minor BIGINT NULL` — optional; **net realized math uses signed `amount_minor` rows, not this column** (kept for analytics provenance; no-float assertion already covers `%_minor`).
- **Dedup-index fix for brand_level rows (DISCOVERED GAP):** the existing dedup unique index `realized_revenue_ledger_dedup` keys on `order_id` (0018:103). Brand-level rows (reserve releases, adjustments) have NO Shopify `order_id`. Bind: brand_level rows use `order_id = '__brand_level__:' || settlement_id` as a synthetic spine key so they dedup correctly AND never collide with a real order; the existing unique index stays valid. `economic_effective_at = settlement date`; `billing_posted_period = current OPEN period if the natural period is closed` (MB-7 — late reserve releases/chargebacks ALWAYS post forward; `realized_gmv_as_of` already excludes only `provisional_recognition`, so all settlement event_types correctly net).
**(c) `list_razorpay_connectors_for_settlement_repull()` (MB-5):** SECURITY DEFINER, `LANGUAGE sql STABLE`, `SET search_path = public`, owner = migration superuser, `GRANT EXECUTE TO brain_app`; returns dispatch-only cols `(connector_instance_id, brand_id, secret_ref)` for `provider='razorpay' AND status='connected'`. Mirror the 3 assertion DO-blocks from `0026:72-132` (prosecdef=true, search_path=public, EXECUTE granted) with `SEC-RZ-0027` guard ids. **Per the BINDING durable rule `system-job-force-rls-enumeration`** — this is a cross-tenant system job over a FORCE-RLS table. (The fn dispatches connector identity; the re-pull job derives all 3 cursor states per brand by reading `connector_cursor` AFTER the GUC is set — see ADR-RZ-5.)
**(d) Multi-cursor (C6):** NO schema change to `connector_cursor` — the 3 cursors are 3 `resource` VALUES (`settlements.payments`, `settlements.reserves`, `settlements.adjustments`) on the existing `(brand_id, ci_id, resource)` upsert key (0006:91). 3 rows/brand, created lazily by the re-pull job's upsert-if-absent (same as `orders.repull`).

### ADR-RZ-4 — Razorpay settlements API client (reuse paged-client) [data-engineer]
`jobs/razorpay-settlement-repull/razorpay-settlements-client.ts` — mirror `shopify-live-client.ts` (paged, rate-limit-aware: Razorpay `429` → `Retry-After`; auth via `key_id:key_secret` Basic). `fetchSettlementsPage(from, to, skip)` for `/v1/settlements` + `/v1/settlements/recon/combined` (the per-payment breakdown). Returns raw items; the mapper applies the allowlist + hashing. NEVER logs the response body (C5).

### ADR-RZ-5 — settlement re-pull job (multi-cursor, overlap-lock, live-lane emit) [data-engineer, MB-1 join NOT here]
`jobs/razorpay-settlement-repull/run.ts` — mirror `shopify-repull/run.ts:80-310`: enumerate via `list_razorpay_connectors_for_settlement_repull()` (no GUC at enumerate) → per connector, `set_config('app.current_brand_id', …, true)` from the fn result (MT-1) BEFORE any brand read → for EACH of the 3 cursor resources: acquire `FOR UPDATE SKIP LOCKED` overlap-lock on that resource's `connector_cursor` row, read the window (payments=30d, reserves=180d, adjustments=90d), page the client, map each item to `settlement.live.v1` (or `:summary:` for order-keyless), emit to the live lane `{env}.collector.event.v1`, advance that cursor's high-water. `connector_sync_status`: `syncing` at start, `connected`+`last_sync_at` on done. **The re-pull does NOT do the ledger join — it only lands settlement events on the live lane.** The two-hop join + finalization is the consumer's job (ADR-RZ-6). NO raw PII / no raw IDs in events or logs.

### ADR-RZ-6 — `SettlementLedgerConsumer` (net-of-fees finalization + two-hop join + order-keyless + WIRED) [data-engineer, MB-1 + MB-3 + MB-4]
NEW `interfaces/consumers/SettlementLedgerConsumer.ts` — mirror `LiveLedgerBridgeConsumer.ts:42` (separate consumer group `settlement-ledger-bridge` on the SAME live topic; filter `event_name === 'settlement.live.v1'`, else commit+skip; `autoCommit=false`, commit only after ledger write; MAX_RETRY=5 → DLQ). Per event:
1. **Two-hop join (MB-1):** resolve `razorpay_payment_id → connector_razorpay_order_map → shopify_order_id` (and if `razorpay_order_id` present, the two-hop `payment_id → razorpay_order_id → shopify_order_id` is satisfied by the same row). NEVER attempt a direct `settlement.order_id → ledger.order_id` join.
2. **Unmatched policy (MB-1.3):** no map row → PARK (do NOT drop, do NOT crash). Emit metric `settlement_unmatched_count{brand_id, reason}`. Retry after a hold window (15-min retry / 24-h escalation for unmatched; 2-h retry / 6-h escalation for late-arrival). After escalation with no match → write an `UNMATCHED` Bronze row for manual reconciliation + fire alert. No silent no-op.
3. **`reconciliation_type='per_order'`** events write, via `LedgerWriter`, the net-of-fees rows: `+settlement_finalization` (settled_amount), `−payment_fee` (MDR), `−settlement_tax` (`tax_code='GST_18'`, SEPARATE from fee), `−rolling_reserve_deduction`, `−settlement_reversal` (refund/chargeback). All keyed to the resolved `shopify_order_id`. The provisional sale row is UNTOUCHED (append-only); the signed-sum nets to realized-net.
4. **`reconciliation_type='brand_level'`** events (`rolling_reserve_release` `+`, `settlement_adjustment` `±`) take the **order-keyless path**: no order join; write against the synthetic `order_id = '__brand_level__:' || settlement_id` spine key (ADR-RZ-3.b).
5. **Row-sign / net binding (MB-3):** `settlement_finalization` `+`, `payment_fee` `−`, `settlement_tax` `−`, `rolling_reserve_deduction` `−`, `rolling_reserve_release` `+`, `settlement_reversal` `−`, `settlement_adjustment` `±`. The realized number = signed-sum over all non-`provisional_recognition` rows (`realized_gmv_as_of` unchanged).
6. **WIRED into `main.ts` (MB-4 — NON-NEGOTIABLE):** import + instantiate (`new SettlementLedgerConsumer(kafka, ledgerWriter, mapRepo, topic, group)`) + `await consumer.start()` + `consumer.stop()` in the shutdown `Promise.all`. This is the **wired-to-nothing occurrence #3** watch — leaving it unwired triggers the reviewer durable-rule proposal. A MANDATORY e2e wiring test (real Redpanda produce `settlement.live.v1` → consumer observes → ledger row asserted) is a CI gate, not best-effort.

### ADR-RZ-7 — Razorpay webhook receiver (HMAC-first + replay + 3-cred + map-table populate) [backend-developer, MB-1 prereq + C2 + C3]
NEW `apps/core/src/modules/connector/sources/payment/razorpay/interfaces/webhooks/razorpayWebhookHandler.ts` (the `payment/` source dir is currently empty `.gitkeep`-only — this is its first tenant). Registered at `POST /api/v1/webhooks/razorpay`. Security order (immovable, mirror `shopifyWebhookHandler.ts:74`):
1. **HMAC-first (NN-4):** validate `X-Razorpay-Signature` = `HMAC-SHA256(rawBody, webhook_secret)` over the RAW body as the ABSOLUTE first op → invalid/missing = 401, no processing, no write.
2. **Replay protection (C3, BEFORE Bronze):** (a) reject if `event.created_at` older than a 5-min configurable window → 400, log hashed event ref only; (b) Redis `SET NX EX 600` on the Razorpay `event_id` — already-present = reject (security control, separate from Bronze data-correctness dedup). Reuse the `RedisDedupAdapter` primitive.
3. **Brand resolution via SECURITY DEFINER (MT-1):** resolve the connector from the Razorpay `account_id`/`key_id` mapping asserted from `connector_instance` (NEW SECURITY DEFINER fn `resolve_razorpay_connector_by_account(p_account_id)` in `0027`, dispatch-only cols) — brand_id from the ROW, NEVER the webhook body. No connector → 401.
4. **`payment.captured` → MAP-TABLE POPULATE (MB-1, the HARD prerequisite):** upsert `connector_razorpay_order_map(brand_id, razorpay_order_id, shopify_order_id, razorpay_payment_id)` under brand GUC. `shopify_order_id` comes from the payment's notes/order metadata (Razorpay `notes.shopify_order_id` or the `order_id` reference the storefront set at checkout). This MUST run before settlements arrive — it is the join's only source of truth.
5. Other events (`settlement.processed`, `refund.created`, `payment.failed`) → map via `@brain/razorpay-mapper` (allowlist + hash) → emit `settlement.live.v1` / `settlement.webhook.v1` to the live lane → touch `connector_sync_status`. 200 fast-ack.
Dev-honesty: real public ingress is a platform follow-up; proven with synthetic HMAC-signed POSTs (same honesty boundary as Shopify).

### ADR-RZ-8 — connect / 3-cred secret / disconnect (C2) [backend-developer]
Connect reuses the marketplace credential-connector tile (`provider='razorpay'`). Store all 3 creds as ONE composite JSON bundle `{key_id, key_secret, webhook_secret}` under a single `secret_ref` per `connector_instance` (mirror Shopify `secret_ref`). `webhook_secret` is independently rotatable — a rotation path that updates ONLY the `webhook_secret` key in Secrets Manager without touching `key_id`/`key_secret` (revocation SLA target < 5 min, documented). **Disconnect EXTENDS `DisconnectCommand.ts:37`** to: (a) call Razorpay API to deregister the webhook endpoint registration; (b) invalidate the `secret_ref` in Secrets Manager (existing `deleteSecret`); (c) `status='disconnected'` + halt all processing. No silent disconnect with live secrets. Test: delete the Secrets Manager secret → connector marks disconnected, webhook processing halts within N seconds.

### ADR-RZ-9 — sync_status + dashboard gross→net surface [frontend-web-developer]
Reuse `connector_sync_status` (state machine + `last_sync_at`) for settlement sync. Frontend: (a) a Razorpay connection tile/health in the connector marketplace (mirror the Shopify tile); (b) the dashboard realized-revenue number gains a gross→net indicator — as settlements land, the figure shifts from "Gross Revenue (ex-fees)" toward net-of-fees, with a tooltip explaining the settlement-lag (reserve releases post forward 90–180d — MB-7). Business logic stays server-side (BFF/metric-engine); the tile only renders state.

### ADR-RZ-10 — lint/log-grep gate extensions (C4 + C5) [cross-cutting → data-engineer, same commit as mapper]
Same-commit (not a follow-up ticket): (a) extend `pan-cvv-column-lint` (Canon `COMPLIANCE.md:158`; eslint-rule home `tools/eslint-rules/`) to fail on column/field names `card_last4, card_network, card_brand, card_issuer, card_international, card_type, card_country`; (b) extend the nightly log-grep gate with patterns `pay_[A-Za-z0-9]{14}`, `setl_[A-Za-z0-9]{10}`, `UTR[0-9]{16,22}`; (c) a CI test feeding a Razorpay API fixture WITH card-network fields and asserting the emitted Bronze event contains NONE of them. These are mandatory CI gates.

---

## 2. Smallest safe slice

**ONE slice, NO new deployable** (confirmed against synthesis §3 and requirement constraint "no NEW deployable"). Prerequisite ordering WITHIN the slice: **`payment.captured` map-table population (ADR-RZ-7.4) is a HARD prerequisite** — without it the consumer produces zero correctly-reconciled rows. A0 (`@brain/razorpay-mapper` FROZEN) + `0027` migration land FIRST and unblock all tracks.

**Graceful degradation (explicit):** unmatched settlement → PARK + retry + alert (never drop, never crash). Late-arrival → longer park window. Order-keyless → brand-level path. These are required behaviors, not edge cases.

**Required in this slice (M1):** map-table + `payment.captured` populate; two-hop-join consumer WIRED; `settlement_finalization` / `payment_fee` / `settlement_tax` / `settlement_reversal`; `rolling_reserve_deduction` + `rolling_reserve_release` (schema + basic consumer logic); multi-cursor schema (all 3 cursor resources, payments active first); `@brain/razorpay-mapper` boundary-hash; card-field allowlist + lint + test; webhook replay protection; 3-cred disconnect; log-grep extension.
**Fast-follow within the same slice (2nd commit, same branch):** `rolling_reserve_release` order-keyless consumer handling; `settlements.reserves` + `settlements.adjustments` polling; `settlement_adjustment` consumer logic.
**Migrations additive only.** Rollback: `DROP TABLE connector_razorpay_order_map; DROP FUNCTION list_razorpay_connectors_for_settlement_repull(), resolve_razorpay_connector_by_account(text);` + the ledger ADD COLUMNs are nullable/additive (ledger rebuildable from Bronze in M1).

---

## 3. BUILD TRACKS (parallel, COMMIT-PER-SLICE)

> Commit per slice — a prior Stage-8 agent lost uncommitted work to an infra timeout. Only committed work survives. Branch `feat/razorpay-settlement-connector` off master HEAD.

### Track A — @data-engineer (LEAD; owns A0 + the money/join path)
**Scope:** `@brain/razorpay-mapper`, `0027`, settlements API client, multi-cursor re-pull job, `SettlementLedgerConsumer` (two-hop join + net-of-fees + order-keyless), WIRE into `main.ts`, the e2e wiring test, lint/log-grep extensions.
**Files/artifacts:** `packages/razorpay-mapper/src/index.ts` (NEW); `db/migrations/0027_razorpay_settlement.sql` (NEW); `apps/stream-worker/src/jobs/razorpay-settlement-repull/{run.ts,razorpay-settlements-client.ts}` (NEW); `apps/stream-worker/src/interfaces/consumers/SettlementLedgerConsumer.ts` (NEW); `apps/stream-worker/src/infrastructure/pg/LedgerWriter.ts` (EXTEND — `writeSettlementFinalization`/`writeFeeLines`/`writeBrandLevelSettlement`); `apps/stream-worker/src/main.ts` (WIRE); `tools/eslint-rules/` (EXTEND card allowlist) + nightly log-grep config.
**Binding ids owned:** MB-1 (join in consumer), MB-2, MB-3, MB-4, MB-5, MB-6, MB-7, C1, C4, C5, C6.
**Slices:** A0 mapper-pkg + allowlist + seeds FREEZE→commit (unblocks B & C) → A1 `0027` (map table + ledger cols + fn + 3 assertion DO-blocks) → A2 settlements client + multi-cursor re-pull job → A3 `SettlementLedgerConsumer` + LedgerWriter methods + WIRE main.ts → A4 fast-follow (reserve-release order-keyless + reserves/adjustments cursors) → A5 tests.
**Required tests (all under `brain_app` via `assertBrainApp` + dual-pool fixtures):**
- **MANDATORY e2e wiring test (MB-4):** real Redpanda produce `settlement.live.v1` → `SettlementLedgerConsumer` (started) → observed ledger row. CI gate.
- **Non-inert no-GUC negative control (MB-5, durable rule):** `brain_app` direct `SELECT` on `connector_instance` WITHOUT GUC = 0 rows; enumeration via the fn returns rows. Under `brain_app`, NOT the dev superuser.
- Synthetic settlement report → net-of-fees rows (provisional untouched; `+finalization`, `−fee`, `−tax GST_18` separate); refund settlement → negative `settlement_reversal`; reserve deduction `−` then release `+` brand-level; dedup (webhook + re-pull + report of same settlement = ONE Bronze row via the entityType-seeded event_id); multi-cursor advance/resume + overlap-lock; dev re-pull trigger (MB-6) exercises ALL 3 cursors in one run; cross-brand count===0 under `brain_app`; card-field allowlist test (Razorpay fixture WITH card.* → Bronze has NONE).

### Track B — @backend-developer (webhook + HMAC + 3-cred + map-populate)
**Scope:** Razorpay webhook receiver (HMAC-first + replay + brand-resolve + `payment.captured` map-table populate), connect/3-cred secret, disconnect (deregister + invalidate + halt), `sync_status`.
**Files/artifacts:** `apps/core/src/modules/connector/sources/payment/razorpay/...` (NEW — first tenant of `payment/`): `interfaces/webhooks/razorpayWebhookHandler.ts`, `domain/value-objects/RazorpayHmac.ts`, `application/commands/{ConnectRazorpayCommand,DisconnectRazorpayCommand,RotateWebhookSecretCommand}.ts`, map-table populate repo; webhook route wired into core `main.ts`; EXTEND `DisconnectCommand.ts`.
**Binding ids owned:** MB-1 (the `payment.captured` map-table populate — the HARD prerequisite), C2, C3; HMAC-first + brand-from-row + sync_status.
**Slices:** B1 webhook receiver (HMAC-first + replay C3 + SECURITY DEFINER brand resolve) → B2 `payment.captured` map-table populate (MB-1 prereq) → B3 connect/3-cred secret + disconnect (deregister + invalidate, C2) → B4 inject() tests.
**Required tests:** HMAC-invalid webhook → 401 no write (forged-signature non-inert proof); replay (same `event_id` within window → rejected before Bronze; `created_at` older than 5-min → 400); `payment.captured` → map row upserted under correct brand (cross-brand isolation under `brain_app`); brand resolved from connector ROW not body; revocation sim (delete secret → disconnected + processing halts); `webhook_secret` rotates without touching `key_id`/`key_secret`.

### Track C — @frontend-web-developer (gross→net indicator + Razorpay tile)
**Scope:** the realized gross→net indicator on the dashboard; Razorpay connection tile/health.
**Files/artifacts:** `apps/web/app/(dashboard)/dashboard/page.tsx` (EXTEND — gross→net indicator + tooltip); Razorpay tile in the connector marketplace surface (mirror Shopify tile); BFF status query reuse.
**Binding ids owned:** ADR-RZ-9 (sync_status surface); no business logic in frontend (renders server state only).
**Slices:** C1 Razorpay connection tile/health → C2 dashboard gross→net indicator + settlement-lag tooltip (MB-7 context) → C3 e2e.
**Required tests:** tile reflects `syncing`/`connected`/`disconnected`+`last_sync_at`; gross→net indicator renders the net figure as settlements land; e2e from connect tile → settlement → number shifts.

---

## 4. In-lane DoD self-check

- Tenant isolation at every layer: map-table + ledger FORCE RLS two-arg fail-closed; enumeration via SECURITY DEFINER fn + GUC-after-enumerate; brand from connector ROW (MT-1); `assertBrainApp` on every isolation test. ✔
- Observability + real-network smoke: MANDATORY e2e wiring test (real Redpanda); `settlement_unmatched_count` metric; sync_status state machine. ✔
- ≥1 alternative + rejection: REJECTED extending `LiveLedgerBridgeConsumer` (would couple order + settlement filters in one consumer, a Single-Primitive smear at the consumer boundary and harder to test the wiring in isolation) → chose a DEDICATED `SettlementLedgerConsumer` (MB-4). REJECTED a single 30-day cursor (C6 — permanently misses reserve releases 90–180d). REJECTED collapsing GST into `payment_fee` (MB-3 — breaks ITC). ✔
- Reversible migration: additive only; DROP rollback documented; ledger rebuildable from Bronze. ✔
- Cost estimate: $0/mo incremental — no model path, no new infra; tokens/day = 0 (deterministic). ✔
- All persona must-fix folded into acceptance contracts as pass-1 REQUIRED items (the 13 bindings are distributed across Track A/B/C required tests above). ✔
- Every version pinned is real: NO new dependency versions introduced (reuses existing `pg`, `kafkajs`, `ioredis`, workspace pkgs already on master). ✔
- Deploy-pipeline: NO new deployable (constraint) — webhook rides `apps/core`, job + consumer ride `apps/stream-worker`; affected-only CI builds those two existing apps. ✔

---

## Journal (appended to architect.journal.md)
```
## 2026-06-17T23:35:00Z — Architect — feat-razorpay-settlement-connector
Stage 2 · Paradigm tier-0 deterministic ($0/mo, no model path) · Tracks A@data-engineer(lead) ∥ B@backend-developer ∥ C@frontend-web-developer
All 13 bindings resolved (MB-1..7 + C1..6). ONE slice, NO new deployable, additive 0027.
Single-Primitive CLEAN extend-only. Next: builders Stage 3 (ADVANCE).
```
</content>
</invoke>
