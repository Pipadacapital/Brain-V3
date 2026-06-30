# Scope: Ad creatives & demographic breakdowns (deferred UI item 2)

**Status: SCOPE (not built).** This is a **connector-ingestion** project, NOT a UI task — the campaigns
detail page (P2) already honest-empties "creatives" and "demographic breakdown"; the blocker is that the
data is never ingested. Delivering it needs new Meta/Google API pulls (+ scopes + real ad data), then the
medallion flow, then wiring the existing UI panels. This doc scopes that.

## 0. What the UI is waiting for
`/marketing/campaigns` detail (P2) has two honest-empty panels:
- **Creatives** — per-ad creative thumbnails + title/body/format.
- **Demographic breakdown** — spend/impressions/clicks/conversions by age × gender × placement.

## 1. What already exists (so we extend, not rebuild)
- **Spend** at campaign/adset/ad level: `meta-spend-repull` (`meta-insights-client.ts`, GET
  `/act_{id}/insights` fields=impressions/clicks/spend, sync+async, rate-limit-aware) and
  `google-ads-spend-repull` (GAQL metrics). Canonical `spend.live.v1` via `@brain/ad-spend-mapper`.
- **Entity metadata**: `meta-entity-sync` pulls campaign/adset/ad id+name+status+objective (NOT creatives).
- **Key**: `ad-spend-mapper` **already declares `AdSpendLevel = 'campaign'|'adset'|'ad'|'creative'`** and
  treats ad ids/names as operational refs (no PII) — so creative-level spend is already a modeled grain.
- **Bronze raw lanes**: `meta_spend_raw`, `google_spend_raw`; backfill framework (#309) can drive new lanes.
- **Money discipline**: spend = bigint minor + currency_code, never blended (`uuidV5FromSpendRow`).

## 2. Two distinct sub-features (different shapes — sequence them)

### 2A. Ad-creative metadata (do FIRST — low cardinality, low risk)
Dimensional, ~1 row per ad creative. No metric explosion.
- **Meta**: `GET /act_{id}/adcreatives` fields=`id,name,object_type,thumbnail_url,image_url,body,title,
  call_to_action_type,effective_object_story_id` (or per-ad `GET /{ad_id}?fields=creative{...}`). Needs
  `ads_read`. Extend `meta-entity-client.ts` (it already pulls ads) with a creatives pass.
- **Google**: GAQL `ad_group_ad.ad` (responsive-search/display ad text + `ad.image_ad`, asset resources
  via `asset` for image/video). Extend `google-ads-searchstream-client.ts`.
- **Pipeline**: new event `ad.creative.v1` (server-trusted, brand from connector row — MT-1; no PII) →
  Bronze (`meta_creative_raw` / `google_creative_raw` lanes OR fold into the entity lane) → Silver
  `silver_ad_creative` (canonical: brand_id, platform, ad_id, creative_id, name, format, thumbnail_url,
  title, body, cta, updated_at) → Gold `gold_ad_creative` (brand_id pk[0], joinable to spend by ad_id) →
  `mv_gold_ad_creative` → endpoint `GET /api/v1/analytics/campaigns/:campaignId/creatives` → UI panel.
- **Note**: `thumbnail_url` is a Meta/Google-hosted URL (expiring for some). Store the URL; the UI loads
  it client-side. Consider a later thumbnail-cache to S3 if links expire.

### 2B. Demographic breakdowns (do SECOND — high cardinality + cost)
A metric breakdown, NOT dimensional: spend/impr/clicks/conv by (ad × age × gender × placement × date).
- **Meta**: SEPARATE insights call with `breakdowns=age,gender,publisher_platform` (placement) — Meta
  does NOT allow arbitrary breakdown combos; validate the allowed set per API version. This MULTIPLIES
  the insights row count (age[7]×gender[3]×placement[~5] ≈ 100× per ad/day) → real API-call + Bronze
  volume + rate-limit cost. Use the async insights path (already supported) + a coarser default
  (e.g. age+gender only; placement opt-in).
- **Google**: GAQL `age_range_view` / `gender_view` (segments). Demographics are a separate report.
- **Pipeline**: new event `spend.demographic.v1` (or reuse `spend.live.v1` with demo dims on the row —
  but that breaks the existing `uuidV5FromSpendRow(brand,platform,statDate,level,levelId)` key, so use a
  NEW key incl. the demo dims) → Bronze `meta_spend_demo_raw` / `google_spend_demo_raw` → Silver
  `silver_ad_spend_demographic` → Gold `gold_ad_demographic` (brand_id pk[0]; grain brand×platform×ad×
  age×gender×placement×date; money minor+currency, NEVER blended across demos) → `mv_gold_ad_demographic`
  → endpoint `GET /api/v1/analytics/campaigns/:campaignId/demographics` → UI charts.
- **Privacy**: demographics are AGGREGATE (no PII), but apply **small-cohort suppression** (Meta/Google
  already suppress <N; mirror a min-threshold so the UI never implies a tiny identifiable cohort).

## 3. Prerequisites / blockers (why this is gated, not buildable-now)
1. **API scopes**: Meta `ads_read` (likely already granted for spend — verify it covers adcreatives +
   breakdowns); Google Ads **developer token** + `https://www.googleapis.com/auth/adwords`. Confirm both
   reconnect-grant the needed scopes (the install flow may need a scope bump → user reconnect).
2. **Real ad-account data**: the dev env has synthetic/limited spend and **no creative assets / demo
   rows** — so this can't be verified end-to-end locally; needs a real connected ad account with creatives.
3. **Rate limits + cost**: 2B multiplies insights calls ~100× (cost-audit territory) — default to async +
   coarse breakdowns + a backfill window cap; do NOT pull demographics on the live 28/35-day repull cadence
   by default (schedule it lighter, or on-demand).
4. **Cardinality**: `gold_ad_demographic` row count = ads × demos × days — partition `brand_id`-first +
   bound the backfill window; reuse the #309 resumable backfill + the #312 AQE/incremental tuning.

## 4. Phased plan
- **P1 (creatives, ~1 wk)**: Meta + Google creative pulls → Bronze → `silver_ad_creative` →
  `gold_ad_creative` + view + endpoint → wire the campaigns-detail creatives panel. Verifiable against a
  real Meta account; low risk.
- **P2 (demographics, ~1–2 wks)**: breakdown insights (async, coarse default) → Bronze → Silver → Gold →
  view + endpoint → wire the demographic charts + small-cohort suppression. Heavier; gate the pull cadence.
- Each follows the established mart pattern (`_gold_base` + run script + `mv_` view + parity), brand_id
  pk[0], money minor+currency, honest-empty until data flows.

## 5. Effort & risk
~2–3 weeks total (creatives first). Main risks: API scope/reconnect friction, demographic-breakdown API
cost/rate-limits (mitigated by async + coarse defaults + capped backfill), and expiring thumbnail URLs
(mitigated by a later S3 thumbnail cache). No app-architecture change — it's connector depth + new marts
on the existing medallion + the already-scaffolded UI panels.

## 6. Recommendation
Do **2A (creatives) first** — it's cheap, low-cardinality, verifiable on a real account, and immediately
fills a visible UI gap. Treat **2B (demographics)** as a separate, cost-gated follow-on. Both stay
honest-empty (as today) until a real ad account with the data + scopes is connected.
