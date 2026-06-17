# Research — Meta + Google Ads Connector Integration (Spend Truth + Attribution)

> Deep-research output (adversarially verified, cited). Informs building the Meta Ads +
> Google Ads connectors on Brain's existing connector framework. Date: 2026-06-18.
> Companion to the spec in this folder. (¾ of this was recovered via a rate-limited resume;
> a few Meta-specific / offline-conversion claims remain unverified — flagged below.)

## Verdict

Both Meta Marketing (Ads Insights) and Google Ads APIs can be built as **deep Brain
connectors reusing the existing framework** (connector_instance/cursor/sync_status,
accept-before-validate collector, Bronze, append-only ledger, per-brand RLS). Each enforces
**distinct rate/quota + restatement mechanics that MUST drive cursor design** — the connector
is not "pull once," it's "re-read a trailing window until final," exactly like the COD
re-pull pattern we already shipped for Shopify/Razorpay.

## 1. Google Ads API — mechanics (HIGH confidence, primary docs)

- **Two independent throttling layers:**
  - **Daily operation quota by developer-token access tier:** Explorer = 2,880 ops/day prod
    (15,000 test); Basic = 15,000 ops/day (both). Violation → `RESOURCE_EXHAUSTED`.
  - **Dynamic QPS token-bucket, metered independently per CID *and* per developer token.**
    Violation → `RESOURCE_TEMPORARILY_EXHAUSTED` (distinct error). Connector must back off on
    BOTH (exp backoff 5–10s, client-side QPS cap, bounded concurrency).
- **Reporting:** `GoogleAdsService.SearchStream` (single persistent stream, recommended for
  larger reports) or paginated `Search` (10k-row pages). **1 query = 1 operation** regardless
  of paging/streaming (valid `next_page_token` pages don't count separately).
- **Auth:** OAuth + an **approved developer token** (test→basic→standard access levels).

## 2. Meta Marketing (Ads Insights) API — mechanics

- **Breaking change Jan 2026:** removal of the **7-day and 28-day view-through** windows →
  surviving windows = `1d_click / 7d_click / 28d_click / 1d_engaged_view / 1d_view`. Build the
  connector against the post-Jan-2026 window set.
- **Tiered retention:** ~13mo unique/hourly, 6mo frequency, 37mo aggregate — bound the
  backfill depth per breakdown accordingly.
- ⚠️ *Unverified (re-throttled):* the exact async-insights job/rate-limit "score" mechanics and
  the Standard-Access throttling specifics — re-research before building the Meta sync loop.

## 3. The restatement / "until final" window (THE design driver — HIGH)

- **Spend/cost is fixed at click time and does NOT restate** — only **conversions/ROAS/CAC
  restate**, because conversions **back-attribute to the original click date** over the
  conversion window.
- **Google:** conversion window 1–90 days (defaults: **30-day click**, 3-day engaged-view,
  1-day view). A past date's conversion counts grow as late conversions land.
- **Meta:** up to **28-day click / 1-day view** (post-Jan-2026).
- **Sync strategy (confirmed pattern):** an **incremental re-read of the trailing ~28 days**
  every sync (the Airbyte `lookback_window` pattern) — i.e. our existing trailing-window
  re-pull, cursor-tracked per (connector, brand). The cursor is **never "final" inside the
  window** — same doctrine as the India-COD Shopify re-pull.
- **Google metric pairs to choose canonically:** `metrics.conversions` (primary, what Smart
  Bidding optimizes) vs `metrics.all_conversions` (incl. cross-device/view-through/store); and
  **click-date-anchored** (`segments.date`) vs **conversion-date-anchored**
  (`conversions_by_conversion_date`). Integrators MUST pick which is canonical — Brain should
  store both raw in Bronze and pick the canonical in Silver/Gold.

## 4. Attribution + conversion feedback (deterministic-first)

- **Click-ID capture:** Google `gclid` / `GBRAID` / `WBRAID`; Meta `fbclid`. (Our pixel already
  captures these — the linkage is collection-side + connector-side.)
- **Offline / server conversion import (the feedback loop):** Google
  `ConversionUploadService.UploadClickConversions` + **Enhanced Conversions** (SHA-256-hashed
  PII matching); Meta **Conversions API (CAPI)**. iOS-ATT/SKAN pressure is precisely what drives
  the click-ID supplements + hashed-PII matching.
- ⚠️ *Unverified (re-throttled):* the precise residual-underreporting % and some offline-match
  rate specifics.

## 5. Implications for the Brain connector build

1. **Reuse the framework** — connector_instance/cursor/sync_status + the trailing-window
   re-pull job (the Shopify/Razorpay pattern). No new deployable.
2. **Two cursors / re-read window** — spend is append-once; conversions need the ~28-day
   (Meta) / 30-day (Google) trailing re-read. Store raw spend + conversions in Bronze; resolve
   canonical metrics in Silver/Gold.
3. **Throttle-aware sync** — Google: branch on `RESOURCE_EXHAUSTED` (daily, back off till next
   day) vs `RESOURCE_TEMPORARILY_EXHAUSTED` (QPS, short backoff), cap QPS per CID + token.
4. **Canonical model** — campaign/adset(ad group)/ad/creative hierarchy + spend (minor units,
   currency/timezone-aware) into the ledger; reconcile platform-reported vs server truth.
5. **Attribution** — click-IDs (pixel + connector) → deterministic match to orders → the moat;
   conversion feedback (CAPI / Google offline) is a later, consent-heavy slice.
6. **Privacy** — hashed-PII only, consent-gated, DPDP/GCC; ad identifiers treated as PII.

## Verified-claim sources (primary)

- Google quotas / rate-limits / access-levels: developers.google.com/google-ads/api/docs/{best-practices/quotas, productionize/rate-limits, api-policy/access-levels}
- Google reporting (SearchStream/Search/quota-per-query): developers.google.com/google-ads/api/docs/reporting/streaming
- Google conversion window + attribution: support.google.com/google-ads/answer/{3123169,1722023,2544985,9347141}
- Google conversions reporting (metric pairs): developers.google.com/google-ads/api/docs/conversions/reporting
- Meta window changes / retention: Meta Marketing API changelog (Jan 2026)
