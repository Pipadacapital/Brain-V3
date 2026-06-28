# Google Ads Connector — Verification Report

Lead-reviewer merge of 4 reviews (GAQL/mapper depth, entity+conversion-action sync, OAuth2/dev-token/multi-account, Silver/Gold/ROAS/backfill) + a live-data diagnosis. Date: 2026-06-27.

---

## 1. Bottom line

**The Google Ads connector is a competent SPEND-ONLY poller, not the full ad-insight connector the spec requires — and it is live on ZERO brands.**

**Live reality (code-only):** No `google_ads` connector is connected on any brand. `connectors.connector_instance` holds only gokwik(1), meta(6), shopify(3), woocommerce(1) — zero google rows. Trino confirms `iceberg.brain_silver.silver_marketing_spend` = meta:968, **google_ads:0**, and `collector_events` with a google_ads payload = **0**. So this review grades code-correctness, not observed behavior; the connector has never executed against live Google data.

**What flows (correct, preserve as-is):**
- Money path is exact: `cost_micros → minor units` via BigInt integer division (`microsToMinorString`, `packages/ad-spend-mapper/src/index.ts:190-200`), non-negative-integer guard, no `parseFloat`, sibling `currency_code` (`index.ts:420`), never blended.
- Idempotency: deterministic `event_id` over the dedup grain (`uuidV5FromSpendRow(brandId, 'google_ads', stat_date, level, level_id)`, `index.ts:166-176`) → Bronze MERGE is dedup SoR. Backfill-safe already.
- Tenant isolation: `brand_id` is server-trusted from the connector only (MT-1, `run.ts:256`), never from the API.
- Throttle/auth: two-error classification `RESOURCE_EXHAUSTED` (DAILY → abort) vs `RESOURCE_TEMPORARILY_EXHAUSTED` (QPS → backoff), precedence-ordered `classifyGoogleError` (`google-ads-searchstream-client.ts:324-365`), 1-rps token bucket, tokens never logged.
- OAuth foundation for the single-CID directly-accessible case: offline refresh token stored as a Secrets-Manager bundle (ARN only, never PG), access token re-minted per run, developer-token + login-customer-id on every GAQL call, 0106 `activated_at` one-active-CID-per-brand gate.
- Silver/Gold wiring spine: `silver_ad_spend_normalize` → `silver_marketing_spend` fold, blended ROAS (`blended-roas.ts`) and per-campaign ROAS (`gold_campaign_performance.py`) join on `campaign_id`, same-currency-only, exact bigint ratios.

**What's missing (major gaps):**
- **Shallow metric depth.** GAQL selects only `cost_micros, impressions, clicks, conversions, all_conversions, segments.date, currency_code` (`google-ads-searchstream-client.ts:80-99`). Omits `conversions_value` (revenue — **blocks Google platform ROAS**), `view_through_conversions`, `ctr`, `average_cpc`, `advertising_channel_type`, `segments.device/network`. No keyword level.
- **Allowlist hard-drops everything extra.** `AD_SPEND_FIELD_ALLOWLIST` (`index.ts:54-68`) has no slots for the above, so even if fetched they die at the boundary.
- **Captured conversions are discarded.** `conversions_raw={conversions,all_conversions}` is built (`index.ts:404-408`) but NO downstream mart projects it — `silver_marketing_spend.py:134-178` never reads it. ADR-AD-8 "store raw conversions" is captured-but-unreachable.
- **No entity-metadata sync.** Zero `ad.entity.updated` / Change-History anywhere. Only `campaign.name` piggybacks the spend query; ad-group/ad/keyword names surface as raw IDs; names go stale for any campaign without recent spend.
- **No 2-year backfill.** Fixed 35-day trailing window (`run.ts:63 WINDOW_DAYS=35`). Max reachable history = 35 days.
- **MCC/manager logins broken.** `listAccessibleCustomers`-only discovery returns the manager CID, not child client CIDs; `login_customer_id` is never persisted per-account (falls back to one global env var). Real agency spend accounts are never discovered/activated → permanent zero spend.
- **Dead-code rules / dual normalizer.** `silver_campaign.py:81-82` reads `campaign_status` + flat `conversions` the mapper never emits → inactive-campaign gate permanently inert. `silver_ad_spend_normalize.py` reads raw lanes (`google_spend_raw`) that the live path never feeds (fed by RETIRED Kafka Connect) → dead, but claims to be the SoR.

