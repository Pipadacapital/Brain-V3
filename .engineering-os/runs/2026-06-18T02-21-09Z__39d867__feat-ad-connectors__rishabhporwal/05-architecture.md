# 05 — Architecture Plan: feat-ad-connectors (Slice 1)

> **Stage 2 binding plan.** Meta Ads + Google Ads deep connectors — OAuth connect +
> trailing-window spend/hierarchy ingestion + a Spend/ROAS UI. Smallest safe slice that
> ships value AND is stakeholder-visible.
>
> **Author:** Architect · **req_id:** `feat-ad-connectors` · **lane:** high_stakes
> **Worktree:** `/Users/rishabhporwal/Desktop/brain-ads` (branch `feat/ad-connectors`)
> **Migrations land at:** `0028`, `0029` (next free after `0027`).

---

## 0. Decision summary (ADRs resolved by this plan)

| ADR | Decision |
|---|---|
| **ADR-AD-1** | **Build Meta + Google as PARALLEL TRACKS inside Slice 1, NOT split slices.** Same connect seam, same trailing-cursor pattern, same UI — splitting would duplicate the UI track and the migration. Per-platform divergence (Insights API vs SearchStream; QPS vs daily-quota) is isolated to one API-client file + one mapper each. |
| **ADR-AD-2** | **OAuth dispatch shape:** generalize the existing `OAuthDispatch.initiate` to drop the Shopify-only `shopDomain?` requirement (it is already optional — no signature change). Register `meta` + `google_ads` handlers in the dispatch table. The **callback exchange** for ads is a NEW per-provider command (mirrors `HandleOAuthCallbackCommand`) — there is no HMAC step (ads providers don't sign the callback like Shopify); the **state nonce IS the authentication** (brand from signed/server-stored state, never the body). |
| **ADR-AD-3** | **Trailing ~28-day re-read cursor** in `connector_cursor`, one resource per platform: `meta.insights` (28d window) and `google_ads.spend` (35d window — covers Google's up-to-90d default-30d conversion window with margin while keeping ops-quota bounded). Identical overlap-lock (`FOR UPDATE SKIP LOCKED`) + GUC-after-enumerate + page-checkpoint pattern as `razorpay-settlement-repull/run.ts`. Cursor stores the trailing-window high-water `date` (ad spend is keyed by **stat date**, not a monotonic id). |
| **ADR-AD-4** | **Canonical spend event** = `spend.live.v1` — a new **`event_name` value on the EXISTING `collector.event.v1` topic + envelope** (NOT a new topic/envelope — same as how `order.live.v1` and `settlement.live.v1` ride the collector envelope). A new `@brain/ad-spend-mapper` package owns the field allowlist, boundary-hash, and event_id seed. |
| **ADR-AD-5** | **event_id namespace:** `uuidV5FromSpendRow(brandId, platform, statDate, level, levelId)` — provably non-colliding with `:order.*` / `:settlement.*` namespaces by including the literal platform token (`meta`/`google_ads`) + `spend` discriminator in the seed string. |
| **ADR-AD-6** | **Spend lands in a DEDICATED append-only fact `ad_spend_ledger`** (migration 0028), NOT in `realized_revenue_ledger`. Rationale: spend is a distinct economic concept with a distinct grain (platform × campaign/adset/ad/creative × stat-date), and folding it into the revenue ledger would corrupt the `realized_gmv_as_of()` SUM. This is an **additive fact table mirroring the existing ledger pattern** (FORCE-RLS, append-only-by-GRANT, ON CONFLICT dedup) — NOT a new deployable/service, so it is within Architect authority (I-E05 burden-of-proof is on new *deployables/services/databases*, not on an additive append-only table in the existing Postgres SoR). The ledger join (spend ↔ revenue ROAS) is computed in the metric engine at read time, never stored. |
| **ADR-AD-7** | **Throttle-backoff policy (Google two-error branch):** `RESOURCE_EXHAUSTED` (daily ops-quota) → mark `health_state='RateLimited'`, abort the cursor for this run, retry next scheduled run (no in-run retry — the quota is daily). `RESOURCE_TEMPORARILY_EXHAUSTED` (per-CID/per-token QPS) → bounded exponential backoff (cap ~5 retries, max ~30s), then continue. A self-imposed QPS cap (token-bucket, default ~1 req/s/CID configurable) keeps us under the bucket. Meta: branch on rate-limit headers (`X-Business-Use-Case-Usage` / code 17 / 80004) → same `RateLimited` + backoff. |
| **ADR-AD-8** | **Metric raw-vs-canonical:** store RAW in Bronze (both Google `metrics.conversions` AND `all_conversions`; Meta surviving attribution set post-Jan-2026; click-date AND conversion-date stamps). Pick the **canonical** in the metric engine (Silver/Gold): Slice-1 canonical = **click-date-anchored spend** (spend is fixed at click time — the COD-restatement insight). ROAS uses realized revenue (already finalized in `realized_revenue_ledger`) ÷ click-date spend. |
| **ADR-AD-9** | **Dev-honesty boundary:** real OAuth needs real app credentials + a public HTTPS callback + (Google) an approved developer token — a **platform follow-up**, identical to Shopify/Razorpay. In dev we prove connect + ingestion with **synthetic fixtures** (a `meta`/`google_ads` connector seeded via the connector-lifecycle fixtures + `dev_secret`, and a recorded-response API-client stub). The UI + status surface are HONEST: a connected synthetic connector shows real `connector_sync_status`, never a simulated "connected" badge. |

---

## 1. Cost paradigm

**Tier-0 deterministic — ZERO model calls, ZERO tokens/day.** Every number is computed in the
TypeScript metric engine over `ad_spend_ledger` + `realized_revenue_ledger` (I-E03 deterministic-first).
OAuth, ingestion, mapping, throttle-handling, and ROAS are all deterministic logic. No statistical/ML/model
tier is justified or used. **Justification:** spend ingestion is field-mapping + cursor arithmetic;
ROAS is integer division of two ledger SUMs — a model call here would be a paradigm-bypass violation.

**Cost estimate:** **0 LLM tokens/day, $0/mo incremental model spend.** Infra delta: 2 scheduled
Argo jobs (per-platform repull, ~1 run/brand/day) reusing the existing stream-worker deployable
(no new pod type); spend volume is tiny vs orders (campaigns × days, not events). No new topic, no
new partition count, no new deployable. Estimated infra delta: negligible (< existing connector jobs).

---

## 2. Single-Primitive sweep — CLEAN (extend, do not create)

| Concern | Existing primitive (extend) | `file:line` |
|---|---|---|
| Catalog SoR | `CONNECTOR_CATALOG` const — flip `meta`/`google_ads` to `available` | `apps/core/src/modules/connector/catalog/registry.ts:58-72` |
| OAuth dispatch | `registerOAuthDispatch` / `getOAuthDispatch` table | `apps/core/src/modules/connector/catalog/dispatch.ts:35-45` |
| OAuth initiate pattern | `InitiateOAuthCommand` (state nonce + Secrets) | `…/shopify/application/commands/InitiateOAuthCommand.ts:27` |
| OAuth callback + brand-from-state | `HandleOAuthCallbackCommand` (state → brandId, never body) | `…/shopify/application/commands/HandleOAuthCallbackCommand.ts:88-101` |
| State store (brand-bound, single-use) | `IOAuthStateStore` (reuse as-is, no change) | `…/shopify/infrastructure/state/IOAuthStateStore.ts:12-36` |
| Secrets seam (generic) | `ISecretsManager.storeSecret/getSecret/deleteSecret` keyed by `(brandId, connectorRef)` | `…/shopify/infrastructure/secrets/ISecretsManager.ts:46-64` |
| connector_instance entity | `ConnectorInstance` (shopDomain validation already conditional on non-empty) | `…/shopify/domain/entities/ConnectorInstance.ts:77-92` |
| Trailing re-pull job | `razorpay-settlement-repull/run.ts` (multi-cursor, SECURITY DEFINER, FOR UPDATE SKIP LOCKED, GUC-after-enumerate, live-lane emit, page checkpoint) | `apps/stream-worker/src/jobs/razorpay-settlement-repull/run.ts:97-360` |
| SECURITY DEFINER enumeration fn | migration `0027` `list_razorpay_connectors_for_settlement_repull()` + assertion DO-blocks | `db/migrations/0027_razorpay_settlement.sql:190-318` |
| Live-lane envelope + partition key | `CollectorEventV1Schema` + `buildPartitionKey` + `COLLECTOR_EVENT_V1_TOPIC_SUFFIX` | `packages/events/src/index.ts:140`; `packages/contracts` |
| Ledger writer pattern | `LedgerWriter` (GUC-first, ON CONFLICT DO NOTHING, BIGINT-as-string) | `apps/stream-worker/src/infrastructure/pg/LedgerWriter.ts:288-389` |
| Ledger-bridge consumer pattern | `SettlementLedgerConsumer` (filter event_name, autoCommit=false, DLQ@max-retry, wiring e2e test) | `apps/stream-worker/src/interfaces/consumers/SettlementLedgerConsumer.ts:88-207` |
| Mapper (allowlist + boundary-hash + uuidv5 seed) | `@brain/razorpay-mapper` (clone shape for `@brain/ad-spend-mapper`) | `packages/razorpay-mapper/src/index.ts:1-80` |
| Metric registry + read seam | `METRIC_REGISTRY` + `withBrandTxn` + `*_as_of` seams | `packages/metric-engine/src/registry.ts:50`; `revenue-timeseries.ts` |
| BFF analytics routes | `registerBffRoutes` `/api/v1/analytics/*` (sole read path) | `apps/core/src/modules/frontend-api/internal/bff.routes.ts:1025-1220` |
| Analytics UI components | `kpi-tile.tsx`, `trend-chart.tsx`, `orders-trend-chart.tsx`, `use-analytics.ts` | `apps/web/components/analytics/*`; `apps/web/lib/hooks/use-analytics.ts` |
| Connector-lifecycle fixtures | `connector-lifecycle-fixtures.ts` | `apps/stream-worker/src/tests/helpers/connector-lifecycle-fixtures.ts` |

**No new deployable, no new topic, no new envelope, no new service.** New artifacts are
all additive: 1 mapper package, 2 migrations, 2 stream-worker jobs, 1 ledger-bridge consumer,
metric-engine entries, BFF routes, UI section.

---

## 3. Invariant gate (the no-drift gate)

| Gate | Status |
|---|---|
| Already exists? | No spend connector exists (`grep ad_spend\|campaign` → only registry tile text). |
| Duplicate? | No — extends connect/cursor/ledger primitives; zero forks. |
| Drift? | None — mirrors Razorpay slice exactly (the most recent sibling). |
| Required? | Yes — "spend truth" half of unit economics, requirement-authoritative. |
| **I-S01 brand isolation** | `ad_spend_ledger` FORCE-RLS two-arg fail-closed; enumeration via SECURITY DEFINER fn; GUC-before-every-read; **negative control test under `brain_app`** (durable rule `system-job-force-rls-enumeration`). |
| **I-S07 money** | `spend_minor BIGINT` + `currency_code CHAR(3)`; no float anywhere; BIGINT-as-string through the mapper. |
| **I-S09 secrets** | OAuth tokens via `storeSecret` → ARN only in `connector_instance.secret_ref`; tokens NEVER logged, NEVER in events/Bronze. |
| **I-S02 no raw PII** | Ad spend has no contact PII. Ad-identifiers (campaign/ad/creative ids) are operational refs, NOT person-linkable — stored un-hashed (documented as PII-catalog "operational reference, not person-linkable", same call as Razorpay `settlement_id`). Field allowlist drops anything else. |
| **I-E02 replayability** | `ad_spend_ledger` append-only by GRANT (SELECT+INSERT, no UPDATE/DELETE); rebuildable from Bronze; trailing re-read produces idempotent rows (ON CONFLICT DO NOTHING). |
| **I-ST04 idempotency** | `(brand_id, event_id)` on the live lane; `ad_spend_ledger` ON CONFLICT `(brand_id, platform, level, level_id, stat_date)` DO NOTHING — re-pull replay creates no duplicate spend. |
| **I-E03/I-ST01 one read path** | spend metrics computed only in metric-engine; surfaced only via the BFF analytics routes → metric engine. No StarRocks direct read added. |
| **No new deployable/topic/envelope** | Confirmed — `spend.live.v1` is an event_name on `collector.event.v1`; jobs run inside the existing stream-worker. |

---

## 4. Data model (migrations — ADDITIVE ONLY)

### Migration `0028_ad_spend.sql` (@data-engineer)

Mirrors `0027` structure exactly. Parts:

**(A) `connector_instance` provider CHECK extension + ads account column**
```sql
ALTER TABLE connector_instance DROP CONSTRAINT IF EXISTS connector_instance_provider_check;
ALTER TABLE connector_instance ADD CONSTRAINT connector_instance_provider_check
  CHECK (provider IN ('shopify','razorpay','meta','google_ads'));
-- ads account ref for connect identity + webhook-free brand resolution (NULL for shopify/razorpay)
ALTER TABLE connector_instance ADD COLUMN IF NOT EXISTS ad_account_id TEXT NULL;
CREATE INDEX IF NOT EXISTS connector_instance_ad_account_idx
  ON connector_instance (ad_account_id) WHERE ad_account_id IS NOT NULL;
```
> NOTE: `ConnectorInstance.create()` already skips `*.myshopify.com` validation when
> `shopDomain` is empty (`ConnectorInstance.ts:78-84`) — ads connectors pass `shopDomain=''`.

**(B) `ad_spend_ledger` — append-only fact (FORCE-RLS, GRANT-append, ON CONFLICT dedup)**
```sql
CREATE TABLE IF NOT EXISTS ad_spend_ledger (
  brand_id              UUID        NOT NULL,                 -- RLS anchor (I-S01)
  spend_event_id        TEXT        NOT NULL,                 -- deterministic dedup id (ADR-AD-5)
  platform              TEXT        NOT NULL CHECK (platform IN ('meta','google_ads')),
  level                 TEXT        NOT NULL CHECK (level IN ('campaign','adset','ad','creative')),
  level_id              TEXT        NOT NULL,                 -- platform-native id (operational ref, not PII)
  parent_id             TEXT        NULL,                     -- hierarchy edge (campaign→adset→ad→creative)
  campaign_id           TEXT        NULL,
  campaign_name         TEXT        NULL,                     -- display only (allowlisted; not PII)
  stat_date             DATE        NOT NULL,                 -- click-date anchored (canonical, ADR-AD-8)
  spend_minor           BIGINT      NOT NULL,                 -- I-S07 minor units, NO float
  currency_code         CHAR(3)     NOT NULL,
  impressions           BIGINT      NULL,
  clicks                BIGINT      NULL,
  conversions_raw       JSONB       NULL,                     -- RAW conversions/all_conversions (ADR-AD-8) — Silver picks canonical
  account_timezone      TEXT        NULL,                     -- platform stat tz (timezone-aware mapping)
  raw_event_id          TEXT        NOT NULL,                 -- Bronze provenance
  occurred_at           TIMESTAMPTZ NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (brand_id, spend_event_id)
);
-- Dedup / restatement key: re-read the same (platform,level,level_id,stat_date) → DO NOTHING.
-- Restatement of conversions over the window writes a NEW row only if spend_event_id differs;
-- spend is fixed at click-date so spend_minor for a given key is stable (ADR-AD-8).
CREATE UNIQUE INDEX IF NOT EXISTS ad_spend_ledger_dedup_key
  ON ad_spend_ledger (brand_id, platform, level, level_id, stat_date);
CREATE INDEX IF NOT EXISTS ad_spend_ledger_brand_date_idx
  ON ad_spend_ledger (brand_id, stat_date);

ALTER TABLE ad_spend_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE ad_spend_ledger FORCE ROW LEVEL SECURITY;
CREATE POLICY ad_spend_ledger_isolation ON ad_spend_ledger
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);
REVOKE ALL ON ad_spend_ledger FROM brain_app;
GRANT SELECT, INSERT ON ad_spend_ledger TO brain_app;   -- append-only (I-E02): NO UPDATE/DELETE
```

**(C) `ad_spend_as_of(p_brand_id uuid, p_from date, p_to date)` read seam** — SECURITY INVOKER,
runs under the caller's brand GUC; the SOLE spend read path for the metric engine (mirrors
`realized_gmv_as_of`). Returns SUM(spend_minor) per (platform, currency_code[, bucket]).

**(D) `list_ad_connectors_for_spend_repull()` — SECURITY DEFINER enumeration fn**
(mirrors `0027:190-211` exactly: `LANGUAGE sql`, `SECURITY DEFINER`, `STABLE`, `SET search_path = public`,
dispatch-only cols `(connector_instance_id, brand_id, provider, secret_ref, ad_account_id)`,
`WHERE provider IN ('meta','google_ads') AND status='connected'`, `GRANT EXECUTE TO brain_app`).

**(E) Migration-time assertion DO-blocks** (`SEC-AD-0028a..`): `prosecdef=true`, `search_path=public`,
`brain_app EXECUTE`, fn exists — one trio per fn (mirror `0027:251-318`).

**(F) Post-migration assertions:** `ad_spend_ledger` has RLS + FORCE RLS; `spend_minor` is `bigint`
(NO-FLOAT-SQL I-S07 guard); all new-table policies use the two-arg `current_setting(...,TRUE)` form
(NN-1 guard) — mirror `0027:389-455`.

**ROLLBACK** (header comment): `DROP TABLE IF EXISTS ad_spend_ledger; DROP FUNCTION ...; ALTER TABLE
connector_instance DROP COLUMN IF EXISTS ad_account_id;` (ledger rebuildable from Bronze — safe).

### Migration `0029` — RESERVED, only if Track 1 finds a connect-side schema need (e.g. a
`connector_oauth_provider` config row). Default expectation: NOT needed (catalog is a code const).
Builders MUST confirm before adding; do not create an empty migration.

