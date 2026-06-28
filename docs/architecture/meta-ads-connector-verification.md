# Meta Ads Connector — Verification & Reimplementation Plan

**Brand verified:** Bodd Active (`brand_id 1a6adb32-eb0d-41f9-8409-dc423240e444`)
**Date:** 2026-06-27
**Verdict:** `major_gaps` — working but spend-shallow vs the `ad.insight` spec. Extend, do not rebuild.

---

## 1. Bottom line

The Meta connector is **NOT broken and NOT "spend-only"** — it is a *structurally sound, money-safe, conversion-COUNT-aware* pipeline that nonetheless falls **well short of the full `ad.insight` spec**. The transport layer is genuinely good; the *metric depth, entity metadata, and history* are missing.

**What works today (preserve in any reimplementation):**
- **OAuth + activation** — `ads_read` least-priv scope, state-nonce-IS-auth with `brand_id` derived server-side (D-1), `client_secret` in POST body (SEC-AD-H1), token stored only as a Secrets-Manager ARN (never in PG), immediate short→long-lived exchange at callback, one `ConnectorInstance` per ad account (Gap B), atomic single-active switch via `ActivateAdAccountCommand` (migration `0106` gates enumeration on `activated_at IS NOT NULL`). **LIVE: 6 accounts connected, exactly 1 activated, 5 correctly `waiting_for_data`.**
- **Transport robustness** — 3-level granularity, cursor pagination (`FOR UPDATE SKIP LOCKED`), `X-App-Usage` / `X-Business-Use-Case-Usage` backoff, circuit breaker, async `ad_report_run` path, deterministic idempotent `event_id`, tokens never logged.
- **Money-safe spend path** — `spend.live.v1` → `silver_collector_event` (gated keystone) → `silver_marketing_spend` casts `spend_minor`→bigint + `currency_code`, **per-currency, never blended, never float** (Q1 PASS).
- **ROAS wiring on the Brain-attributed side** — blended ROAS (`gold_revenue_ledger ÷ silver_marketing_spend`) and per-campaign ROAS (`gold_marketing_attribution.credited_revenue_minor ÷ silver_marketing_spend.spend_minor` on `campaign_id+currency`) both correct, honest divide-by-zero (Q3 PASS).
- **Conversion COUNTS reach Bronze** — richer than "spend-only": `conversions_raw.actions[]` carries purchase/add_to_cart/view_content/lead counts.

**What is missing vs spec (the real complaint "has issues"):**
1. **`action_values[]` (conversion REVENUE) never requested** → no platform/Meta-attributed ROAS is possible; only blended-from-orders.
2. **No `action_attribution_windows` (`7d_click`/`1d_view`)** → action counts are Meta-default-window only, no reconciliation against Meta's own windows.
3. **`cost_per_action_type` / `ctr` / `cpc` / `cpm` not requested** (some derivable, but spec-listed).
4. **Silver DROPS `conversions_raw` entirely** → even the action COUNTS that DO reach Bronze never reach any mart/dashboard.
5. **No entity-metadata sync (`ad.entity.updated`)** → campaign `status`/`objective` never captured; `adset_name`/`ad_name` never pulled (adset/ad grain is ID-only); names piggyback spend rows and go stale.
6. **No 2-year backfill** — hardcoded 28-day trailing window only.
7. **Emits `spend.live.v1`, not the spec's `ad.insight`** (an ADR-AD-4 choice, but a divergence to ratify).
8. **Latent token-refresh prod gaps** that can *silently* kill ingestion at ~60 days.

**Conclusion:** correct & complete for *blended spend reporting*; **incomplete** for the *full performance/ROAS* spec. The fix is **additive enrichment**, not a rewrite.

---

## 2. Live proof (Bodd Active)

| Layer | Observed | Source |
|---|---|---|
| Accounts | 6 Meta ad accounts connected; **1 activated** (`act_507668214437296`, instance `79125a0a-…0765db0c`, syncing); 5 = `connected/waiting_for_data` | activation model works |
| Bronze event types | **969 `spend.live.v1`**; **0 `ad.insight`**; **0 entity events**; fresh to 2026-06-28 | `iceberg.brain_bronze.collector_events` |
| Sample payload (non-zero) | `campaign_name="LQ \| TOF \| Bid Cap"`, `impressions=13073`, `clicks=395`, `spend_minor=596689` INR, `actions[]`: purchase=2, add_to_cart=20, view_content=390, lead=5, initiate_checkout=2, search=3 | Bronze payload |
| **Missing in payload** | **NO `action_values[]`** (revenue), **NO attribution windows**, **NO `cost_per_action_type`/`ctr`/`cpc`/`cpm`** | `INSIGHTS_FIELDS` omission |
| Silver columns | `brand_id, spend_event_id, platform, level, level_id, parent_id, campaign_id, campaign_name, stat_date, spend_minor, currency_code, impressions, clicks, account_timezone, occurred_at, updated_at` | `iceberg.brain_silver.silver_marketing_spend` |
| **Silver gap** | **NO** conversions / actions / action_values / purchases / revenue / roas / ctr / cpc column — `conversions_raw` dropped | builder omission |
| History | `min(stat_date)=2026-05-31`, `max=2026-06-28` = **29 distinct days**, 968 rows | 28-day window, not 730 |