**Most depth gaps are SHARED with Meta** (same `ad-spend-mapper` allowlist, same `silver_marketing_spend` / `silver_campaign` marts, same SERVER_TRUSTED admission, same missing backfill + missing entity lane). Reimplement ONCE across both platforms. Google-only net-new: MCC `customer_client` expansion, per-account `login_customer_id`, GAQL query/level construction, conversion-action sync.

---

## 2. Findings table (critical → low, de-duped)

| Sev | Dimension | Issue | Fix | Shared w/ Meta |
|-----|-----------|-------|-----|----------------|
| **High** | Mapper depth / ROAS | GAQL omits `conversions_value` (platform revenue), `view_through_conversions`, `ctr`, `average_cpc`, `advertising_channel_type`, `segments.device/network`; no keyword level (`google-ads-searchstream-client.ts:80-99`) | Widen each `LEVEL_QUERIES` entry; prioritize `conversions_value` (unblocks Google ROAS); add `keyword_view` level if in scope | **GAQL is Google-only; the missing-measures concept is SHARED** |
| **High** | Mapper / mart | Shared allowlist drops the full metric set; mapped `conversions_raw` is never read by any mart (`index.ts:54-68`; `silver_marketing_spend.py:134-178`) | Add fields to `AD_SPEND_FIELD_ALLOWLIST` + `SpendEventProperties`; project `conversions`/`conversions_value` through `silver_marketing_spend` → Gold; carry `conversions_value` as bigint minor + currency | **SHARED** |
| **High** | Entity sync | No `ad.entity.updated` job/event/Change-History anywhere; ad-group/ad/keyword names are raw IDs; campaign names stale without recent spend (`silver_campaign.py:88-100`) | Build shared `*-entity-sync` job: GAQL over campaign/ad_group/ad_group_ad(/keyword) `.name/.status/.bidding_strategy/.advertising_channel_type`, ~6h, emit `ad.entity.updated`; build `silver_ad_group`/`silver_ad` dims | **SHARED (both lack it)** |
| **High** | Backfill | No 2-year backfill — fixed 35-day window (`run.ts:63`); Meta = 28-day (`meta-spend-repull/run.ts:60`) | ONE shared backfill driver paging GAQL/Insights day-by-day, chunked by month, reusing the deterministic `event_id` so MERGE dedups overlap; per-(connector,resource) cursor like `PgResourceBackfillStateRepository` | **SHARED** |
| **High** | OAuth / multi-account | MCC/manager logins never discover child CIDs — `listAccessibleCustomers`-only returns the manager (`HandleGoogleAdsOAuthCallbackCommand.ts:232-255`) → real ad accounts never offered → zero spend | After `listAccessibleCustomers`, run GAQL `FROM customer_client` per returned CID (manager as login-customer-id) to enumerate LEAF clients; one ConnectorInstance per leaf | GOOGLE-ONLY |
| **High** | OAuth / multi-account | Per-brand `login_customer_id` never persisted; collapses to one global env var (`run.ts:317`); missing/wrong → `USER_PERMISSION_DENIED` mis-mapped to ACCOUNT_DISABLED → connector wrongly Disabled (`searchstream-client.ts:301-305,337-342`; `run.ts:203-211`) | Capture each account's required manager CID at connect, store per-account in bundle / `providerConfig.google_ads_login_customer_id`; env var = last-resort fallback only | GOOGLE-ONLY |
| **High** | Entity / dead code | `silver_campaign` Stage-1 inactive-campaign rule reads `campaign_status` + flat `conversions` the mapper never emits (`silver_campaign.py:81-82,112-137`) → `is_active` always unknown, `received_conversion_while_inactive` always false, `lifetime_conversions` always 0 | Source `campaign_status`/objective from the new entity lane; fix conversions read to `conversions_raw.conversions`; or join silver_campaign to the entity dim | **SHARED (mart is platform-agnostic)** |
| **Med** | Raw preservation | Raw Google payload preserved NOWHERE on live path; `silver_ad_spend_normalize.py` reads `google_spend_raw` fed by RETIRED Kafka Connect → dead/orphaned; live path emits allowlisted canonical (`run.ts:245-262`) | Decide ONE architecture: emit verbatim row into a raw Bronze lane + normalize in Spark (ADR-0006) OR formally retire `silver_ad_spend_normalize.py` and document mapper-canonical as SoR | **SHARED** |
| **Med** | Dedup grain | `event_id` grain has no CID and no segment component (`run.ts:249-251`); adding `segments.device/network` would collapse rows → silent overwrite under MERGE | Extend `uuidV5FromSpendRow` (and ledger grain) to include CID + active segment keys BEFORE introducing segments | **SHARED** |
| **Med** | OAuth / config | `GOOGLE_ADS_CLIENT_SECRET` / `DEVELOPER_TOKEN` / `LOGIN_CUSTOMER_ID` bypass `@brain/config`, read via raw `process.env`, no boot-time validation; install only pre-checks CLIENT_ID → brand can OAuth with no dev token → dead `__default__` instance (`core.ts:50`; `HandleGoogleAdsOAuthCallbackCommand.ts:187-188,233`; `run.ts:289-291,317`; `InitiateGoogleAdsOAuthCommand:39-51`) | Add the three to `@brain/config` (core + stream-worker) memoized loaders; pre-validate dev token in install → fail fast `OAUTH_NOT_CONFIGURED` | **SHARED (Meta env reads same treatment)** |
| **Med** | OAuth / UX | Discovery failure OR missing dev token silently creates an auto-activated `__default__` connector that can never pull; surfaced reason ≠ real cause (`HandleGoogleAdsOAuthCallbackCommand.ts:247,252-254,109-141`; `run.ts:308-309,144-153`) | On non-OK `listAccessibleCustomers`, fail callback with typed `GoogleAdsOAuthError`; only create placeholder when API genuinely returns zero accounts | GOOGLE-ONLY |
| **Med** | Mapper depth | `spend.live.v1` carries only spend + impression/click counts; `ctr`/`cpc` re-derived downstream (fine) but device/network/channel-type/view-through unrecoverable (`gold_campaign_performance.py`) | If segmentation required, add `segments.device/ad_network_type` + `view_through_conversions` to GAQL, extend allowlist, decide grain widening deliberately (keeps idempotency) | **SHARED** |
| **Med** | Entity / conversion-action | No campaign objective / `bidding_strategy` / `advertising_channel_type` captured; no conversion_action definitions | Add `advertising_channel_type` + bidding strategy to entity GAQL; optional `conversion_action` GAQL → `ad.conversion_action.updated` | Entity attrs SHARED; conv-action GOOGLE-ONLY |
| **Low** | Throttle | Backoff is error-envelope driven (`2^n`), not `Retry-After`/`X-RateLimit` header driven; no Kafka DLQ (`searchstream-client.ts:204-283`) | Honor server `Retry-After`/`X-RateLimit` when present; document that Redis-7d-dedup + DLQ are intentionally replaced by deterministic-event-id MERGE + Silver quarantine (recorded decision) | Partially SHARED |
| **Low** | Code health | Two refresh-token exchange impls; no shared `google-token-client.ts` (unlike `meta-token-client.ts`) (`HandleGoogleAdsOAuthCallbackCommand.ts:182-225`; `searchstream-client.ts:145-171`) | Extract one `google-token-client.ts` (auth-code + refresh-token grants) reused by callback + SearchStream | GOOGLE-ONLY (mirrors Meta) |
| **Low** | Normalization | Three normalization copies (TS mapper, dormant Spark normalize, `silver_marketing_spend` payload reader) — drift risk; golden-vector tests guard byte-exactness today | Pick one SoR; delete/gate `silver_ad_spend_normalize.py`; document authoritative path | **SHARED** |
| **Low** | Conversion-action | No `ad.conversion_action.updated` (spec-optional); conversions are raw scalar counts only | Optional GAQL `conversion_action` sync → name conversions (purchase vs lead); low priority until insight set lands | GOOGLE-ONLY |
| **Info** | Auth health | No proactive detection of refresh-token expiry for OAuth apps still in "Testing" status (7-day expiry); revoked token surfaces only reactively (`searchstream-client.ts:145-171`; `run.ts:167-171`) | Require app "In production" before go-live; add connector-auth-health alert via `recordConnectorAuthRejected` | GOOGLE-ONLY |
| **Info** | Live | Google Ads connected on ZERO brands — review is code-audit-only | After reimpl, connect a real CID (dev token) and verify e2e | n/a |