---

## 5. Build tracks

> 4 parallel tracks. Tracks 1+2 share migration 0028 ownership (Track 2 = @data-engineer owns the
> migration file; Track 1 = @backend-developer consumes the provider-CHECK + ad_account_id additions).
> **Deploy-pipeline note:** no new service/deployable is created — Meta/Google jobs run inside the
> EXISTING `stream-worker` deployable and connect routes inside the EXISTING `core` deployable. Per
> STACK ADR-010 the existing affected-only CI → ECR → Helm → ArgoCD pipeline ships these via the
> existing per-deployable apps; the new Argo job manifests (per-platform repull schedule) are the
> only deploy artifacts and ride the existing `deployments/` overlay for stream-worker jobs. NO
> deploy-all. (Canary/progressive-delivery is Phase-4-deferred per ADR-010 — not in scope.)

### TRACK 1 — Connect (OAuth) — `@backend-developer`

**Scope:** Flip catalog tiles to `available`; register Meta + Google OAuth dispatch; per-provider
initiate + callback commands (brand from state, never body); tokens via the generic secrets seam;
`connector_instance` rows with `provider='meta'|'google_ads'` + `ad_account_id`; honest dev boundary.

**Files / seams:**
- `registry.ts:60,68` — flip `meta` + `google_ads` `availability` → `'available'` (2-min edit).
- NEW `…/sources/advertising/meta/application/commands/InitiateMetaOAuthCommand.ts` + `HandleMetaOAuthCallbackCommand.ts` — clone `InitiateOAuthCommand.ts` / `HandleOAuthCallbackCommand.ts`; **drop the HMAC step** (no Shopify HMAC on ads callback); **state nonce IS the auth** — brand from `stateStore.consumeAndGetBrandId(state)` (`HandleOAuthCallbackCommand.ts:96-101`), NEVER from the query body; Meta scopes = `ads_read`; token exchange against `graph.facebook.com/v25.0/oauth/access_token`.
- NEW `…/sources/advertising/google/application/commands/InitiateGoogleAdsOAuthCommand.ts` + `HandleGoogleAdsOAuthCallbackCommand.ts` — same pattern; Google scope = `https://www.googleapis.com/auth/adwords`; token exchange against `https://oauth2.googleapis.com/token`; store the **refresh_token** (Google access tokens are short-lived) via `storeSecret` as a JSON bundle `{ refresh_token, ad_account_id }` (same multi-cred-bundle pattern as Razorpay `RazorpaySecretBundle`, `razorpay-settlement-repull/run.ts:84-89`). Developer-token note: an approved Google developer token is a platform follow-up (dev uses sandbox/test account).
- NEW `…/sources/advertising/{meta,google}/interfaces/http/*ConnectorRoutes.ts` — clone `shopifyConnectorRoutes.ts`: `GET /api/v1/connectors/{meta,google_ads}/install` (manager+, returns `oauth_url`) + `GET …/callback` (public; state-nonce auth; NO brandId from query). Reuse the `/api/v1/connectors` list + `/:id/status` + `DELETE /:id` (already generic).
- Register both dispatch handlers in the composition root (`main.ts` — find the `registerOAuthDispatch('shopify', …)` call and add the two).
- Secrets: use `storeSecret(brandId, { connectorType:'meta', subKey: adAccountId }, { access_token })` and the Google bundle — **no new secrets method** (`ISecretsManager.ts:46`).