**Exact depth gap:** names + impressions + clicks + conversion COUNTS reach Bronze and are fresh; but conversion REVENUE is never fetched, attribution windows are absent, and the conversion counts that *do* land are discarded at Silver — so **dashboards see spend/impressions/clicks only**.

---

## 3. Findings (de-duped, critical → low)

| Sev | Dimension | Issue | Fix (file:line) |
|---|---|---|---|
| **HIGH** | Insights fields | `action_values[]` (Meta-attributed REVENUE) never requested or mapped → platform ROAS impossible | Add `action_values`,`cost_per_action_type` to `INSIGHTS_FIELDS` (`meta-insights-client.ts:94-103`); carry into `conversions_raw` + allowlist key (`ad-spend-mapper/src/index.ts:54-68,338-339`); persist `meta_attributed_revenue_minor` |
| **HIGH** | Insights fields | No `action_attribution_windows` (`7d_click`/`1d_view`) → default-window counts only | Append `action_attribution_windows=["7d_click","1d_view"]` to sync+async URL builders (`meta-insights-client.ts:258-263, 279-283`); persist per-window arrays |
| **HIGH** | Silver wiring | Silver **drops `conversions_raw`** → action counts already in Bronze never reach serving | Extract `payload.properties.conversions_raw` in `silver_marketing_spend.py:125-145`; add conversions + `conversion_value_minor` columns; derive `cpm_minor` in `gold_campaign_performance.py:127-136` |
| **HIGH** | Backfill | No 2-year history — hardcoded 28-day trailing window (`WINDOW_DAYS=28`) | New one-shot day-granular 730-day backfill job via async `ad_report_run`, reusing mapper + deterministic `event_id` (`meta-spend-repull/run.ts:60,187-188`) |
| **HIGH** | Token refresh (prod) | `meta-token-refresh` secret **READ has no prod seam** (`dev_secret` only) → in prod token never read/refreshed → silent ~60-day death | Mirror `resolveMetaCredentials` prod branch in `readBundle()` (`meta-token-refresh/run.ts:49-62` vs `meta-spend-repull/run.ts:339-357`); add prod-path test |
| **HIGH** | Token refresh | Short-lived fallback at callback stamps `issued_at=now` → dying ~2h token looks "fresh", skipped 30 days | Persist `token_kind`/`expires_at`; make `isTokenRefreshDue` treat short-lived as immediately due; fail-loud on long-lived exchange failure (`HandleMetaOAuthCallbackCommand.ts:122,139`; `meta-token-client.ts:98-108`) |
| **HIGH** | Entity metadata | No `ad.entity.updated` job; campaign `status`/`objective` never captured; adset/ad names never pulled (ID-only at those grains) | New `meta-entity-sync` job: `/act_{id}/campaigns,/adsets,/ads` fields `name,status,objective,effective_status,updated_time`; ~6h cadence; idempotent on `brand_id+platform+level+entity_id` |
| **MED** | Event admission | Spec types `ad.insight`/`ad.entity.updated` NOT in `SERVER_TRUSTED` → naive emit would quarantine as `tenant_unresolved` | If renaming, add to `SERVER_TRUSTED` in **both** `silver_collector_event.py:76-104` and `bronze_materialize.py` (byte-identical) + downstream `event_type` filters |
| **MED** | Silver dead code | `silver_campaign.py:82` reads `campaign_status` the mapper never emits → `is_active` always unknown, inactive-conversion rule never fires | Source `campaign_status`/`objective` from entity-sync feed and join; or remove dead path until feed exists |
| **MED** | Token refresh | Prod write-back gate keyed on `SHOPIFY_CLIENT_SECRET` → Meta refresh FATAL-exits on Shopify env state (cross-connector coupling) | Use connector-neutral `AwsSecretsManager('', kmsKeyId)` (`meta-token-refresh/run.ts:197-203`) |
| **MED** | Activation | Disabled chosen account 403-loops with generic error; no distinct `ad_account_disabled` state | Classify 403/Meta code 200 (or `/act_<id>?fields=account_status` precheck) → distinct health state + back-off (`meta-insights-client.ts:412-424`; `run.ts:169-183`) |
| **MED** | Resilience | No DLQ; un-mappable rows silently skipped (`run.ts:259`) | Route skip/un-mappable rows to DLQ/quarantine so loss is observable |
| **MED** | Production stability | No system-user (non-expiring) token path → stability rests on 60-day user token + cron | Offer Business System User token path for agency/prod tenants (`business_management` scope); keep user-token as self-serve default |
| **LOW** | Idempotency | Dedup seed omits `account_id` (spec: `account_id+campaign_id+date_start`) | Add `ad_account_id` to `uuidV5FromSpendRow` seed (`ad-spend-mapper/src/index.ts:166-176`) |
| **LOW** | Refresh UX | Missing-token branch counts `reconnectRequired` but never flips `sync_state` | Add `setSyncState(...'RECONNECT_REQUIRED')` + `recordConnectorAuthRejected('meta')` (`meta-token-refresh/run.ts:128-131`) |
| **LOW** | Fields | `ctr`/`cpc`/`cpm` not requested (derivable but spec-listed) | Add to request or document Silver derivation |
| **LOW** | Stale artifact | `silver_ad_spend_normalize.py` dead (empty `meta_spend_raw`/`google_spend_raw`); docstrings still cite dbt/StarRocks/Kafka-Connect | Delete/quarantine or wire verbatim-Bronze per ADR-0006; fix stale docstrings (`:8-17,426-429`) |
| **INFO** | Mapper | `applyFieldAllowlist` call is a no-op — return value discarded (`ad-spend-mapper/src/index.ts:360,428`) | Assign result back (`props = applyFieldAllowlist(...)`) or remove dead call |