---

## 3. Reimplementation plan (phased, EXTEND-not-rebuild)

Guiding principle: **do the SHARED work once in `@brain/ad-spend-mapper` + the Spark marts + SERVER_TRUSTED admission, then add the two GOOGLE-ONLY pieces (MCC discovery, query/level construction).** Preserve the money math, throttle branch, idempotent `event_id` grain, and MCC activation gate — build depth on top, don't rewrite.

### Phase 0 — Decide architecture seams (blockers for everything else) — SHARED
- **Normalization SoR.** Choose (a) TS-mapper-canonical (delete `silver_ad_spend_normalize.py` + `google_spend_raw`/`meta_spend_raw` lanes) OR (b) verbatim-raw + Spark-normalize (strip `mapGoogleRowToEvent` from `run.ts`). Today the docstring and code disagree; this misleads the reimpl. Recommended: (a) — the live path already works through the mapper.
- **Grain decision.** If segments (device/network) are in scope, the `event_id` tuple in `uuidV5FromSpendRow` (`index.ts:166-176`) must widen to include CID + segment keys, in lockstep with the `ad_spend_ledger` grain. Decide before touching GAQL.

### Phase 1 — Extend the shared mapper to the full insight set — SHARED (Meta+Google)
Files: `packages/ad-spend-mapper/src/index.ts`
- Extend `AD_SPEND_FIELD_ALLOWLIST` (`:54-68`) and `SpendEventProperties` with: `conversions_value` (bigint minor + own currency), `view_through_conversions`, `ctr`, `average_cpc`, `advertising_channel_type`, `device`, `network`. Carry `conversions`/`all_conversions` as first-class count columns (not just nested `conversions_raw`).
- Map them in BOTH `mapGoogleRowToEvent` (`:404-408`) and `mapMetaInsightToEvent` (`:320`) so `spend.live.v1` stays platform-symmetric.
- **Event shape:** keep `spend.live.v1` (don't fork to `ad.insight`) — it's already SERVER_TRUSTED and wired through `silver_collector_event`; widening props is lower-risk than a new lane. `conversions_value` stays a SIBLING measure, never blended into `spend_minor`.
- Tests: extend golden-vector tests for the new fields on both platforms.

### Phase 2 — Project the new measures through Silver/Gold — SHARED
Files: `db/iceberg/spark/silver/silver_marketing_spend.py`, `db/iceberg/spark/gold/gold_campaign_performance.py`, `db/iceberg/spark/silver/silver_campaign.py`
- `silver_marketing_spend.py:70-82,134-178`: add `conversions`, `all_conversions`, `platform_attributed_revenue_minor` (from `conversions_value`) + `view_through_conversions` projections from the payload.
- `gold_campaign_performance.py`: surface CPA = `spend_minor / conversions`, and a `platform_attributed_revenue_minor` column for a side-by-side **Brain ROAS vs platform ROAS** validation tile (per "revenue truth over platform truth" — Brain attribution stays the numerator; platform revenue is validation-only, sibling currency).
- `silver_campaign.py:81-82,112-137`: fix `conversions` read to `conversions_raw.conversions`; source `campaign_status` from the Phase-3 entity dim (the inline-spend read is permanently null). This revives the dead inactive-campaign gate.

### Phase 3 — Entity-metadata sync (`ad.entity.updated`) — SHARED lane, Google + Meta jobs
New job dirs: `apps/stream-worker/src/jobs/google-ads-entity-sync/`, mirror for Meta.
- GAQL over campaign + ad_group + ad_group_ad (+ optional `keyword_view`) selecting `.name/.status/.advertising_channel_type/.bidding_strategy` (Google) / Graph equivalents (Meta). Run ~6h; prefer Change History API (`change_event`) for incremental deltas under ops-quota.
- Emit a NEW canonical event `ad.entity.updated`, idempotent on `customer.id + resource_type + resource_id`.
- New Spark dims: `silver_ad_group`, `silver_ad`; make `silver_campaign` JOIN the entity dim for authoritative latest name/status (decoupled from spend volume) instead of reading inline spend-row names.
- Optional Google-only: `conversion_action` GAQL → `ad.conversion_action.updated`.

### Phase 4 — Admit new event types to SERVER_TRUSTED ONCE — SHARED
- Register `ad.entity.updated` (and `ad.conversion_action.updated` if built) in the SERVER_TRUSTED event allowlist a single time so both Meta and Google entity jobs share the admission. `spend.live.v1` already admitted — Phase 1 only widens its props, no new admission needed.

### Phase 5 — 2-year GAQL/Insights backfill — SHARED driver
New: a single shared ad-spend backfill driver (Meta + Google).
- `run(connectorId, {from, to})` chunked by month, walking day granularity up to 730 days; reuse `streamLevel` + the deterministic `event_id` so backfill vs trailing-window overlap dedups automatically in the MERGE.
- Persist a per-(connector, resource) backfill cursor like `ingestion-backfill/PgResourceBackfillStateRepository`. Chunk by month to stay under Google daily ops-quota.

### Phase 6 — Google-only OAuth/MCC correctness
Files: `apps/.../HandleGoogleAdsOAuthCallbackCommand.ts`, `.../google-ads-spend-repull/run.ts`, `InitiateGoogleAdsOAuthCommand.ts`, `@brain/config` (`core.ts`, `stream-worker.ts`)
- **MCC tree expansion** (`resolveAllCustomerIds`, `:232-255`): after `listAccessibleCustomers`, run GAQL `FROM customer_client` per CID (manager as login-customer-id) to enumerate LEAF clients; one ConnectorInstance per leaf, recording each child's required manager CID.
- **Per-account `login_customer_id`** (`:99-100,139`; `run.ts:317`): persist the discovered manager CID per-account in the bundle / `providerConfig.google_ads_login_customer_id`; `resolveGoogleCredentials` reads PER-CONNECTOR; env var = last-resort fallback. Fixes the `USER_PERMISSION_DENIED`→wrongly-Disabled trap.
- **Config centralization** — SHARED: add `GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_LOGIN_CUSTOMER_ID` to `@brain/config` schemas + memoized loaders; pre-validate dev token in `InitiateGoogleAdsOAuthCommand` (fail fast `OAUTH_NOT_CONFIGURED`). Give Meta env reads the same treatment.
- **Discovery-failure UX**: on non-OK `listAccessibleCustomers`, throw typed `GoogleAdsOAuthError` instead of auto-activating a dead `__default__` instance.
- **Token client (low)**: extract one `google-token-client.ts` reused by callback + SearchStream, mirroring `meta-token-client.ts`.

### Phase 7 — Validation (after a real connect)
- Connect a real Google Ads CID (dev token + MCC if applicable). Verify: `spend.live.v1` lands in `collector_events`; `silver_marketing_spend` shows `platform=google_ads` rows with non-zero `spend_minor` + correct currency; new insight columns + campaign/ad-group/ad names populate; `platform_attributed_revenue_minor` enables the ROAS-validation tile; MCC child accounts are offered for activation.

### Effort summary
| Phase | Scope | Shared? |
|-------|-------|---------|
| 0 Architecture seams | normalization SoR + grain decision | SHARED |
| 1 Mapper insight set | `ad-spend-mapper` allowlist + both mappers | SHARED |
| 2 Silver/Gold projection | marketing_spend + campaign_performance + silver_campaign | SHARED |
| 3 Entity sync | new jobs + silver_ad_group/silver_ad dims | SHARED lane |
| 4 SERVER_TRUSTED admit | one-time event registration | SHARED |
| 5 2-year backfill | one shared driver + cursor | SHARED |
| 6 OAuth/MCC/config | MCC expansion, per-account login_customer_id, config | Mostly GOOGLE-ONLY (config SHARED) |
| 7 Validation | live connect + e2e checks | GOOGLE-ONLY |

**Preserve through all phases:** `microsToMinorString` BigInt money math, `classifyGoogleError` throttle branch, MCC activation gating (0106), and the deterministic `event_id` grain — these are the spec-compliant core.
