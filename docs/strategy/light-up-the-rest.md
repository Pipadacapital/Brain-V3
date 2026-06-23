# Light Up the Rest — Deploy / Connect Guide

The Insight + Opportunity Engine + AI Copilot is **live and real-data-backed**. Five insight detectors
already fire on real Shopify + pixel data and each is an audited, actionable recommendation:

| Detector | Source marts | Status |
|---|---|---|
| `rto_leakage` (COD/RTO leakage %) | `gold_executive_metrics` | ✅ live (37.6%) |
| `revenue_trend` (30d swing + driver) | `gold_revenue_ledger` | ✅ live (+245%) |
| `cac_trend` (CAC MoM) | `gold_cac` (real customers × spend) | ✅ live (spend seeded) |
| `blended_roas` (realized ÷ ad spend) | `gold_revenue_ledger` + `silver_marketing_spend` | ✅ live (spend seeded) |
| `funnel_dropoff` (leakiest stage) | `silver_touchpoint` (real pixel) | ✅ live (0% reach checkout) |

The remaining capabilities are **data / instrumentation-gated, not code-gated** — the engine, pipeline,
live ingestion paths, and reproducible backfills are all built and verified. This doc is the exact set
of **external actions** (Shopify deploys, OAuth connects) that light up the rest, what each unlocks, and
how to verify.

---

## ⭐ #1 — Deploy the Web-Pixel checkout extension (highest leverage: unlocks THREE things)

**What:** the storefront pixel must (a) emit a `checkout.started` event and (b) write `brain_anon_id`
(+ utm / click_ids) into the Shopify checkout `note_attributes`. The order webhook already reads these
back (`shopifyWebhookHandler` → `connector_journey_stitch_map`; `shopify-mapper` extracts
`stitched_anon_id`, "NEVER inferred").

**Why it's the top priority — one deploy lights up three gaps:**
1. **Attribution paths** (`gold_attribution_paths`, multi-touch / channel-ROAS-by-path) — today 0 rows.
   Verified root cause: anon journey sessions and order customers are **disjoint identity islands**
   (0 events carry both a `brain_anon_id` and a customer id), so they can't be stitched deterministically.
2. **Identity bridge** (anon ↔ known customer) — the same `note_attributes` value links an anonymous
   journey to the resolved customer, enriching Customer 360 / LTV with pre-purchase behavior.
3. **Funnel checkout stage** — `funnel_dropoff` currently reads "0% of cart adds reach checkout" because
   no `checkout.started` events arrive. This makes that stage real.

**Action (your side, Shopify):** deploy the Web Pixel / checkout-UI extension that sets the
`note_attributes` (`brain_anon_id`, `utm_*`, `*clid`) at checkout, and emits `checkout.started`.

**Then (Brain side, automatic + one backfill):**
- New orders stitch automatically via the live webhook path.
- Historical orders: `tools/backfill/backfill-journey-stitch-map.sh <BRAND_UUID>` (deterministic,
  identity-graph based; no-op until the bridge exists — never guesses).
- Rebuild marts: `make insights-pipeline`.

**Verify:**
```bash
# bridge events should be > 0 once checkout writes note_attributes
docker exec brainv3-starrocks-1 mysql -P9030 -h127.0.0.1 -uroot -N -e \
 "SELECT count(*) FROM brain_bronze_local.brain_bronze.collector_events
  WHERE event_type='checkout.started' AND brand_id='<BRAND>';"
# attribution paths populate
docker exec brainv3-starrocks-1 mysql -P9030 -h127.0.0.1 -uroot -N -e \
 "SELECT count(*) FROM brain_gold.gold_attribution_paths WHERE brand_id='<BRAND>';"
```

---

## #2 — Connect a Meta / Google Ads account (real CAC & ROAS)

**What:** OAuth-connect the brand's Meta and/or Google Ads account in the UI
(Settings → Connectors). The connectors + `meta-spend-repull` / `google-ads-spend-repull` jobs →
`SpendLedgerConsumer` → `billing.ad_spend_ledger` are all built.

**Unlocks:** `cac_trend` and `blended_roas` on **real** spend (today they run on clearly-labelled
`[SAMPLE]` seeded spend; the CAC mart already uses your real customer counts).

**Action (your side):** connect the ad account(s) via OAuth, then trigger a sync.

**Dev/demo shortcut (until connected):** `tools/seed/ad-spend-demo-seed.sh <BRAND_UUID>` seeds
`[SAMPLE]` spend through the real `ad_spend_ledger` path, then `make insights-pipeline`.

**Verify:**
```bash
docker exec brainv3-postgres-1 psql -U brain -d brain -tAc \
 "SELECT platform, count(*), sum(spend_minor) FROM billing.ad_spend_ledger
  WHERE brand_id='<BRAND>' GROUP BY platform;"
```

---

## #3 — Order line-item depth (top-products insight)

**What:** the connector order events (`order.live.v1`) currently carry order totals but **no
`line_items`**, so `silver_order_line` (and any top-products / per-SKU insight) is empty.

**Action (Brain side):** extend the Shopify order mapper/repull to capture `line_items` into the order
event payload (the Iceberg Bronze + `silver_order_line` lineage already exists). This is a **code**
change (not external) — a good next engineering task if SKU-level insight is wanted.

**Verify:** `SELECT count(*) FROM brain_silver.silver_order_line WHERE brand_id='<BRAND>';` > 0.

---

## #4 — Churn / VIP insights (time + customer history)

**What:** `churn_recovery` and `vip_concentration` are built and correct but don't fire for a
~1-month-old store: all customers are recency-`low` and monetary-tier-1 (no lapsed or high-LTV cohort
exists yet). This is **honest** — the engine refuses to fabricate a churn/VIP cohort.

**Unlocks naturally:** as the store accumulates ≥90-day-old customers and higher-LTV repeat buyers, the
RFM bands (`gold_customer_scores`) populate `high` churn-risk and monetary-tier-5 rows and the insights
fire automatically. No action needed beyond time / connecting a brand with deeper history.

**Verify:**
```bash
docker exec brainv3-starrocks-1 mysql -P9030 -h127.0.0.1 -uroot -e \
 "SELECT churn_risk, count(*) FROM brain_gold.gold_customer_scores WHERE brand_id='<BRAND>' GROUP BY churn_risk;"
```

---

## Reproducible Brain-side commands (already shipped)

| Command | Purpose |
|---|---|
| `make insights-pipeline` | Wire `brain_oltp_pg` catalog + build all 30 marts from real data (one command) |
| `tools/backfill/backfill-ledger-brain-id.sh <brand>` | Stamp `brain_id` on historical orders (after migration 0095) |
| `tools/backfill/backfill-journey-stitch-map.sh <brand>` | Deterministic journey→order stitch (no-op until #1) |
| `tools/seed/ad-spend-demo-seed.sh <brand>` | `[SAMPLE]` ad spend to demo CAC/ROAS until #2 |
| `tools/seed/insights-demo-seed.sh <brand>` | Seed gold marts directly to demo `/insights` offline |

## Priority order
1. **Web-Pixel checkout extension** (#1) — one deploy, three unlocks (attribution paths + identity bridge + funnel checkout).
2. **Connect an ad account** (#2) — real CAC/ROAS.
3. **Order line-item mapper** (#3) — code task, if SKU insight is wanted.
4. **Churn/VIP** (#4) — automatic over time.