**Tests (REQUIRED pass-1):**
- Brand-from-state, never-from-body: a callback with a forged `brand_id` query param MUST resolve the brand from the server-stored nonce only (clone `HandleOAuthCallbackCommand.test.ts` + `OAuthStateNonce.test.ts`).
- Token never persisted to Postgres / never logged: assert `connector_instance.secret_ref` holds only the ARN, and a log-capture asserts no token substring (clone `SecretRef.test.ts`).
- Catalog: `meta`/`google_ads` render `available`; unknown provider in dispatch → null → caller 400/422 (`connector-marketplace.live.test.ts`).
- State nonce single-use + 15-min TTL + brand-bound (`OAuthStateNonce.test.ts`).
- **Dev-honesty:** an integration test that seeds a synthetic `meta` connector via the lifecycle fixtures and asserts the status surface reflects REAL `connector_sync_status` (never a simulated badge).

**UI surface:** none directly (provides the install endpoints Track 4 calls).

### TRACK 2 — Spend ingestion (the trailing re-pull) — `@data-engineer`

**Scope:** Migration 0028; the two per-platform API clients; the trailing ~28-day re-read cursor
(overlap-locked, throttle-aware); the `@brain/ad-spend-mapper`; canonical mapping → Bronze (raw) →
`ad_spend_ledger` via a live-lane consumer.

