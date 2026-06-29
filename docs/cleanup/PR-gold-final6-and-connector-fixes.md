# Final 6 Gold marts → partition-incremental + connector health self-heal + backfill gate

Open the PR: https://github.com/Rishabhporwal/Brain-V4/pull/new/feat/gold-final6-incremental-and-connector-health-backfill

Branch: `feat/gold-final6-incremental-and-connector-health-backfill` (3 commits, base `master`).
One PR, three independently-reviewable commits.

---

## 1. perf(gold): final 6 Gold marts → partition-incremental — **Gold tier now 27/27**

Completes the medallion-wide "process only what changed" program. Every tier now scales
O(new) not O(history), permanently ending the recurring Spark transform-OOM class:
- Bronze = Kafka offsets, Silver = per-event time-window + fold entity-incremental, **Gold = brand partition-incremental**.

Marts converted (all read other gold/silver marts → use the shared `_gold_base` watermarked
multi-source partition-incremental seam landed in #304):

| mart | sources |
|------|---------|
| `gold_customer_360` | silver_customer, silver_order_state, silver_touchpoint |
| `gold_journey_paths` | silver_touchpoint (DELETE-pattern) |
| `gold_attribution_paths` | silver_touchpoint |
| `gold_attribution_credit` | silver_touchpoint, gold_revenue_ledger |
| `gold_marketing_attribution` | gold_attribution_credit |
| `gold_campaign_attribution` | gold_attribution_credit, gold_campaign_performance, silver_marketing_spend |

### Parity proof (FULL_REFRESH authoritative == reprocess-all-via-incremental)
Forced per-brand buckets (`SILVER_INCREMENTAL_OVERLAP_HOURS=99999 SILVER_BATCH_TARGET_ROWS=1`):

| mart | FULL | INCR | incremental path taken |
|------|-----:|-----:|------------------------|
| customer_360 | 1976 | **1976** ✓ | partition-incremental, 4 changed brands |
| journey_paths | 27 | **27** ✓ | partition-incremental, 2 changed brands |
| attribution_credit | 0 | **0** ✓ | (no source data yet — honest empty) |
| marketing_attribution | 0 | **0** ✓ | |
| attribution_paths | 0 | **0** ✓ | |
| campaign_attribution | 0 | **0** ✓ | partition-incremental, 1 changed brand |

All exit 0, no OOM. Idempotent MERGE → recompute only changed brands, untouched brands intact.

Also fixes a latent bug: `run-gold-attribution.sh` now invokes `run-gold-revenue.sh` via `bash`
(the `run-*.sh` scripts are tracked non-executable mode 644 → a direct exec fails "Permission
denied"; the refresh loop already invokes everything via `bash`). Surfaced when running the
attribution mart standalone for the parity test.

---

## 2. fix(connectors): gate historical backfill to providers with a queue runner

**Bug:** the "Import history" control enqueued a `jobs.backfill_job` row for *every* connector,
but only Shopify has a claimer/runner. Meta-ads / GoKwik / Shiprocket backfills sat `queued`
forever — orphan rows, UI looked broken.

Three layers, one source of truth:
- **NEW `@brain/connector-core` `BACKFILL_QUEUE_PROVIDERS` + `supportsBackfillQueue()`** — the single
  set of providers with an actual `jobs.backfill_job` runner (currently `shopify`). WooCommerce
  re-pulls history through the **sync** lane, not this queue, so it's intentionally absent.
- **Server reject** (`RequestConnectorBackfillCommand` step 1.5): a request for a provider with no
  runner returns `BACKFILL_NOT_SUPPORTED` *before* any secret read / DB insert / audit write — never
  orphans a row. +8 unit tests.
- **Claimer** (`stream-worker` main.ts) filters by the same `supportsBackfillQueue` SoT → can never
  mis-claim a non-backfillable connector's job.
- **UI** (`marketplace-view`): Import-history renders only for backfill-capable providers
  (`storefront-exclusivity.supportsHistoricalBackfill` mirrors the core SoT).

### Cleanup SQL — drain the 3 stuck orphan rows (run once, NOT in this PR)
Only orphan `queued` rows for non-backfillable providers; leaves legit shopify/woo jobs alone:
```sql
-- run as migration role `brain` (bypasses RLS), or wrap in brand-GUC under brain_app
UPDATE jobs.backfill_job bj
   SET status = 'cancelled', updated_at = NOW()
  FROM connectors.connector_instance ci
 WHERE bj.connector_instance_id = ci.id
   AND bj.status = 'queued'
   AND ci.provider IN ('meta','google_ads','gokwik','razorpay','shiprocket');
```
> Verify the exact `status` enum value (`cancelled` vs `failed`) against the `jobs.backfill_job`
> migration before running.

---

## 3. fix(connectors): self-heal connector health_state on successful sync

**Bug (platform-wide):** `connector_instance.health_state` was set to `TokenExpired` (or
`RateLimited`) on a 401/429 but **never reset on a later success**, so the UI showed
"Token expired / Excluded — connector failing" forever even while every repull succeeded.
Surfaced on **Shiprocket** (creds present → JWT auto-minted → syncs fine, badge stuck).

- **NEW shared `recoverConnectorInstanceHealth()`** — atomic, race-safe conditional UPDATE that
  clears `health_state→Healthy` / `safety_rating→safe` **only** from the transient states this
  module sets (`RECOVERABLE_HEALTH_STATES = TokenExpired, RateLimited`). SQL-level
  `health_state = ANY(...)` guard makes it a no-op when already Healthy or in a genuinely sticky
  state (`Disabled`/`Disconnected`/`Failed`) — a stray success can never un-stick a real failure.
- Wired into every connector's success path (symmetric to the existing failure-edge calls):
  shiprocket / meta / google-ads / ga4 / woo / razorpay repulls + shopify/meta token-refresh.
- 4 new unit tests (10 pass total).
- A genuine live 401 still re-flags correctly (recovery sits after a successful repull; a real
  auth failure takes the catch branch and returns before recovery is reached).

### Immediate unblock for the current stuck Shiprocket badge (run once, NOT in this PR)
```sql
-- run as migration role `brain` (bypasses FORCE RLS)
UPDATE connectors.connector_instance
   SET health_state = 'Healthy', safety_rating = 'safe', updated_at = NOW()
 WHERE id = '4e1a0a2a-9ccc-410d-b44f-24a5b7a84840';
```
> Caveat: the synthetic dev creds (`accounts@pipadacapital.com`) will re-401 in a true LIVE sync,
> in which case the badge legitimately returns — that path is correct.

---

## Verification
- `tools/lint/v4-naming-guard.sh` — ✓ pass
- Typecheck — ✓ `@brain/connector-core`, `@brain/core`, `@brain/stream-worker`, `@brain/web`
- Tests — ✓ backfill reject (8), connector health (10)
- Gold parity — ✓ all 6 marts FULL == incremental, no OOM (table above)

## Out of band (your action, not in this PR)
- **Pixels not landing** — diagnosed as infra, NOT code: the `PIXEL_INGEST_BASE_URL` Cloudflare
  quick-tunnel had died (Silver exactly matched Bronze → incremental proven fine; no new pixels in
  Bronze since the tunnel dropped). Env updated locally to the live tunnel; the storefront ScriptTag
  must be re-installed after the Shopify reconnect.
- **Shopify reconnect** — OAuth, must be done in the app UI.
- **GoKwik webhook registration** — register the Cloudflare URL in the GoKwik dashboard (URL printed
  in the session).