### Cross-reference to platform patterns already solved (Shopify/Woo)
- **Canonical event admission** — the `SERVER_TRUSTED` gate is the *same seam* used by Shopify/Woo; adding `ad.insight`/`ad.entity.updated` follows the existing pattern of keeping `silver_collector_event.py` and `bronze_materialize.py` byte-identical. Prefer **extending `spend.live.v1` in place** over a new event_type to avoid touching the admission gate at all (lower-risk than the rename).
- **Backfill scheduling** — a bounded historical-backfill lane distinct from the steady-state trailing poll mirrors the **ingestion framework** pattern (migration `0111`, Shopify/Woo onboarded). Reuse `sync-request-claimer` provider mapping (`sync-request-claimer/run.ts:54`) and the async `ad_report_run` path rather than inventing a new scheduler.
- **Secrets prod seam** — the `readBundle` prod-seam gap is the same class of dev-only-secret-read bug previously found across connectors; apply the `AwsSecretsManager.getSecret` prod branch consistently.

---

## 4. Reimplementation plan (phased, file-level)

**Guiding principle: EXTEND, don't rebuild.** The OAuth/activation/transport layer is correct (audit "positive baseline"). All work below is additive: fields + entity sync + backfill + Silver projection + token-refresh hardening. No transport rewrite.

### Phase 0 — Stop silent ingestion death (MUST-FIX, ship first)
*Pure hardening of the working path; no schema change.*
- `meta-token-refresh/run.ts:49-62` — add prod seam to `readBundle()` (mirror `resolveMetaCredentials`).
- `meta-token-refresh/run.ts:197-203` — drop `SHOPIFY_CLIENT_SECRET` coupling; use neutral `AwsSecretsManager('', kmsKeyId)`.
- `HandleMetaOAuthCallbackCommand.ts:122,139` + `meta-token-client.ts:98-108` — persist `token_kind`/`expires_at`; short-lived ⇒ immediately due; fail-loud on exchange failure.
- `meta-token-refresh/run.ts:128-131` — flip `sync_state` on missing token.
- **Tests:** prod-path token read→re-exchange→write-back; short-lived-due assertion.

### Phase 1 — Capture full insight depth (MUST-FIX)
*Enrich the existing `spend.live.v1` lane in place (EXTEND — avoids the admission gate). Decide ADR-AD-4 here: keep `spend.live.v1` enriched, or dual-emit `ad.insight`.*
- `meta-insights-client.ts:94-103` — add `action_values, cost_per_action_type, ctr, cpc, cpm` to `INSIGHTS_FIELDS`.
- `meta-insights-client.ts:258-263, 279-283` — add `action_attribution_windows=["7d_click","1d_view"]` to sync + async URL builders.
- `ad-spend-mapper/src/index.ts:54-68, 338-339` — add allowlist keys; carry `actions[]` **and** `action_values[]` (+ per-window breakdown) into `conversions_raw`; fix the no-op `applyFieldAllowlist` (`:360,428`); add `ad_account_id` to the dedup seed (`:166-176`).
- **Preserve raw payload** (Phase-0 spec) — land untouched Insights row to Bronze; treat allowlist as the Silver projection, not an ingest-time drop.