**Files / seams:**
- `db/migrations/0028_ad_spend.sql` — as §4 (own the whole file).
- NEW `packages/ad-spend-mapper/src/index.ts` — clone `razorpay-mapper`: `SPEND_LIVE_V1_EVENT_NAME='spend.live.v1'`; `AD_SPEND_FIELD_ALLOWLIST` (spend, impressions, clicks, conversions raw set, campaign/adset/ad/creative ids+names, currency, stat_date, account tz — NO PII fields); `uuidV5FromSpendRow(brandId, platform, statDate, level, levelId)` (ADR-AD-5); `mapMetaInsightToEvent` + `mapGoogleRowToEvent` → `MappedSpendEvent`; `spend_minor` stays BIGINT-as-string (I-S07). **FROZEN API after A0 commit** (Architect sign-off to change).
- NEW `apps/stream-worker/src/jobs/meta-spend-repull/run.ts` + `meta-insights-client.ts` — clone `razorpay-settlement-repull/run.ts`: enumerate via `list_ad_connectors_for_spend_repull()` (SECURITY DEFINER, NO GUC at enumerate — durable rule); GUC-after-enumerate (brand from fn result, MT-1, NEVER from API response); ONE cursor resource `meta.insights` (28d window); `FOR UPDATE SKIP LOCKED` overlap-lock; page loop over Insights API; map → emit `spend.live.v1` to live lane (`buildPartitionKey(brandId, eventId)`); advance cursor (high-water = max stat_date) after each page; `connector_sync_status` syncing→connected. Meta API client pinned to **Graph API v25.0** (resolve latest-stable at build; v25.0 verified current Feb-2026).
- NEW `apps/stream-worker/src/jobs/google-ads-spend-repull/run.ts` + `google-ads-searchstream-client.ts` — same shape; cursor `google_ads.spend` (35d window); **GoogleAdsService.SearchStream** (1 query=1 op); GAQL over `campaign`/`ad_group`/`ad_group_ad` + `metrics.cost_micros` (micros→minor units, BIGINT) + `metrics.conversions` AND `metrics.all_conversions` (raw, ADR-AD-8) + `segments.date`; refresh-token→access-token exchange at run start; **ADR-AD-7 throttle branch**: `RESOURCE_EXHAUSTED`→`RateLimited`+abort-cursor-this-run; `RESOURCE_TEMPORARILY_EXHAUSTED`→bounded backoff (≤5, ≤30s); self-imposed QPS cap (token bucket, default 1 rps/CID). Google Ads API pinned to **v24** (resolve latest-stable at build; v24 verified current base-URL May/Jun-2026, v23.1 released Feb-2026).
- NEW `apps/stream-worker/src/interfaces/consumers/SpendLedgerConsumer.ts` — clone `SettlementLedgerConsumer.ts`: filter `event_name==='spend.live.v1'` (else commit+continue); `autoCommit=false`; map props → `LedgerWriter.writeAdSpend(...)` (NEW method, below); DLQ@max-retry; **MUST be wired in `main.ts`** (the wired-to-nothing anti-pattern is a hard bounce — see `SettlementLedgerConsumer.ts:4-9`).
- EXTEND `LedgerWriter.ts` — add `writeAdSpend({brandId, platform, level, levelId, parentId, campaignId, campaignName, statDate, spendMinor, currencyCode, impressions, clicks, conversionsRaw, accountTimezone, rawEventId})`: GUC-first; INSERT into `ad_spend_ledger`; `ON CONFLICT (brand_id, platform, level, level_id, stat_date) DO NOTHING`; BIGINT-as-string (mirror `writeSettlementFinalization`, `LedgerWriter.ts:288`).

