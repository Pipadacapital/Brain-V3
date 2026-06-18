# 05 — Architecture Plan: GoKwik + Shopflo data connectors (Slice 1)

| Field | Value |
|-------|-------|
| **req_id** | `feat-gokwik-shopflo-connectors` |
| **Stage** | 2 (Architect — binding plan) |
| **Lane** | high_stakes (connectors, money, multi-tenancy, PII, secrets, webhooks) |
| **Cost paradigm** | **Deterministic logic only** — no model/ML call anywhere. Shopflo HMAC verify + field-allowlist mapping + GoKwik AWB cursor state-machine + CoD/RTO arithmetic over BIGINT minor units. GoKwik's risk_flag is a *categorical string we record verbatim* (High/Med/Low), never a score we compute. Justification: every signal is either a webhook field, a lifecycle state transition, or integer money math — the cheapest sufficient tier. A model here would be a paradigm-bypass (anti-blind trigger). |
| **Single-Primitive sweep** | **clean (extend, do not create).** Reuse: connector framework (`connector_instance`/`connector_cursor`/`connector_sync_status`), the trailing-window re-pull (razorpay-settlement-repull is the exact template), the catalog registry, the secrets seam, the HMAC-verified webhook pattern (razorpay handler = the credential-auth template; shopify handler = the Bronze-landing template), the metric-engine sole-read-path, the analytics UI (KpiTile/Recharts/marketplace-view). NO new deployable, NO new datastore, NO per-channel fork. |

---

## 0. Context grep (actual code, file:line)

| Seam to reuse | Concrete anchor |
|---|---|
| Credential connect (API-key, NOT OAuth) | `apps/core/src/main.ts:854-934` — generic `connectMethod === 'credential'` branch; Razorpay arm at `:865`. Mirror this for `shopflo`/`gokwik`. |
| Connect command | `apps/core/src/modules/connector/sources/payment/razorpay/application/commands/ConnectRazorpayCommand.ts` — composite-bundle secret, one `secret_ref`, provider-specific account column. |
| Webhook handler (HMAC-first → resolve brand by SECURITY DEFINER fn → Bronze/live lane) | `razorpay/interfaces/webhooks/razorpayWebhookHandler.ts:102-440` (credential-auth + Redis replay) ∥ `shopify/.../shopifyWebhookHandler.ts:74-285` (mapper → `CollectorEventV1` → live topic → `touchSyncStatus`). |
| Trailing-window re-pull | `apps/stream-worker/src/jobs/razorpay-settlement-repull/run.ts` — enumerate via SECURITY DEFINER fn (no GUC) → GUC-after-enumerate → `FOR UPDATE SKIP LOCKED` per cursor resource → page loop → cursor high-water advance → `setSyncState`. **This is the AWB template verbatim.** |
| Catalog registry (SoR, code not DB) | `apps/core/src/modules/connector/catalog/registry.ts:38-118` — add 2 tiles. |
| Brand-resolution SECURITY DEFINER fn pattern | `db/migrations/0027_razorpay_settlement.sql:190-243` (`resolve_*_by_account` + `list_*_for_repull`) + `0028:41-55`. |
| Bronze sink | `db/migrations/0016_bronze_events.sql:24-42` — `bronze_events`, FORCE RLS, append-only, `(brand_id,event_id)` PK = idempotency backstop. |
| Gold ledger | `realized_revenue_ledger` (extended in `0027:135-174`) — metric-engine reads it (`packages/metric-engine/src/settlement-summary.ts:119`). |
| Collector accept-before-validate | `apps/collector/src/interfaces/rest/collect.route.ts:20-37` — pattern reference; **but webhooks land in apps/core** (where Razorpay/Shopify already are), not collector. |
| BFF sole-read-path | `apps/core/src/modules/frontend-api/internal/bff.routes.ts:937-1566` (`/api/v1/analytics/*` → analytics module → metric-engine). |
| Mapper package shape | `packages/razorpay-mapper/src/index.ts`, `packages/shopify-mapper` — allowlist + boundary-hash + `uuidV5From*`. |
| Marketplace UI | `apps/web/components/connectors/marketplace-view.tsx`; tiles fed by `main.ts:765` (`connect_method`). |
| Analytics UI primitives | `apps/web/components/analytics/kpi-tile.tsx`, `trend-chart.tsx`, `settlements-waterfall.tsx`. |