### Phase 2 — Surface depth through Silver/Gold (MUST-FIX)
*Without this, Phase 1 data stays invisible.*
- `silver_marketing_spend.py:125-145` — project `conversions_raw` → conversion counts + `conversion_value_minor` + windowed columns.
- `gold_campaign_performance.py:127-136` — add `cpm_minor`, CPA, and a **Meta-attributed ROAS** column alongside the existing Brain-attributed ROAS for reconciliation.
- `blended-roas.ts` / `attribution-campaign-roas.ts` — already correct; add Meta-attributed ROAS read once `action_values` lands.

### Phase 3 — Entity metadata sync (MUST-FIX for adset/ad grain + status/objective)
- New `apps/stream-worker/src/jobs/meta-entity-sync/` — pull `/act_{id}/campaigns,/adsets,/ads` (`name,status,objective,effective_status,updated_time`); ~6h cadence via `sync-request-claimer`/argo cron; emit `ad.entity.updated`, idempotent on `brand_id+platform+level+entity_id`.
- **Admission:** add `ad.entity.updated` to `SERVER_TRUSTED` in **both** `silver_collector_event.py:76-104` and `bronze_materialize.py`.
- New `silver_ad_entity` (or `silver_adset`/`silver_ad`) conformed dimension; repoint `silver_campaign.py:70-100` to source `name/status/objective` from the entity feed (spend row name = fallback only). This makes `gold_campaign_performance.py:122` COALESCE meaningful and revives the dead `campaign_status` rule.

### Phase 4 — 2-year backfill (MUST-FIX for history)
- New one-shot Meta backfill lane: chunked monthly, day-granular over 730 days via async `ad_report_run`, `X-App-Usage` backoff, reusing the same mapper + deterministic `event_id` so it MERGE-dedups against the 28-day trailing repull. Keep `WINDOW_DAYS=28` as steady-state poll.

### Nice-to-have (post must-fix)
- System User (non-expiring) token path for agency/prod tenants (`business_management` scope).
- Distinct `ad_account_disabled` health state + back-off/quarantine + "reactivate" UI (`meta-insights-client.ts:412-424`).
- DLQ for un-mappable/skipped rows (`run.ts:259`).
- Delete/quarantine `silver_ad_spend_normalize.py`; fix stale dbt/StarRocks/Kafka-Connect docstrings.

### EXTEND vs rebuild summary
| Area | Action |
|---|---|
| OAuth / activation / token exchange | **KEEP** (correct) + Phase-0 hardening |
| Transport (backoff, circuit breaker, async report, cursor, dedup) | **KEEP** (spec-aligned) |
| Insight field set + mapper | **EXTEND** (add fields/windows/values) |
| Silver/Gold marts | **EXTEND** (project conversions + ROAS) |
| Entity metadata | **ADD** new job + dimension |
| Backfill | **ADD** new one-shot lane |
| `spend.live.v1` vs `ad.insight` | **DECIDE** (prefer enrich-in-place to avoid gate churn) |

---

## Appendix — key evidence anchors
- Field omission: `apps/stream-worker/src/jobs/meta-spend-repull/meta-insights-client.ts:94-103`
- Mapper conversions: `packages/ad-spend-mapper/src/index.ts:54-68, 338-339, 166-176, 360, 428`
- Window: `apps/stream-worker/src/jobs/meta-spend-repull/run.ts:60, 187-188, 259`
- Silver: `db/iceberg/spark/silver/silver_marketing_spend.py:57, 124-145`; `silver_campaign.py:70-100, 82`
- Gold/ROAS: `db/iceberg/spark/gold/gold_campaign_performance.py:104, 117-145`; `packages/metric-engine/src/blended-roas.ts:80-105`; `attribution-campaign-roas.ts:73-92`
- Admission gate: `silver_collector_event.py:76-104`
- Token refresh: `apps/stream-worker/src/jobs/meta-token-refresh/run.ts:49-62, 80-85, 128-131, 164-168, 197-203`; `meta-token-client.ts:98-108`; `HandleMetaOAuthCallbackCommand.ts:105-141, 122, 139`
- Activation: `db/migrations/0106`; `ActivateAdAccountCommand.ts:89, 96-108`; `InitiateMetaOAuthCommand.ts:37`
- Stale artifact: `db/iceberg/spark/silver/silver_ad_spend_normalize.py:8-17, 426-429`