**Tests (REQUIRED pass-1):**
- **Negative control (durable rule):** a bare `brain_app` SELECT on `ad_spend_ledger` WITHOUT the GUC returns 0 rows — run under `SET ROLE brain_app` (NOT the dev superuser, which masks RLS). Asserts the fix is non-tautological.
- Enumeration fn: `list_ad_connectors_for_spend_repull()` is SECURITY DEFINER + search_path pinned + brain_app EXECUTE (migration assertions) + returns connected meta/google connectors only.
- Idempotent re-read: run the repull twice over an overlapping window → same `ad_spend_ledger` row count (ON CONFLICT DO NOTHING; restatement-safe).
- Overlap-lock: two concurrent triggers on the same connector → second SKIPs the locked cursor (clone the razorpay lock test).
- Money: `spend_minor` BIGINT, micros→minor conversion exact, no `parseFloat` (money-lint).
- Throttle branch (Google): `RESOURCE_EXHAUSTED`→`RateLimited`+abort; `RESOURCE_TEMPORARILY_EXHAUSTED`→backoff-then-continue (unit test the client error mapping).
- **Wiring e2e:** `spend-ledger-wiring.e2e.test.ts` — un-wire `SpendLedgerConsumer` from main → poll for `ad_spend_ledger` row → timeout → RED (clone `settlement-ledger-wiring.e2e.test.ts`).
- Real-network smoke: live e2e against synthetic-fixture connectors proving connect→repull→ledger row (clone `live-connector.e2e.test.ts` / `connector-lifecycle-fixtures.ts`).