> ASSUMPTION: webhooks remain in **apps/core** (the existing webhook home), not apps/collector. apps/collector is the pixel/`/collect` path; both vendor webhooks reuse the in-core Razorpay/Shopify handler pattern + the same `liveTopic` producer wired at `main.ts:483`.

---

## 1. The two connect flows (Track B — backend)

Both are **credential connectors** (API-key, NOT OAuth — confirmed: Shopflo static API Access Token + Merchant-ID; GoKwik static appid/appsecret). Both flow through the existing generic credential branch at `main.ts:854`, adding a per-provider arm mirroring the Razorpay arm (`:865`).

### 1a. Shopflo connect — `credentials = { api_token, merchant_id, webhook_secret }`
- Store as **ONE composite bundle** under one `secret_ref` via `connectorSecretsManager.storeSecret(brandId, { connectorType:'shopflo', subKey: merchant_id }, {...})` — exactly `main.ts:883`. `api_token` + `webhook_secret` never logged (I-S09); `merchant_id` is the (non-secret) merchant identifier.
- `connector_instance`: `provider='shopflo'`, generic `shopflo_merchant_id` column (migration 0030) set under brand GUC (mirror `main.ts:909-923`). Used by the webhook brand-resolution fn.
- > ASSUMPTION: Shopflo's webhook HMAC scheme is **undocumented** (research open-question). We adopt the **Razorpay scheme as the default**: merchant pastes a shared `webhook_secret` at connect time; we verify `HMAC-SHA256(rawBody, webhook_secret)`. The signature header name is config-driven (`SHOPFLO_SIG_HEADER`, default `x-shopflo-signature`) so a documented scheme later is a one-line flip, not a redesign. This is the honest, reversible default — NOT a fabricated "live" guarantee.

### 1b. GoKwik connect — `credentials = { appid, appsecret }`
- Store `{ appid, appsecret }` as one bundle (same seam). `appsecret` never logged.
- `connector_instance`: `provider='gokwik'`, generic `gokwik_appid` column (0030) for AWB re-pull enumeration + RTO-Predict event keying.
- GoKwik exposes **no self-serve webhook** (research finding 5 — POC-mediated). So GoKwik has **no inbound webhook route in Slice 1**. Its two ingestion seams are:
  1. **RTO-Predict events** — order-keyed risk events (risk_flag + reason + request_id). > ASSUMPTION: in dev there is no live at-checkout call to observe; these arrive as **clearly-labelled SYNTHETIC FIXTURES** (see §4) emitted to the live lane as `gokwik.rto_predict.v1`. The mapper + Silver mapping are REAL and production-shaped; only the *source* is synthetic until partner credentials exist.
  2. **AWB-lifecycle** — the REAL trailing-window re-pull (§3).

Both connects emit `connector.connected` audit (no secrets in payload — `main.ts:925`) and create the initial `connector_sync_status` row.

---

## 2. The Shopflo webhook — HMAC-verified, accept-before-validate → Bronze (Track A + B)

New route `POST /api/v1/webhooks/shopflo` registered in `apps/core/src/main.ts` alongside Razorpay (`main.ts:483`), file `shopflo/interfaces/webhooks/shopfloWebhookHandler.ts`. **Security order is immovable (mirrors razorpayWebhookHandler exactly):**