**UI surface:** none (produces `ad_spend_ledger` rows Track 4 reads via Track 3).

### TRACK 3 — Spend/ROAS metric engine + BFF — `@backend-developer` (or @data-engineer if capacity)

**Scope:** metric-engine spend + blended-ROAS metrics over the `ad_spend_as_of` seam; BFF analytics
routes (sole read path); honest-empty contract.

**Files / seams:**
- EXTEND `packages/metric-engine/src/registry.ts:50` — add `MetricId` `'ad_spend'` + `'blended_roas'`; registry rows (readSeam `ad_spend_as_of`; `blended_roas` = `realized_revenue ÷ ad_spend`, same-currency only, NEVER blended across currencies, integer-minor spend with a documented ratio output). `blended_roas` `toleranceMinor` semantics: ratio is computed from two exact integer SUMs (numerator/denominator both BIGINT) — output as a fixed-precision rational, never float-rounded silently.
- NEW `packages/metric-engine/src/ad-spend-timeseries.ts` + `blended-roas.ts` — clone `revenue-timeseries.ts`: read inside `withBrandTxn` (GUC transaction-scoped, F-SEC-02); `computeAdSpendTimeseries(brandId,{from,to,grain,platform?},deps)` returns `{bucket, platform, currency_code, spendMinor}`; `computeBlendedRoas(brandId,{from,to},deps)` returns `{currency_code, realizedMinor, spendMinor, roasRatio}` per currency (ROAS only where spend>0; spend=0 → null, honest).
- EXTEND BFF `bff.routes.ts:1025` — add `GET /api/v1/analytics/ad-spend-timeseries?from&to&grain&platform?` + `GET /api/v1/analytics/blended-roas?from&to`, each calling an analytics-module wrapper → metric engine (ADR-002 sole read path; clone the `revenue-timeseries` route + add the wrappers in `analytics/index.js`).
- Contracts: add Zod request/response schemas in `packages/contracts/api` for the two routes (I-E01 contract-first).

**Tests (REQUIRED pass-1):**
- Parity-oracle entry for `ad_spend` (TS engine SUM vs independent SQL recompute on a snapshot → 0 delta; I-E04).
- Sole-read-path: assert no StarRocks/Iceberg client instantiated; the route reaches the engine only.
- Honest empty: zero spend → `[]` / null ROAS, never a fabricated 0-or-error.
- Cross-currency guard: ROAS never blends across currency_code.
- RLS: metric reads scoped to active brand (GUC) — cross-brand returns nothing.

**UI surface:** none (the data contract Track 4 binds).

### TRACK 4 — Spend/ROAS UI (MANDATORY, stakeholder-visible) — `@frontend-web-developer`

**Scope:** Meta/Google marketplace tiles become connectable (OAuth flow in the UI); a Spend/ROAS
analytics section (spend over time by platform/campaign + first blended ROAS), reusing the analytics
components; honest empty + loading + error states.

**Files / seams:**
- Marketplace tiles: wire the `meta`/`google_ads` tiles (now `available`) to a "Connect" CTA that hits `GET /api/v1/connectors/{meta,google_ads}/install` → redirects to `oauth_url` (mirror the Shopify connect button flow; reuse the connector list rendering).
- NEW `apps/web/app/(dashboard)/analytics/spend/page.tsx` + `spend-content.tsx` — clone `analytics/revenue/` page + content.
- REUSE `apps/web/components/analytics/kpi-tile.tsx` (a ROAS KPI tile + a Spend KPI tile) + `trend-chart.tsx`/`orders-trend-chart.tsx` (spend-over-time by platform/campaign, a platform/campaign filter).
- NEW hooks in `apps/web/lib/hooks/use-analytics.ts` — `useAdSpendTimeseries(params)` + `useBlendedRoas(params)` (clone `useRevenueTimeseries`/`useKpiSummary`; queryKey under `['analytics', …]` so the brand-switcher invalidation already covers them).
- `apps/web/lib/api/client.ts` — add `analyticsApi.adSpendTimeseries` / `.blendedRoas`.

**Tests (REQUIRED pass-1):**
- E2E (clone `e2e/analytics-revenue.spec.ts`): connect-tile renders for meta/google; spend section renders spend chart + ROAS tile; **honest empty** (no connector → empty state with a connect CTA, never a fake number); loading + error states present.
- Connect CTA hits the install endpoint and redirects (mock the oauth_url).