1. **Raw body required** (`config:{ rawBody:true }`) — else 400.
2. **Parse only to extract `merchant_id`** (the lookup key) — no write yet.
3. **Brand resolution** via SECURITY DEFINER fn `resolve_shopflo_connector_by_merchant(merchant_id)` (0030) → `{ connector_instance_id, brand_id, secret_ref }` from the **DB row**. `brand_id` NEVER from webhook body (MT-1). No connector → 401.
4. **Fetch `webhook_secret`** from `secret_ref` bundle → **HMAC verify** `HMAC-SHA256(rawBody, webhook_secret)` against the config-driven sig header. Invalid/missing → 401, no write.
5. **Replay protection** (reuse `RedisDedupAdapter`): age check + `SET NX EX 600` on a stable event key. > ASSUMPTION: Shopflo gives no event-id; dedup key = `uuidV5(brandId, checkout_id, occurred_at)` from the payload (deterministic, replay-safe). Duplicate → 409.
6. **Map** via new `@brain/shopflo-mapper` — **field allowlist + boundary PII hash**: `email`/`phone` hashed with the per-brand salt (`getSaltHex(brandId)`) before they leave handler scope (I-S02 — raw PII never in Bronze). Money fields (subtotal/discount/shipping/tax/total) → BIGINT minor units (×100, currency_code captured).
7. **Build `CollectorEventV1`** (`event_name='shopflo.checkout_abandoned.v1'`, `event_id = uuidV5FromShopfloCheckout(brandId, checkout_id, occurred_at)`) → **produce to `liveTopic`** (partition key = brand_id). The existing stream-worker `ProcessEventUseCase` lands it in `bronze_events` (accept-before-validate = durable Bronze landing; canonicalization is downstream, never in the webhook).
8. **Touch `connector_sync_status`** under brand GUC → **200 fast-ack** (Shopflo retries on non-2xx; 500 on Kafka failure forces retry).

**Canonical Silver — `shopflo.checkout_abandoned.v1`** (mapper output shape, the checkout-conversion funnel): `checkout_id`, `cart_token`, `customer_email_hash`, `customer_phone_hash`, `marketing_consent`, `line_items[]` (id/title/qty/`price_minor`), `subtotal_minor`, `total_discount_minor`, `total_shipping_minor`, `total_tax_minor`, `total_price_minor`, `currency_code`, `has_address` (addressless-checkout flag — research finding 8), `occurred_at`. This is REAL (documented payload). Silver is materialized by the metric-engine read path (§5), not a physical table.

---

## 3. GoKwik AWB-lifecycle trailing-window re-pull (Track A) — RESTATES terminal states

New job `apps/stream-worker/src/jobs/gokwik-awb-repull/run.ts` — a **near-verbatim copy of razorpay-settlement-repull/run.ts**:

1. **Enumerate** via SECURITY DEFINER fn `list_gokwik_connectors_for_awb_repull()` (0030) — runs as `brain`, bypasses FORCE RLS, returns `{ connector_instance_id, brand_id, secret_ref, gokwik_appid }`. **No GUC at enumerate** (durable rule `system-job-force-rls-enumeration`).
2. **GUC-after-enumerate** per brand → `setSyncState(...,'syncing')`.
3. **Single cursor resource `awb.lifecycle`**, `FOR UPDATE SKIP LOCKED` on the `connector_cursor` row (overlap-safe; concurrent trigger skips). **Window = weeks-long** (`AWB_WINDOW_MS = 45 days`) because RTO/Delivered end-states arrive weeks after order placement (research finding 3). Cursor stores the high-water `updated_at` of the last processed AWB record; each run re-reads the whole trailing window so terminal-state transitions are **restated**.
4. Per AWB record → map via `@brain/gokwik-mapper`: `awb_number_hash` (hashed at boundary), `order_id` (the ledger spine key), `status`, `is_terminal` (true for `RTO*`/`Delivered`/`Cancelled`/`Lost`), `status_changed_at`. `event_id = uuidV5FromAwb(brandId, awb_number, status, status_changed_at)` → **distinct per state change** → a new Bronze row per transition (idempotent restatement, exactly the Shopify `uuidV5FromOrderLive` per-`updated_at` pattern).
5. Emit `gokwik.awb_status.v1` to the live lane → cursor advance per page → `setSyncState(...,'connected')`.
6. **Dev trigger**: `argv[2]` = `connector_instance_id` (single-connector re-pull, CI-testable) — same `MB-6` entrypoint as the Razorpay job.