**UI surface:** the marketplace Meta/Google connectable tiles + the `/analytics/spend` Spend/ROAS section (KPI tiles + spend-over-time chart + platform/campaign filter).

---

## 6. Acceptance contract (folded must-fix items — REQUIRED pass-1)

> No `02-cto-advisor-review.md` / persona reviews exist in this run dir (only `01-requirement.md`).
> The following are the binding pass-1 acceptance items distilled from the requirement constraints +
> the durable rule + the Canon invariants — a builder PR missing any of these is a bounce:

1. **brand-from-state, never-from-body** on both ads callbacks (Track 1) — tested with a forged-body test.
2. **token never in Postgres / never logged / never in events** (Tracks 1+2) — secret_ref ARN only.
3. **SECURITY DEFINER enumeration fn + GUC-after-enumerate + non-inert negative control under `brain_app`** (Track 2) — durable rule `system-job-force-rls-enumeration`.
4. **`ad_spend_ledger` FORCE-RLS two-arg fail-closed + append-only GRANT** (Track 2 migration).
5. **`spend_minor` BIGINT minor units, no float, micros→minor exact** (Tracks 2+3).
6. **idempotent trailing re-read** (ON CONFLICT DO NOTHING; run-twice → same row count) (Track 2).
7. **SpendLedgerConsumer wired in main.ts + wiring e2e** (Track 2) — wired-to-nothing is a hard bounce.
8. **No new topic/envelope/deployable** — `spend.live.v1` on `collector.event.v1`; jobs inside stream-worker (all tracks).
9. **Google two-error throttle branch + QPS cap** (Track 2) — ADR-AD-7.
10. **metric-engine sole read path + parity oracle entry for `ad_spend`** (Track 3) — I-E03/I-E04/I-ST01.
11. **honest empty UI** (no connector / zero spend → empty state + connect CTA, never a fabricated number) (Track 4).
12. **dev-honesty:** synthetic-fixture proof of connect→repull→ledger→UI; status surface shows REAL sync_status (all tracks).

---

## 7. Alternatives considered + rejected

- **(A) Spend in `realized_revenue_ledger` as a negative event_type.** Rejected: corrupts `realized_gmv_as_of()` SUM, mixes two grains (order-keyed vs campaign-keyed), and forces spend to inherit revenue's dedup key `(brand_id, order_id, event_type, date)` which has no natural `order_id`. Dedicated `ad_spend_ledger` is cleaner and keeps the revenue ledger pure.
- **(B) A new `ad.spend.v1` Kafka topic + Avro envelope.** Rejected: violates "no new topic/envelope"; the collector.event.v1 envelope already carries `event_name` + `properties` and both order.live.v1 and settlement.live.v1 ride it. An event_name value is sufficient and FULL_TRANSITIVE-safe.
- **(C) Split Meta and Google into two sequential slices.** Rejected: duplicates the UI track + the migration + the mapper-package scaffolding; the per-platform divergence is one API-client + one mapper-fn each — cheap as parallel tracks. Parallel ships the full stakeholder-visible value in one slice (ADR-AD-1).
- **(D) Conversion-date-anchored spend as canonical in Slice 1.** Rejected for canonical (still stored RAW): spend is fixed at click-time (the COD-restatement insight), so click-date anchoring is the correct canonical for a first ROAS read; conversion-date restatement is the metric-engine's job over the trailing window and can graduate without a schema change (raw is in Bronze + `conversions_raw` JSONB).
- **(E) A separate Argo deployable for ad jobs.** Rejected: I-E05 — jobs run inside the existing stream-worker, scheduled by Argo, exactly as the Razorpay/Shopify repulls.

---

## 8. Over-engineering self-check — PASS

Reuses every primitive; adds 1 mapper package + 2 migrations (one likely unused/reserved) + 2 jobs +
1 consumer + metric/BFF/UI extensions. No new deployable, topic, envelope, service, or model call.
Tier-0 deterministic. The only genuinely new persisted artifact is `ad_spend_ledger` (a distinct
economic fact, justified in ADR-AD-6). Plan length matches a high-stakes connector slice with 4
parallel builder tracks. Reversible (additive migrations, ledger rebuildable from Bronze).

---

## 9. Handoff state

- **status:** dev-parallel
- **stage:** 3
- **owner:** builders — `@backend-developer` (Tracks 1, 3) ∥ `@data-engineer` (Track 2, + 0028 migration, + Track 3 metrics if capacity) ∥ `@frontend-web-developer` (Track 4)
- **migrations:** `0028_ad_spend.sql` (binding) · `0029` reserved (confirm-before-create)