> ASSUMPTION: GoKwik's AWB **read** API shape (auth headers appid/appsecret, pagination, backfill depth) is **undocumented** (research open-question). The job's `GoKwikAwbClient` is structured around a paged `fetchAwbPage(from,to,skip)` interface; in dev it reads from **labelled synthetic AWB fixtures** (§4) that exercise the full transition→terminal lifecycle. The cursor/restatement machinery + mapper + Gold semantics are REAL and production-shaped — only the HTTP client's data source is synthetic until partner sandbox access.

**Gold — CoD CM2 / RTO-clawback semantics** (`realized_revenue_ledger`, extended in 0030 — additive, mirrors 0027's pattern):
- On `gokwik.awb_status.v1` reaching a **terminal RTO** state, `GokwikAwbLedgerConsumer` (new, mirrors `SettlementLedgerConsumer`) writes an `rto_clawback` ledger event (signed negative `amount_minor`, `reconciliation_type='per_order'`, joined to `order_id`) — reversing recognized CoD revenue. Terminal `Delivered` confirms recognition. The ledger is the SoR; it is rebuildable from Bronze (append-only, restatement-safe via the per-status `event_id`).
- New `event_type` values added to the `realized_revenue_ledger_event_type_check` (drop+recreate, all existing values retained — 0027:135 pattern): `cod_rto_clawback`, `cod_delivery_confirmed`.

---

## 4. The synthetic-fixture boundary (Track A — MANDATORY, explicit)

| Domain | Status | Source in Slice 1 | Label |
|---|---|---|---|
| Shopflo `checkout_abandoned` | **REAL** | live HMAC webhook (§2) | none — real |
| GoKwik AWB lifecycle (RTO/Delivered terminal) | **REAL where public** (shape real; data synthetic in dev) | re-pull job (§3); dev source = fixtures | tile + chart badge `Synthetic (dev)` until partner sandbox |
| GoKwik RTO-Predict risk events (categorical High/Med/Low) | **REAL shape, synthetic source** | fixtures emitted as `gokwik.rto_predict.v1` | `Synthetic (dev)` |
| Settlement / payments-fees / MDR | **SYNTHETIC ONLY** (undocumented for both — research finding 9) | fixtures | `Synthetic (dev)` |
| EMI / loyalty (beyond coupons) | **SYNTHETIC ONLY** | fixtures | `Synthetic (dev)` |
| Numeric RTO score | **DOES NOT EXIST publicly** (only categorical) | not built | n/a — never fabricated as numeric |

- Fixtures live at `apps/stream-worker/src/jobs/_fixtures/gokwik-shopflo/` (AWB lifecycle sequences, RTO-Predict samples, synthetic settlement/EMI rows). Every fixture row carries `_synthetic: true` in `processing_flags` on the Bronze envelope, and the **mapper stamps `data_source:'synthetic'`** into Silver/Gold props so the BFF can surface the honest badge. A real partner credential later flips the client's data source; the `_synthetic` flag drops — no schema change.
- **Hard rule (DEV-HONESTY):** synthetic data is NEVER presented as "live". The connect tile shows `Connected (synthetic dev data)`; the CoD/RTO surface renders a `Synthetic (dev)` badge per card sourced from a synthetic domain; honest empty-state when a brand has no data. Real partner credentials/sandbox = a stated **platform follow-up** (exactly as Shopify/Razorpay deferred real-credential validation).

---

## 5. UI — marketplace flips + CoD/RTO analytics surface (Track C — frontend)

**Marketplace flips** (`registry.ts`): set `shopflo` (category `storefront`, `connectMethod:'credential'`, `availability:'available'`) and `gokwik` (category `logistics`, `connectMethod:'credential'`, `availability:'available'`). Tiles already render via `main.ts:765` + `marketplace-view.tsx`. Credential connect modal collects the per-provider fields (Shopflo: api_token/merchant_id/webhook_secret; GoKwik: appid/appsecret) — extend the existing credential form.

**CoD/RTO analytics surface** — new route `apps/web/app/(dashboard)/analytics/cod-rto/page.tsx` + `cod-rto-content.tsx`, reusing `KpiTile` + Recharts. Three views, all via the **BFF sole-read-path** (new `/api/v1/analytics/cod-rto-*` routes in `bff.routes.ts` → new analytics-module query wrappers → new metric-engine functions reading `realized_revenue_ledger` + bronze-derived AWB/checkout Silver, ADR-002 — NO ad-hoc SUM in routes):
- **RTO% by pincode / cohort** (from `gokwik.awb_status.v1` terminal states). > ASSUMPTION: pincode arrives in the AWB fixture; if absent, cohort-only with honest "pincode pending partner data".
- **CoD vs prepaid mix** + **CoD CM2** (from the ledger `cod_*` event_types).
- **Checkout-conversion funnel** (from `shopflo.checkout_abandoned.v1` — abandoned vs converted; discount-applied rate).
Every synthetic-sourced card carries the `Synthetic (dev)` badge; honest empty + loading + error states.

---

## 6. Migration — `0030` (single additive migration, next after 0029)

**`db/migrations/0030_gokwik_shopflo_connectors.sql`** — additive only (I-E02), mirrors 0027 structure exactly:
- **(A)** `connector_instance`: drop+re-add `provider` CHECK → `('shopify','razorpay','shopflo','gokwik')`; `ADD COLUMN IF NOT EXISTS shopflo_merchant_id TEXT`, `gokwik_appid TEXT`; partial indexes on each.
- **(B)** `realized_revenue_ledger`: drop+recreate `event_type` CHECK retaining ALL existing values + add `cod_rto_clawback`, `cod_delivery_confirmed`.
- **(C)** SECURITY DEFINER fns (each with the SEC-0030a/b/c migration-time assertion triad — prosecdef/search_path=public/brain_app EXECUTE, copied from 0027:251-387):
  - `resolve_shopflo_connector_by_merchant(text)` — webhook brand resolution.
  - `list_shopflo_connectors()` / `list_gokwik_connectors_for_awb_repull()` — re-pull enumeration.
- **(D)** No new RLS table needed (all reuse existing FORCE-RLS `connector_*` + `bronze_events` + `realized_revenue_ledger`). Post-migration assertions: provider CHECK includes new values; new fns SECURITY DEFINER + granted.
- **Rollback:** drop the 3 fns; drop the 2 columns; restore both CHECKs to prior value sets (ledger rebuildable from Bronze).

> ASSUMPTION: one migration is sufficient — no new physical Silver/Gold table; Silver is mapper-output in Bronze, Gold is the extended ledger, both read by the metric-engine. This keeps the slice minimal + reversible.

---

## 7. Alternatives considered + rejected

| Alternative | Rejected because |
|---|---|
| A new `gokwik-connectors` deployable / a 2nd queue for AWB | Violates architecture-patterns (background jobs are in-service; no new deployable per requirement). The re-pull is a stream-worker job exactly like razorpay-settlement-repull. |
| Land Shopflo webhook in apps/collector `/collect` | The HMAC-verify + brand-resolution + secret-fetch seam already lives in apps/core (Razorpay/Shopify). Splitting it forks the Single-Primitive webhook pattern. accept-before-validate is preserved by produce-to-live-lane → Bronze. |
| Physical `silver_checkout` / `gold_cod_rto` tables | Metric-engine already materializes from Bronze + ledger; new tables = a parallel read path (Single-Primitive violation) + a non-additive surface. Reuse the ledger + bronze-derived reads. |
| Compute a numeric RTO score | GoKwik exposes only a **categorical** flag (research finding 1). Synthesizing a numeric score = fabricating "live" data (DEV-HONESTY violation). Record the categorical string verbatim. |
| Trust `merchant_id`/`brand_id` from webhook body | MT-1 violation. Brand is resolved server-side from the connector row via SECURITY DEFINER fn, post-HMAC. |

---

## 8. Cost estimate

Deterministic only — **zero model tokens/day, $0 LLM spend**. Marginal infra: 2 cursor/connector rows + 1 weeks-window re-pull job (one cursor resource, daily) + 1 webhook route. Negligible Kafka/Postgres delta (same envelope/Bronze path as Razorpay). No new pods, no new datastore.

---

## 9. The three tracks (binding — exact file targets)

### Track A — @data-engineer (ingest + re-pull + mappers + fixtures + migration)
- `db/migrations/0030_gokwik_shopflo_connectors.sql` **(new)** — §6.
- `packages/shopflo-mapper/src/index.ts` **(new pkg)** — checkout_abandoned allowlist + boundary PII hash + minor-units money + `uuidV5FromShopfloCheckout` + `data_source` stamp.
- `packages/gokwik-mapper/src/index.ts` **(new pkg)** — AWB status map (`is_terminal`, hashed awb), RTO-Predict map, `uuidV5FromAwb`/`uuidV5FromRtoPredict`, `data_source` stamp.
- `apps/stream-worker/src/jobs/gokwik-awb-repull/run.ts` + `gokwik-awb-client.ts` **(new)** — §3 (clone razorpay-settlement-repull).
- `apps/stream-worker/src/jobs/gokwik-rto-predict-emit/run.ts` **(new)** — emit synthetic RTO-Predict events (dev source).
- `apps/stream-worker/src/jobs/_fixtures/gokwik-shopflo/*.json` **(new)** — labelled synthetic AWB/RTO/settlement/EMI fixtures (§4).
- `apps/stream-worker/src/interfaces/consumers/GokwikAwbLedgerConsumer.ts` **(new)** — terminal-state → ledger (`cod_rto_clawback`/`cod_delivery_confirmed`), mirrors `SettlementLedgerConsumer.ts`.
- Tests: `apps/stream-worker/src/jobs/gokwik-awb-repull/run.test.ts` (cursor restatement + SKIP LOCKED overlap), mapper unit tests with `__tests__/` (hash-at-boundary + minor-units).

### Track B — @backend-developer (connect flows + secrets + Shopflo HMAC webhook + brand resolution)
- `apps/core/src/main.ts:854` **(edit)** — add `shopflo` + `gokwik` arms to the `credential` branch (mirror Razorpay `:865`); set `shopflo_merchant_id`/`gokwik_appid` under brand GUC.
- `apps/core/src/modules/connector/sources/checkout/shopflo/application/commands/ConnectShopfloCommand.ts` **(new)** — clone `ConnectRazorpayCommand.ts`.
- `apps/core/src/modules/connector/sources/checkout/gokwik/application/commands/ConnectGokwikCommand.ts` **(new)** — clone, no webhook_secret.
- `apps/core/src/modules/connector/sources/checkout/shopflo/interfaces/webhooks/shopfloWebhookHandler.ts` **(new)** — §2 (clone razorpayWebhookHandler: HMAC-first, SECURITY DEFINER brand resolve, Redis replay, mapper, live-lane produce, sync_status touch).
- `apps/core/src/modules/connector/sources/checkout/shopflo/domain/value-objects/ShopfloHmac.ts` **(new)** — clone `RazorpayHmac.ts`.
- `apps/core/src/main.ts:483` **(edit)** — register `shopfloWebhookHandler` next to Razorpay (same deps: secretsManager, rawPgPool, producer, liveTopic, getSaltHex, redis).
- `apps/core/src/modules/connector/catalog/registry.ts` **(edit)** — flip `shopflo` + `gokwik` tiles to `available`/`credential`.
- Tests: `shopflo/tests/shopfloWebhookHandler.integration.test.ts` (HMAC reject / replay 409 / brand-from-row never body / **isolation verified under `brain_app`**); `ConnectShopfloCommand.test.ts` (secret bundle, no creds in audit/log).

### Track C — @frontend-web-developer (marketplace tiles + CoD/RTO surface, honest synthetic labels)
- `apps/web/components/connectors/marketplace-view.tsx` **(edit)** + the credential connect modal **(edit)** — Shopflo (api_token/merchant_id/webhook_secret) + GoKwik (appid/appsecret) field sets.
- `apps/web/app/(dashboard)/analytics/cod-rto/page.tsx` + `cod-rto-content.tsx` **(new)** — RTO% by pincode/cohort, CoD-vs-prepaid + CoD CM2, checkout funnel; `Synthetic (dev)` badges + honest empty/loading/error.
- `apps/web/components/analytics/rto-pincode-chart.tsx`, `cod-mix-chart.tsx`, `checkout-funnel-chart.tsx` **(new)** — reuse Recharts/KpiTile primitives.
- `apps/core/src/modules/frontend-api/internal/bff.routes.ts` **(edit)** — new `/api/v1/analytics/cod-rto-rates`, `/cod-mix`, `/checkout-funnel` routes (sole-read-path → analytics module).
- `apps/core/src/modules/analytics/index.ts` + `internal/application/queries/get-cod-rto-*.ts` **(new)** — analytics wrappers.
- `packages/metric-engine/src/cod-rto-*.ts` **(new)** + register in `packages/metric-engine/src/registry.ts` **(edit)** — tenant-first reads over ledger + bronze-derived Silver; `data_source` surfaced for the badge.
- Tests: `apps/web/e2e/` cod-rto surface (tiles connectable, synthetic badge visible, honest empty).

---

## 10. Acceptance contract (REQUIRED pass-1 — folds all must-fix)

- [ ] **Per-brand isolation verified under role `brain_app`** (NOT superuser `brain`) in every webhook/job/read integration test — superuser bypasses RLS so a non-`brain_app` check is INERT.
- [ ] Shopflo webhook: HMAC-first (invalid → 401 no write); replay (age + Redis NX) → 409; brand resolved **only** from the SECURITY DEFINER fn row, never the body.
- [ ] PII (`email`/`phone`) hashed at the mapper boundary with the per-brand salt — raw PII never in Bronze/logs/responses.
- [ ] Money = BIGINT minor units + `currency_code` everywhere; ledger `fee_minor`/`amount_minor` BIGINT.
- [ ] AWB re-pull: enumerate via SECURITY DEFINER fn with **no GUC**, GUC set after; `FOR UPDATE SKIP LOCKED`; weeks-long window; per-status `event_id` restates terminal states idempotently.
- [ ] Secrets never logged (api_token/appsecret/webhook_secret); only `secret_ref` stored on `connector_instance`; not in any response or audit payload.
- [ ] Synthetic data labelled `Synthetic (dev)` end-to-end (`_synthetic` flag + `data_source` prop + UI badge); never presented as live.
- [ ] Migration 0030 additive only; rollback documented; SEC-0030 assertion triads present on every new SECURITY DEFINER fn.
- [ ] BFF reads via metric-engine sole-read-path (ADR-002) — no ad-hoc SUM in routes.
- [ ] Every track ships stakeholder-visible UI; honest empty/loading/error states.

---

## Journal

```markdown
## 2026-06-18T07:20:00Z — Architect — feat-gokwik-shopflo-connectors
**Stage:** 2 · **Paradigm:** deterministic-only (HMAC verify + allowlist map + AWB state-machine + BIGINT money; categorical risk recorded verbatim, never a computed score) · **Tracks:** A(@data-engineer) ∥ B(@backend-developer) ∥ C(@frontend-web-developer)
**Single-Primitive:** clean — extends connector framework / razorpay-settlement-repull / razorpay+shopify webhook handlers / catalog registry / metric-engine read path; no new deployable, no new datastore. Migration 0030 (additive). Synthetic-fixture boundary explicit + labelled.
**Next:** @data-engineer + @backend-developer + @frontend-web-developer — Stage 3 (dev-parallel)
```
