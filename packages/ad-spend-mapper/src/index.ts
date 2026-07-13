/**
 * @brain/ad-spend-mapper — Frozen shared mapper for ad-spend ingestion (ADR-AD-4 / ADR-AD-5).
 *
 * FROZEN API — do not change after A0 commit without Architect sign-off.
 *
 * Binding decisions implemented here:
 *   ADR-AD-4 — canonical event = spend.live.v1, an event_name VALUE on the EXISTING
 *              collector.event.v1 envelope (NOT a new topic/envelope).
 *   ADR-AD-5 — event_id namespace: uuidV5FromSpendRow(brandId, platform, statDate, level, levelId)
 *              — provably non-colliding with ':order.*' / ':settlement.*' namespaces by including
 *              the literal platform token (meta/google_ads) + ':spend.live.v1' discriminator.
 *   ADR-AD-8 — store RAW conversions: Google metrics.conversions AND metrics.all_conversions;
 *              Meta surviving attribution set. Canonical anchoring = click-date (stat_date).
 *   I-S07    — spend_minor is BIGINT-as-string throughout. Google cost_micros → minor units
 *              via integer division by 10_000 (micros/1e6 = major; major*1e2 = minor;
 *              => micros/1e4 = minor) — integer arithmetic only, NO parseFloat.
 *   I-S02    — ad-identifiers (campaign/adset/ad/creative ids+names) are OPERATIONAL refs,
 *              NOT person-linkable. Stored un-hashed. The field allowlist DROPS anything else.
 *
 * Exports:
 *   SPEND_LIVE_V1_EVENT_NAME   — 'spend.live.v1'
 *   AD_SPEND_FIELD_ALLOWLIST   — the allowed canonical field names
 *   AdSpendLevel               — 'campaign' | 'adset' | 'ad' | 'creative'
 *   uuidV5FromSpendRow         — deterministic event_id seed (ADR-AD-5)
 *   microsToMinorString        — Google cost_micros → BIGINT-as-string minor units (I-S07)
 *   majorDecimalToMinorString  — Meta spend "12.34" → BIGINT-as-string minor units (I-S07)
 *   mapMetaInsightToEvent      — raw Meta Insights row → MappedSpendEvent
 *   mapGoogleRowToEvent        — raw Google SearchStream row → MappedSpendEvent
 *   MetaInsightRow / GoogleAdsRow / MappedSpendEvent / SpendEventProperties — types
 *
 * Money: spend_minor stays BIGINT-as-string throughout (I-S07 — no float).
 * PII: ad spend has no contact PII. Ad-identifiers are operational references (I-S02).
 */

import { hashToUuidShaped } from '@brain/connector-core';

// ── Event name constant (ADR-AD-4) ───────────────────────────────────────────

/** Live ad-spend event name on the collector.event.v1 live lane. */
export const SPEND_LIVE_V1_EVENT_NAME = 'spend.live.v1' as const;

// ── Hierarchy level (matches ad_spend_ledger.level CHECK) ────────────────────

export type AdSpendLevel = 'campaign' | 'adset' | 'ad' | 'creative';

export type AdPlatform = 'meta' | 'google_ads';

// ── COMMON (breakdown/entity depth spec §2.B) — canonical breakdown-key for the extended event_id seed ──
//
// The breakdownKey folds a row's breakdown/segment DIMENSIONS into the deterministic event_id so a
// base row and every breakdown row (and every breakdown vs each other) get distinct event_ids and
// never collide under the Bronze/Silver MERGE. The rule MUST be byte-identical in TS and the Python
// port (canonical_breakdown_key in _raw_normalize.py).
//
// Rule (verbatim):
//   1. Take the breakdown dimensions PRESENT on the row as name=value pairs.
//   2. Escape `\`, `|`, `=` in BOTH name and value with a backslash (delimiter-safety).
//   3. Sort pairs ascending by dimension name (byte order).
//   4. Join with `|`.
//   5. Empty set → "" (the base pass — keeps base-grain event_ids byte-UNCHANGED).

/** Escape the breakdownKey delimiters (`\`, `|`, `=`) in a single token. */
function escapeBreakdownToken(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/=/g, '\\=');
}

/**
 * Canonicalize a set of breakdown/segment dimensions into the deterministic breakdownKey.
 * Undefined/null/empty-string values are DROPPED (a dim not present on the row does not enter the key),
 * so the base pass (no dims) → "" and base event_ids stay byte-identical. Sorted by name for stability.
 */
export function canonicalBreakdownKey(dims: Record<string, string | null | undefined>): string {
  const pairs: string[] = [];
  for (const name of Object.keys(dims).sort()) {
    const raw = dims[name];
    if (raw === null || raw === undefined) continue;
    const value = String(raw);
    if (value === '') continue;
    pairs.push(`${escapeBreakdownToken(name)}=${escapeBreakdownToken(value)}`);
  }
  return pairs.join('|');
}

/**
 * GOOGLE-ONLY (spec §2.C): compute the breakdownKey for a mapped Google spend event from the segment
 * dims projected onto its properties. Every segmented GAQL view (device/network, time, geo, demo,
 * keyword, search-term, shopping, conversion, click) folds its own dims here; the base `spend` pass
 * has none of them set → canonicalBreakdownKey returns '' → base event_ids stay byte-identical.
 *
 * This is the SINGLE place the Google segment→breakdownKey mapping lives, so live-repull, backfill,
 * and the Spark Silver port all seed the same id (no drift).
 */
export function googleBreakdownKey(
  props: Pick<
    SpendEventProperties,
    | 'segment_device'
    | 'segment_ad_network_type'
    | 'segment_day_of_week'
    | 'segment_hour'
    | 'segment_click_type'
    | 'segment_conversion_action'
    | 'segment_geo_target'
    | 'segment_age_range'
    | 'segment_gender'
    | 'keyword_id'
    | 'search_term'
    | 'product_item_id'
  >,
): string {
  return canonicalBreakdownKey({
    device: props.segment_device,
    ad_network_type: props.segment_ad_network_type,
    day_of_week: props.segment_day_of_week,
    hour: props.segment_hour,
    click_type: props.segment_click_type,
    conversion_action: props.segment_conversion_action,
    geo_target: props.segment_geo_target,
    age_range: props.segment_age_range,
    gender: props.segment_gender,
    keyword_id: props.keyword_id,
    search_term: props.search_term,
    product_item_id: props.product_item_id,
  });
}

// ── Field allowlist (HARD — no other fields cross the boundary) ──────────────
//
// The ONLY canonical fields permitted into a spend.live.v1 event. NO PII fields.
// Ad-identifiers (campaign/adset/ad/creative ids+names) are operational references
// (I-S02 — not person-linkable). Anything else from the raw API response is DROPPED.

export const AD_SPEND_FIELD_ALLOWLIST = new Set([
  'platform',
  'level',
  'level_id',
  'parent_id',
  'campaign_id',
  'campaign_name',
  'stat_date',
  'spend_minor',
  'currency_code',
  'impressions',
  'clicks',
  // ── A1: full insight set (additive, money-safe). conversion COUNT + conversion REVENUE +
  //    derived per-row cost measures. conv_value_minor is bigint MINOR units in the SAME
  //    account currency_code as spend_minor (per-currency, NEVER blended) — it is a SIBLING
  //    measure to spend_minor, never folded into it. ROAS is derived downstream (read-time
  //    ratio = conv_value_minor / spend_minor), never precomputed here.
  'conversions',                 // BIGINT-as-string count (purchase conversions)
  'all_conversions',             // BIGINT-as-string count (incl. cross-account/all)
  'conv_value_minor',            // BIGINT-as-string MINOR units — platform-attributed REVENUE (currency = currency_code)
  'view_through_conversions',    // BIGINT-as-string count
  'ctr',                         // ratio (NOT money) — string
  'cpc_minor',                   // BIGINT-as-string MINOR units (cost-per-click)
  'cpm_minor',                   // BIGINT-as-string MINOR units (cost-per-mille)
  'advertising_channel_type',    // Google channel type (SEARCH/DISPLAY/…); null for Meta
  'conversions_raw',
  'account_timezone',
  // ── COMMON (Impl-M + Impl-G) — base-grain metrics with a genuine analog on BOTH providers. Each
  //    mapper populates only where the platform has the field; the other passes null. money =
  //    *_minor bigint-string; count = bigint-string; ratio = string passthrough. ──
  'video_views',                 // count — Meta video_view action-lift / Google metrics.video_views
  'video_view_rate',             // ratio — Google metrics.video_view_rate (null on Meta)
  'engagements',                 // count — Google metrics.engagements (null on Meta; Meta keeps post/page separate)
  'engagement_rate',             // ratio — Google metrics.engagement_rate (null on Meta)
  'cost_per_conversion_minor',   // money — Google metrics.cost_per_conversion (micros) (null on Meta)
  'value_per_conversion_minor',  // money — Google metrics.value_per_conversion (micros) (null on Meta)
  // ── COMMON — the canonical breakdownKey string ('' for base) folded into the dedup key. ──
  'breakdown_key',
  // ── META-ONLY (Impl-M) ────────────────────────────────────────────────────────────────────────
  'reach',                       // count
  'frequency',                   // ratio (string) — avg impressions/person (NOT minor units)
  'cpp_minor',                   // money — cost-per-1000-people-reached
  'unique_clicks',               // count
  'unique_ctr',                  // ratio (string)
  'inline_link_clicks',          // count
  'inline_link_click_ctr',       // ratio (string)
  'outbound_clicks',             // count (array-lift)
  'unique_outbound_clicks',      // count (array-lift)
  'cost_per_unique_click_minor', // money
  'cost_per_inline_link_click_minor', // money
  'landing_page_views',          // count (array-lift)
  'purchase_roas_ratio',         // ratio (string, array-lift)
  'website_purchase_roas_ratio', // ratio (string, array-lift)
  'mobile_app_purchase_roas_ratio', // ratio (string, array-lift)
  'post_engagement',             // count
  'page_engagement',             // count
  'inline_post_engagement',      // count
  'video_p25_watched',           // count (array-lift)
  'video_p50_watched',           // count (array-lift)
  'video_p75_watched',           // count (array-lift)
  'video_p100_watched',          // count (array-lift)
  'video_thruplay_watched',      // count (array-lift)
  'video_30_sec_watched',        // count (array-lift)
  'video_avg_time_watched_secs', // count (integer seconds)
  'quality_ranking',             // enum string — ad-level only
  'engagement_rate_ranking',     // enum string — ad-level only
  'conversion_rate_ranking',     // enum string — ad-level only
  // Meta breakdown dims (nullable; folded into breakdown_key on breakdown passes):
  'age',
  'gender',
  'country',
  'region',
  'dma',
  'publisher_platform',
  'platform_position',
  'device_platform',
  'impression_device',
  'hourly_stats_aggregated_by_advertiser_time_zone',
  // ── GOOGLE-ONLY (Impl-G) — Google firehose metrics. money=*_minor; count=bigint-string; ratio=string.
  'all_conversions_value_minor',           // money — all_conversions_value (major double → minor)
  'cost_per_all_conversions_minor',        // money — cost_per_all_conversions (micros → minor)
  'average_cost_minor',                    // money — average_cost (micros → minor)
  'search_impression_share',               // ratio
  'search_budget_lost_impression_share',   // ratio
  'search_rank_lost_impression_share',     // ratio
  'absolute_top_impression_percentage',    // ratio
  'top_impression_percentage',             // ratio
  'interactions',                          // count
  'interaction_rate',                      // ratio
  'conversions_from_interactions_rate',    // ratio
  // ── GOOGLE-ONLY breakdown/segment dimensions (projected from the segmented GAQL views; fold into
  //    the breakdownKey seed). Operational refs (I-S02), never PII.
  'segment_device',                        // segments.device
  'segment_ad_network_type',               // segments.ad_network_type
  'segment_day_of_week',                   // segments.day_of_week
  'segment_hour',                          // segments.hour (0-23)
  'segment_click_type',                    // segments.click_type
  'segment_conversion_action',             // segments.conversion_action (resource name)
  'segment_conversion_action_name',        // segments.conversion_action_name
  'segment_geo_target',                    // geographic_view geo_target_constant
  'segment_age_range',                     // age_range_view ad_group_criterion.age_range.type
  'segment_gender',                        // gender_view ad_group_criterion.gender.type
  'keyword_id',                            // keyword_view ad_group_criterion.criterion_id
  'keyword_text',                          // keyword_view ad_group_criterion.keyword.text
  'keyword_match_type',                    // keyword_view ad_group_criterion.keyword.match_type
  'search_term',                           // search_term_view search_term
  'product_item_id',                       // shopping_performance_view segments.product_item_id
  'product_title',                         // shopping_performance_view segments.product_title
  'product_brand',                         // shopping_performance_view segments.product_brand
  // ── GOOGLE-ONLY entity-depth refs (campaign/ad_group/ad metadata; ad.entity.updated lane).
  'advertising_channel_sub_type',          // campaign.advertising_channel_sub_type
  'bidding_strategy_type',                 // campaign.bidding_strategy_type
  'campaign_status',                       // campaign.status
  'campaign_start_date',                   // campaign.start_date
  'campaign_end_date',                     // campaign.end_date
  'campaign_budget_amount_minor',          // campaign_budget.amount_micros → minor
  'ad_group_type',                         // ad_group.type
  'ad_group_status',                       // ad_group.status
  'ad_group_cpc_bid_minor',                // ad_group.cpc_bid_micros → minor
  'ad_type',                               // ad_group_ad.ad.type
  'ad_final_urls',                         // ad_group_ad.ad.final_urls (JSON array string)
  'ad_headlines',                          // RSA headlines (JSON array string)
  'ad_descriptions',                       // RSA descriptions (JSON array string)
] as const);

/**
 * Meta `actions[]` / `action_values[]` action_type tokens that represent a PURCHASE conversion,
 * in resolution priority order. The first matching entry's `value` is taken as the canonical
 * purchase count (actions) / purchase revenue (action_values). Meta's default omni purchase row
 * (`omni_purchase`) and the pixel purchase event are accepted as fallbacks.
 */
export const META_PURCHASE_ACTION_TYPES = [
  'purchase',
  'omni_purchase',
  'offsite_conversion.fb_pixel_purchase',
] as const;

// ── META-ONLY (Impl-M) — action-type priority lists for array-lifting the enriched Meta metrics.
//    Meta returns several metrics as arrays of { action_type, value } (or { action_type, 1d_view,
//    7d_click, ... }); these lists resolve the canonical scalar (first-match by priority). The FULL
//    raw arrays are still preserved verbatim in conversions_raw (ADR-AD-8). ──────────────────────

/** landing_page_views action-type tokens (omni + web), highest priority first. */
export const META_LANDING_PAGE_VIEW_TYPES = [
  'landing_page_view',
  'omni_landing_page_view',
] as const;

/** outbound_clicks action-type tokens. */
export const META_OUTBOUND_CLICK_TYPES = ['outbound_click'] as const;

/** ROAS array action-type tokens (each *_roas array carries a single {action_type,value}). */
export const META_PURCHASE_ROAS_TYPES = ['omni_purchase', 'purchase'] as const;
export const META_WEBSITE_PURCHASE_ROAS_TYPES = [
  'offsite_conversion.fb_pixel_purchase',
  'purchase',
] as const;
export const META_MOBILE_APP_PURCHASE_ROAS_TYPES = [
  'app_custom_event.fb_mobile_purchase',
  'omni_purchase',
] as const;

/** Engagement action-type tokens carried inside actions[] (Meta emits these as action rows). */
export const META_POST_ENGAGEMENT_TYPES = ['post_engagement'] as const;
export const META_PAGE_ENGAGEMENT_TYPES = ['page_engagement'] as const;

// ── Output types ─────────────────────────────────────────────────────────────

/**
 * Spend event properties (allowlisted). spend_minor is BIGINT-as-string (I-S07).
 * conversions_raw holds the RAW conversion metrics (ADR-AD-8) — the metric engine
 * (Silver/Gold) picks the canonical in read.
 */
export interface SpendEventProperties {
  source: AdPlatform;
  platform: AdPlatform;
  level: AdSpendLevel;
  level_id: string;                 // platform-native id (operational ref, not PII — I-S02)
  parent_id: string | null;
  campaign_id: string | null;
  campaign_name: string | null;     // display only (not PII)
  stat_date: string;                // YYYY-MM-DD — click-date anchored (canonical, ADR-AD-8)
  spend_minor: string;              // BIGINT-as-string, minor units (I-S07)
  currency_code: string;            // account currency — also the currency of conv_value_minor/cpc_minor/cpm_minor
  impressions: string | null;       // BIGINT-as-string
  clicks: string | null;            // BIGINT-as-string
  // ── A1 enriched insight set (additive). All money fields are BIGINT-as-string MINOR units in
  //    `currency_code` (per-currency, NEVER blended, NEVER float). conv_value_minor is the
  //    platform-attributed conversion REVENUE — a SIBLING measure to spend_minor (enables platform
  //    ROAS = conv_value_minor / spend_minor, derived at read time, never precomputed here).
  conversions: string | null;               // BIGINT-as-string count (purchase conversions)
  all_conversions: string | null;           // BIGINT-as-string count (all conversions)
  conv_value_minor: string | null;          // BIGINT-as-string MINOR units — platform-attributed REVENUE
  view_through_conversions: string | null;  // BIGINT-as-string count
  ctr: string | null;                        // ratio (NOT money) — string passthrough
  cpc_minor: string | null;                  // BIGINT-as-string MINOR units (cost-per-click)
  cpm_minor: string | null;                  // BIGINT-as-string MINOR units (cost-per-mille)
  advertising_channel_type: string | null;   // Google channel type; null for Meta
  conversions_raw: Record<string, unknown> | null;  // RAW (ADR-AD-8)
  account_timezone: string | null;
  // ── COMMON (spec §1.A) — additive/nullable; each mapper fills only where the platform has the field.
  video_views?: string | null;                 // count
  video_view_rate?: string | null;             // ratio
  engagements?: string | null;                 // count
  engagement_rate?: string | null;             // ratio
  cost_per_conversion_minor?: string | null;   // money MINOR (currency_code)
  value_per_conversion_minor?: string | null;  // money MINOR (currency_code)
  // ── GOOGLE-ONLY (Impl-G) — additive/nullable; all money is MINOR units in `currency_code`.
  all_conversions_value_minor?: string | null;         // money MINOR
  cost_per_all_conversions_minor?: string | null;      // money MINOR
  average_cost_minor?: string | null;                  // money MINOR
  search_impression_share?: string | null;             // ratio
  search_budget_lost_impression_share?: string | null; // ratio
  search_rank_lost_impression_share?: string | null;   // ratio
  absolute_top_impression_percentage?: string | null;  // ratio
  top_impression_percentage?: string | null;           // ratio
  interactions?: string | null;                        // count
  interaction_rate?: string | null;                    // ratio
  conversions_from_interactions_rate?: string | null;  // ratio
  // breakdown/segment dims (operational refs; folded into the breakdownKey seed)
  segment_device?: string | null;
  segment_ad_network_type?: string | null;
  segment_day_of_week?: string | null;
  segment_hour?: string | null;
  segment_click_type?: string | null;
  segment_conversion_action?: string | null;
  segment_conversion_action_name?: string | null;
  segment_geo_target?: string | null;
  segment_age_range?: string | null;
  segment_gender?: string | null;
  keyword_id?: string | null;
  keyword_text?: string | null;
  keyword_match_type?: string | null;
  search_term?: string | null;
  product_item_id?: string | null;
  product_title?: string | null;
  product_brand?: string | null;
  // entity-depth refs
  advertising_channel_sub_type?: string | null;
  bidding_strategy_type?: string | null;
  campaign_status?: string | null;
  campaign_start_date?: string | null;
  campaign_end_date?: string | null;
  campaign_budget_amount_minor?: string | null; // money MINOR
  ad_group_type?: string | null;
  ad_group_status?: string | null;
  ad_group_cpc_bid_minor?: string | null;       // money MINOR
  ad_type?: string | null;
  ad_final_urls?: string | null;                // JSON array string
  ad_headlines?: string | null;                 // JSON array string
  ad_descriptions?: string | null;              // JSON array string
  occurred_at: string;              // ISO-8601 — economic_effective_at
  // ── COMMON — the canonical breakdownKey string for this row ('' for the base pass). Audit/debug
  //    surfacing of the dim set folded into the dedup event_id (§2.B). ──────────────────────────────
  breakdown_key: string | null;
  // ── META-ONLY (Impl-M) — enriched Meta insight metrics + breakdown dims (all nullable). Money is
  //    BIGINT-as-string MINOR in `currency_code`; counts BIGINT-as-string; ratios string passthrough;
  //    rankings enum-string (ad-level only). ────────────────────────────────────────────────────────
  reach: string | null;                          // count
  frequency: string | null;                      // ratio (string) — avg impressions/person (NOT money)
  cpp_minor: string | null;                      // MINOR money
  unique_clicks: string | null;                  // count
  unique_ctr: string | null;                     // ratio (string)
  inline_link_clicks: string | null;             // count
  inline_link_click_ctr: string | null;          // ratio (string)
  outbound_clicks: string | null;                // count (array-lift)
  unique_outbound_clicks: string | null;         // count (array-lift)
  cost_per_unique_click_minor: string | null;    // MINOR money
  cost_per_inline_link_click_minor: string | null; // MINOR money
  landing_page_views: string | null;            // count (array-lift)
  purchase_roas_ratio: string | null;            // ratio (string, array-lift)
  website_purchase_roas_ratio: string | null;    // ratio (string, array-lift)
  mobile_app_purchase_roas_ratio: string | null; // ratio (string, array-lift)
  post_engagement: string | null;               // count
  page_engagement: string | null;               // count
  inline_post_engagement: string | null;        // count
  video_p25_watched: string | null;             // count (array-lift)
  video_p50_watched: string | null;             // count (array-lift)
  video_p75_watched: string | null;             // count (array-lift)
  video_p100_watched: string | null;            // count (array-lift)
  video_thruplay_watched: string | null;        // count (array-lift)
  video_30_sec_watched: string | null;          // count (array-lift)
  video_avg_time_watched_secs: string | null;   // count (integer seconds)
  quality_ranking: string | null;               // enum string — ad-level only
  engagement_rate_ranking: string | null;       // enum string — ad-level only
  conversion_rate_ranking: string | null;       // enum string — ad-level only
  // Meta breakdown dimension values (base pass = all null; a breakdown pass populates its dims):
  age: string | null;
  gender: string | null;
  country: string | null;
  region: string | null;
  dma: string | null;
  publisher_platform: string | null;
  platform_position: string | null;
  device_platform: string | null;
  impression_device: string | null;
  hourly_stats_aggregated_by_advertiser_time_zone: string | null;
}

export interface MappedSpendEvent {
  event_name: typeof SPEND_LIVE_V1_EVENT_NAME;
  occurred_at: string;
  properties: SpendEventProperties;
}

// ── Raw input types ───────────────────────────────────────────────────────────

/**
 * Raw Meta Ads Insights API row (the surviving post-Jan-2026 attribution set).
 * Accepts arbitrary extra fields — the allowlist drops them.
 * Meta returns spend as a major-unit decimal STRING (e.g. "12.34") + account currency.
 */
export interface MetaInsightRow {
  level?: string | null;            // 'campaign' | 'adset' | 'ad'
  campaign_id?: string | null;
  campaign_name?: string | null;
  adset_id?: string | null;
  ad_id?: string | null;
  spend?: string | number | null;   // MAJOR-unit decimal string (e.g. "12.34")
  impressions?: string | number | null;
  clicks?: string | number | null;
  date_start?: string | null;       // stat date (YYYY-MM-DD)
  actions?: unknown;                // raw conversion COUNT actions[] (ADR-AD-8)
  action_values?: unknown;          // raw conversion REVENUE action_values[] (MAJOR-unit decimal per action_type)
  ctr?: string | number | null;     // click-through ratio (percentage), Meta returns as a string
  cpc?: string | number | null;     // MAJOR-unit decimal cost-per-click (account currency)
  cpm?: string | number | null;     // MAJOR-unit decimal cost-per-mille (account currency)
  // ── META-ONLY (Impl-M) — enriched Meta Insights raw fields (all optional; absent → null). ──────
  reach?: string | number | null;
  frequency?: string | number | null;             // decimal ratio (avg impressions/person)
  cpp?: string | number | null;                    // MAJOR-unit decimal cost-per-1000-reached
  unique_clicks?: string | number | null;
  unique_ctr?: string | number | null;
  inline_link_clicks?: string | number | null;
  inline_link_click_ctr?: string | number | null;
  outbound_clicks?: unknown;                       // array { action_type, value } → array-lift
  unique_outbound_clicks?: unknown;                // array → array-lift
  cost_per_unique_click?: string | number | null;  // MAJOR-unit decimal
  cost_per_inline_link_click?: string | number | null; // MAJOR-unit decimal
  landing_page_views?: unknown;                    // arrives inside actions[] (fallback field)
  purchase_roas?: unknown;                         // array { action_type, value } → array-lift
  website_purchase_roas?: unknown;                 // array → array-lift
  mobile_app_purchase_roas?: unknown;              // array → array-lift
  video_play_actions?: unknown;                    // array → video_views (array-lift)
  video_p25_watched_actions?: unknown;             // array → array-lift
  video_p50_watched_actions?: unknown;             // array → array-lift
  video_p75_watched_actions?: unknown;             // array → array-lift
  video_p100_watched_actions?: unknown;            // array → array-lift
  video_thruplay_watched_actions?: unknown;        // array → array-lift
  video_30_sec_watched_actions?: unknown;          // array → array-lift
  video_avg_time_watched_actions?: unknown;        // array (seconds) → array-lift
  // post/page engagement arrive inside actions[]; also accept flat fields when present.
  quality_ranking?: string | null;                 // enum — ad-level only
  engagement_rate_ranking?: string | null;         // enum — ad-level only
  conversion_rate_ranking?: string | null;         // enum — ad-level only
  // Breakdown dimension keys (present only on the corresponding breakdown pass):
  age?: string | null;
  gender?: string | null;
  country?: string | null;
  region?: string | null;
  dma?: string | null;
  publisher_platform?: string | null;
  platform_position?: string | null;
  device_platform?: string | null;
  impression_device?: string | null;
  hourly_stats_aggregated_by_advertiser_time_zone?: string | null;
  [key: string]: unknown;
}

/**
 * Raw Google Ads SearchStream (GAQL) row, flattened.
 * Google returns cost_micros (integer micros) + conversions/all_conversions (doubles).
 * micros → minor units via integer division (I-S07 — no parseFloat).
 */
export interface GoogleAdsRow {
  level?: string | null;            // resolved by the client: 'campaign'|'adset'(ad_group)|'ad'
  campaign_id?: string | null;
  campaign_name?: string | null;
  ad_group_id?: string | null;
  ad_id?: string | null;
  cost_micros?: string | number | null;   // integer micros
  impressions?: string | number | null;
  clicks?: string | number | null;
  conversions?: string | number | null;       // RAW (ADR-AD-8) — count (double)
  all_conversions?: string | number | null;    // RAW (ADR-AD-8) — count (double)
  conversions_value?: string | number | null;  // platform-attributed REVENUE — MAJOR-unit double (account currency)
  view_through_conversions?: string | number | null;  // count (double)
  ctr?: string | number | null;                 // click-through ratio (double)
  average_cpc?: string | number | null;         // integer MICROS cost-per-click
  average_cpm?: string | number | null;         // integer MICROS cost-per-mille
  advertising_channel_type?: string | null;     // SEARCH | DISPLAY | VIDEO | …
  segments_date?: string | null;   // stat date (YYYY-MM-DD)
  currency_code?: string | null;
  // ── GOOGLE-ONLY firehose metrics (additive; flattened from GAQL metrics.*). money = micros/major;
  //    count = integer; ratio = double passthrough. All nullable — older rows lack them → null.
  cost_per_conversion?: string | number | null;        // micros
  value_per_conversion?: string | number | null;       // micros
  all_conversions_value?: string | number | null;      // MAJOR-unit double
  cost_per_all_conversions?: string | number | null;   // micros
  average_cost?: string | number | null;               // micros
  search_impression_share?: string | number | null;    // ratio
  search_budget_lost_impression_share?: string | number | null; // ratio
  search_rank_lost_impression_share?: string | number | null;   // ratio
  absolute_top_impression_percentage?: string | number | null;  // ratio
  top_impression_percentage?: string | number | null;  // ratio
  interactions?: string | number | null;               // count
  interaction_rate?: string | number | null;           // ratio
  engagements?: string | number | null;                // count
  engagement_rate?: string | number | null;            // ratio
  video_views?: string | number | null;                // count
  video_view_rate?: string | number | null;            // ratio
  conversions_from_interactions_rate?: string | number | null;  // ratio
  // ── GOOGLE-ONLY segment/breakdown dims (from the segmented GAQL views) ──
  segment_device?: string | null;
  segment_ad_network_type?: string | null;
  segment_day_of_week?: string | null;
  segment_hour?: string | number | null;
  segment_click_type?: string | null;
  segment_conversion_action?: string | null;
  segment_conversion_action_name?: string | null;
  segment_geo_target?: string | null;
  segment_age_range?: string | null;
  segment_gender?: string | null;
  keyword_id?: string | null;
  keyword_text?: string | null;
  keyword_match_type?: string | null;
  search_term?: string | null;
  product_item_id?: string | null;
  product_title?: string | null;
  product_brand?: string | null;
  // ── GOOGLE-ONLY entity-depth refs ──
  advertising_channel_sub_type?: string | null;
  bidding_strategy_type?: string | null;
  campaign_status?: string | null;
  campaign_start_date?: string | null;
  campaign_end_date?: string | null;
  campaign_budget_amount_micros?: string | number | null; // micros
  ad_group_type?: string | null;
  ad_group_status?: string | null;
  ad_group_cpc_bid_micros?: string | number | null;       // micros
  ad_type?: string | null;
  ad_final_urls?: readonly string[] | string | null;
  ad_headlines?: readonly string[] | string | null;
  ad_descriptions?: readonly string[] | string | null;
  [key: string]: unknown;
}

// ── UUID util — shared kernel util (@brain/connector-core), IDENTICAL byte layout (I-ST04) ──

// ── ADR-AD-5: deterministic event_id seed ────────────────────────────────────

/**
 * Deterministic event_id for an ad-spend row (ADR-AD-5).
 * Seed: sha256(`${brandId}:${platform}:${statDate}:${level}:${levelId}:spend.live.v1`)
 *
 * Provably NON-colliding with ':order.live.v1' / ':order.backfill.v1' /
 * ':settlement.live.v1' / ':settlement.webhook.v1' namespaces:
 *   - the literal platform token ('meta' | 'google_ads') and the ':spend.live.v1'
 *     suffix appear in NO other namespace seed.
 *
 * The (platform, statDate, level, levelId) tuple is exactly the dedup grain of
 * ad_spend_ledger — so the same spend row re-read over the trailing window produces
 * the SAME event_id → ON CONFLICT DO NOTHING (idempotent re-read — I-ST04).
 *
 * @param brandId   Brand UUID (from connector, NEVER from the API response — MT-1)
 * @param platform  'meta' | 'google_ads'
 * @param statDate  YYYY-MM-DD click-date stat date
 * @param level     'campaign' | 'adset' | 'ad' | 'creative'
 * @param levelId   platform-native id at that level
 * @param breakdownKey  canonical breakdown dims (spec §2) — DEFAULTS to '' (the base pass), which keeps
 *                      base-grain event_ids BYTE-IDENTICAL to the pre-breakdown seed (zero re-dedup churn).
 *                      A non-empty breakdownKey is inserted BEFORE the ':spend.live.v1' discriminator so
 *                      the namespace non-collision proof (platform token + suffix) is preserved.
 */
export function uuidV5FromSpendRow(
  brandId: string,
  platform: AdPlatform,
  statDate: string,
  level: AdSpendLevel,
  levelId: string,
  breakdownKey: string = '',
): string {
  // breakdownKey='' → seed is byte-identical to the original 5-arg seed (backward-compat guarantee).
  const bkSeg = breakdownKey === '' ? '' : `:${breakdownKey}`;
  return hashToUuidShaped(
    `${brandId}:${platform}:${statDate}:${level}:${levelId}${bkSeg}:spend.live.v1`,
  );
}

// ── COMMON (shared TS+Py, reviewed by both Meta+Google) — breakdown dedup-key ──────────────────
//
// canonicalBreakdownKey — order-stable, delimiter-safe join of the breakdown/segment dimension
// name=value pairs PRESENT on a row. The SIXTH seed arg to uuidV5FromSpendRow (§2 of the spec):
//   - base pass → '' (empty) → base-grain event_ids are BYTE-UNCHANGED (zero re-dedup churn).
//   - each breakdown pass folds its dimension values here so a base row and every breakdown row
//     (and every breakdown vs each other) mint DISTINCT event_ids → never collide; an idempotent
//     re-pull of the SAME breakdown row re-mints the SAME id → Silver MERGE dedups.
//
// Canonicalization rule (MUST be byte-identical in TS + Python — see canonical_breakdown_key in
// db/iceberg/spark/silver/_raw_normalize.py):
//   1. Take the dimensions PRESENT (value != null/undefined and != '') as name=value pairs.
//   2. Escape backslash, '|', '=' in BOTH name and value with a backslash (delimiter-safety).
//   3. Sort pairs ascending by dimension NAME (byte/code-unit order).
//   4. Join with '|'.
//   5. Empty set → ''.
// Example: { age: '25-34', gender: 'female', publisher_platform: 'instagram' }
//        → 'age=25-34|gender=female|publisher_platform=instagram'.

// canonicalBreakdownKey / escapeBreakdownToken are defined once near the top of this module (COMMON,
// shared by the Meta breakdown passes and the Google segment resources).

// ── Money utils — to BIGINT-as-string minor units (I-S07, integer-only) ──────

/**
 * Convert Google Ads cost_micros (integer micros) to BIGINT-as-string minor units.
 * Relationship: 1 major unit = 1_000_000 micros = 100 minor units.
 *   => minor = micros / 10_000 (exact integer division for currencies with 2 decimals).
 *
 * Integer arithmetic only via BigInt — NO parseFloat (I-S07).
 * Throws if the input is not a non-negative integer (micros are always integers).
 *
 * @throws if value is not a non-negative integer
 */
export function microsToMinorString(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return '0';
  const str = String(value).trim();
  if (!/^\d+$/.test(str)) {
    throw new Error(
      `[ad-spend-mapper] microsToMinorString: expected non-negative integer micros, got "${str}" (I-S07)`,
    );
  }
  // micros / 10_000 = minor units. BigInt integer division (truncates, exact for 2-dp currencies).
  return (BigInt(str) / 10_000n).toString();
}

/**
 * Convert a major-unit decimal string (Meta spend, e.g. "12.34") to BIGINT-as-string
 * minor units. Parses the integer and fractional parts SEPARATELY as integers —
 * NO parseFloat / no float math (I-S07). Fraction is normalized to exactly 2 digits.
 *
 * "12.34"  → "1234"
 * "12"     → "1200"
 * "12.3"   → "1230"
 * "0"      → "0"
 *
 * @throws if the value is not a well-formed non-negative decimal
 */
export function majorDecimalToMinorString(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return '0';
  const str = String(value).trim();
  if (str === '') return '0';
  const m = /^(\d+)(?:\.(\d+))?$/.exec(str);
  if (!m) {
    throw new Error(
      `[ad-spend-mapper] majorDecimalToMinorString: expected non-negative decimal, got "${str}" (I-S07)`,
    );
  }
  const whole = m[1]!;
  const frac = (m[2] ?? '').padEnd(2, '0').slice(0, 2); // exactly 2 digits, truncate beyond
  // minor = whole*100 + frac (all integer arithmetic via BigInt)
  const minor = BigInt(whole) * 100n + BigInt(frac.length > 0 ? frac : '0');
  return minor.toString();
}

/** Convert an integer-ish count to BIGINT-as-string, or null. */
function toCountString(value: number | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  if (str === '') return null;
  // counts can arrive as "123" or "123.0" from some APIs — take the integer part only
  const m = /^(\d+)(?:\.\d+)?$/.exec(str);
  if (!m) return null;
  return m[1]!;
}

/**
 * Look up the canonical PURCHASE value from a Meta `actions[]` (counts) or `action_values[]`
 * (revenue) array. Returns the first entry's `value` (as a string) matching the highest-priority
 * action_type in `actionTypes` (purchase → omni_purchase → pixel purchase), or null when absent.
 *
 * Used to lift a single canonical purchase COUNT (from actions[]) and purchase REVENUE
 * (from action_values[], a MAJOR-unit decimal in the account currency) out of Meta's nested arrays.
 * The full raw arrays are still preserved in conversions_raw (ADR-AD-8).
 */
function metaActionValue(raw: unknown, actionTypes: readonly string[]): string | null {
  if (!Array.isArray(raw)) return null;
  for (const t of actionTypes) {
    for (const entry of raw) {
      if (
        entry != null &&
        typeof entry === 'object' &&
        (entry as Record<string, unknown>).action_type === t
      ) {
        const v = (entry as Record<string, unknown>).value;
        if (v != null) return String(v);
      }
    }
  }
  return null;
}

/** Ratio / passthrough string, or null. NOT scaled (kept as provided). */
function toRatioString(value: number | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  return str === '' ? null : str;
}

/**
 * Normalize a string-list-ish value (RSA headlines/descriptions, ad final_urls) to a compact JSON
 * array STRING, or null. Accepts an already-serialized JSON string verbatim, or an array of strings.
 * Operational display refs (I-S02) — no PII.
 */
function toJsonArrayString(value: readonly string[] | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return JSON.stringify(value);
  const str = String(value).trim();
  return str === '' ? null : str;
}

// ── Allowlist filter ──────────────────────────────────────────────────────────

/**
 * Filter a canonical spend props object to ONLY the allowlisted keys (I-S02).
 * Used as a final boundary guard — anything not on the allowlist is dropped.
 */
function applyFieldAllowlist(
  props: Record<string, unknown>,
): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  for (const key of AD_SPEND_FIELD_ALLOWLIST) {
    if (key in props) filtered[key] = props[key];
  }
  return filtered;
}

// ── Level resolver ────────────────────────────────────────────────────────────

function resolveLevel(raw: string | null | undefined, fallback: AdSpendLevel): AdSpendLevel {
  switch ((raw ?? '').toLowerCase()) {
    case 'campaign': return 'campaign';
    case 'adset':
    case 'ad_group':
    case 'adgroup': return 'adset';
    case 'ad':
    case 'ad_group_ad': return 'ad';
    case 'creative': return 'creative';
    default: return fallback;
  }
}

/** Resolve the platform-native level_id for a given level from the raw row. */
function resolveLevelId(
  level: AdSpendLevel,
  ids: { campaignId: string | null; adsetId: string | null; adId: string | null },
): string {
  switch (level) {
    case 'campaign': return ids.campaignId ?? '';
    case 'adset':    return ids.adsetId ?? ids.campaignId ?? '';
    case 'ad':
    case 'creative': return ids.adId ?? ids.adsetId ?? ids.campaignId ?? '';
  }
}

/** Resolve the hierarchy parent_id for a given level. */
function resolveParentId(
  level: AdSpendLevel,
  ids: { campaignId: string | null; adsetId: string | null; adId: string | null },
): string | null {
  switch (level) {
    case 'campaign': return null;
    case 'adset':    return ids.campaignId;
    case 'ad':       return ids.adsetId ?? ids.campaignId;
    case 'creative': return ids.adId ?? ids.adsetId;
  }
}

function statDateToIso(statDate: string): string {
  // stat_date is a calendar date (YYYY-MM-DD). Anchor occurred_at at UTC midnight of that date.
  return new Date(`${statDate}T00:00:00.000Z`).toISOString();
}

// ── Meta mapper ───────────────────────────────────────────────────────────────

/**
 * Map a raw Meta Ads Insights row → MappedSpendEvent (spend.live.v1).
 *
 * Invariants:
 *   1. Field allowlist applied (I-S02) — only canonical fields survive.
 *   2. spend (major-unit decimal string) → spend_minor BIGINT-as-string (I-S07, no float).
 *   3. RAW conversion actions preserved in conversions_raw (ADR-AD-8).
 *   4. stat_date = date_start (click-date anchored, canonical — ADR-AD-8).
 *   5. brand_id is NOT taken from the row — the caller supplies it from the connector (MT-1).
 *
 * @param row             Raw Meta Insights row
 * @param accountCurrency Account currency_code (from the connector / account, not the row)
 * @param accountTz       Account stat timezone (from the account, nullable)
 */
export function mapMetaInsightToEvent(
  row: MetaInsightRow,
  accountCurrency: string,
  accountTz: string | null = null,
): MappedSpendEvent {
  const level = resolveLevel(row.level, 'campaign');
  const campaignId = row.campaign_id != null ? String(row.campaign_id) : null;
  const adsetId = row.adset_id != null ? String(row.adset_id) : null;
  const adId = row.ad_id != null ? String(row.ad_id) : null;
  const ids = { campaignId, adsetId, adId };

  const levelId = resolveLevelId(level, ids);
  const parentId = resolveParentId(level, ids);
  const statDate = (row.date_start ?? '').trim();

  const spendMinor = majorDecimalToMinorString(row.spend ?? '0');
  const occurredAt = statDate ? statDateToIso(statDate) : new Date().toISOString();

  // RAW conversion arrays (ADR-AD-8): keep actions[] (counts) AND action_values[] (revenue) verbatim,
  // each only when present (so a no-action row stays { actions } — unchanged shape).
  // ── META-ONLY (Impl-M): also preserve the NEW array-valued raw fields verbatim (ADR-AD-8) so the
  //    lifted scalars above are auditable and nothing is lost. Each is added only when present, so a
  //    base row with only actions stays { actions } byte-for-byte (no golden churn on existing rows). ──
  let conversionsRaw: Record<string, unknown> | null = null;
  const rawArrayFields: Array<[string, unknown]> = [
    ['actions', row.actions],
    ['action_values', row.action_values],
    ['outbound_clicks', row.outbound_clicks],
    ['unique_outbound_clicks', row.unique_outbound_clicks],
    ['purchase_roas', row.purchase_roas],
    ['website_purchase_roas', row.website_purchase_roas],
    ['mobile_app_purchase_roas', row.mobile_app_purchase_roas],
    ['video_play_actions', row.video_play_actions],
    ['video_p25_watched_actions', row.video_p25_watched_actions],
    ['video_p50_watched_actions', row.video_p50_watched_actions],
    ['video_p75_watched_actions', row.video_p75_watched_actions],
    ['video_p100_watched_actions', row.video_p100_watched_actions],
    ['video_thruplay_watched_actions', row.video_thruplay_watched_actions],
    ['video_30_sec_watched_actions', row.video_30_sec_watched_actions],
    ['video_avg_time_watched_actions', row.video_avg_time_watched_actions],
  ];
  for (const [k, v] of rawArrayFields) {
    if (v != null) {
      conversionsRaw ??= {};
      conversionsRaw[k] = v;
    }
  }

  // Canonical purchase COUNT (actions[]) and purchase REVENUE (action_values[], MAJOR-unit decimal in
  // the account currency → MINOR units, no float). conv_value_minor shares currency_code (never blended).
  const purchaseCount = metaActionValue(row.actions, META_PURCHASE_ACTION_TYPES);
  const purchaseValue = metaActionValue(row.action_values, META_PURCHASE_ACTION_TYPES);

  // ── META-ONLY (Impl-M) — array-lifts for the enriched metrics. Each *_watched_actions / *_roas /
  //    outbound array is [{ action_type, value }, ...]; metaActionValue lifts the first-match value.
  //    Engagement + landing_page_views arrive inside actions[]. The FULL raw arrays are preserved
  //    verbatim in conversions_raw below (ADR-AD-8) — nothing is lost. ────────────────────────────
  const videoViewsRaw = metaActionValue(row.video_play_actions, ['video_view']);
  const landingPageViews = metaActionValue(row.actions, META_LANDING_PAGE_VIEW_TYPES);
  const outboundClicks = metaActionValue(row.outbound_clicks, META_OUTBOUND_CLICK_TYPES);
  const uniqueOutboundClicks = metaActionValue(row.unique_outbound_clicks, META_OUTBOUND_CLICK_TYPES);
  const postEngagement = metaActionValue(row.actions, META_POST_ENGAGEMENT_TYPES);
  const pageEngagement = metaActionValue(row.actions, META_PAGE_ENGAGEMENT_TYPES);
  const videoP25 = metaActionValue(row.video_p25_watched_actions, ['video_view']);
  const videoP50 = metaActionValue(row.video_p50_watched_actions, ['video_view']);
  const videoP75 = metaActionValue(row.video_p75_watched_actions, ['video_view']);
  const videoP100 = metaActionValue(row.video_p100_watched_actions, ['video_view']);
  const videoThruplay = metaActionValue(row.video_thruplay_watched_actions, ['video_view']);
  const video30Sec = metaActionValue(row.video_30_sec_watched_actions, ['video_view']);
  const videoAvgTime = metaActionValue(row.video_avg_time_watched_actions, ['video_view']);
  const purchaseRoas = metaActionValue(row.purchase_roas, META_PURCHASE_ROAS_TYPES);
  const websitePurchaseRoas = metaActionValue(row.website_purchase_roas, META_WEBSITE_PURCHASE_ROAS_TYPES);
  const mobileAppPurchaseRoas = metaActionValue(
    row.mobile_app_purchase_roas,
    META_MOBILE_APP_PURCHASE_ROAS_TYPES,
  );

  // Breakdown dims present on this row → the canonical breakdownKey folded into the dedup event_id.
  const breakdownKey = canonicalBreakdownKey({
    age: row.age ?? undefined,
    gender: row.gender ?? undefined,
    country: row.country ?? undefined,
    region: row.region ?? undefined,
    dma: row.dma ?? undefined,
    publisher_platform: row.publisher_platform ?? undefined,
    platform_position: row.platform_position ?? undefined,
    device_platform: row.device_platform ?? undefined,
    impression_device: row.impression_device ?? undefined,
    hourly_stats_aggregated_by_advertiser_time_zone:
      row.hourly_stats_aggregated_by_advertiser_time_zone ?? undefined,
  });

  const props: SpendEventProperties = {
    source: 'meta',
    platform: 'meta',
    level,
    level_id: levelId,
    parent_id: parentId,
    campaign_id: campaignId,
    campaign_name: row.campaign_name != null ? String(row.campaign_name) : null,
    stat_date: statDate,
    spend_minor: spendMinor,
    currency_code: accountCurrency.trim().toUpperCase(),
    impressions: toCountString(row.impressions),
    clicks: toCountString(row.clicks),
    conversions: toCountString(purchaseCount),
    all_conversions: null, // Meta has no distinct all_conversions metric — only platform-attributed actions
    conv_value_minor: purchaseValue != null ? majorDecimalToMinorString(purchaseValue) : null,
    view_through_conversions: null, // not in the surviving Meta attribution set
    ctr: row.ctr != null ? String(row.ctr) : null,
    cpc_minor: row.cpc != null ? majorDecimalToMinorString(row.cpc) : null,
    cpm_minor: row.cpm != null ? majorDecimalToMinorString(row.cpm) : null,
    advertising_channel_type: null, // Google-only concept
    conversions_raw: conversionsRaw,
    account_timezone: accountTz,
    occurred_at: occurredAt,
    // ── COMMON columns — Meta populates video_views (from video_play_actions); the rest are Google-only. ──
    video_views: toCountString(videoViewsRaw),
    video_view_rate: null,                 // Meta has no direct analog → null
    engagements: null,                     // Meta keeps post/page engagement separate (below) → null
    engagement_rate: null,
    cost_per_conversion_minor: null,       // Google-only
    value_per_conversion_minor: null,      // Google-only
    breakdown_key: breakdownKey,
    // ── META-ONLY (Impl-M) — enriched insight metrics. Money via majorDecimalToMinorString; counts via
    //    toCountString; ratios/rankings string passthrough; frequency is a decimal ratio (NOT money). ──
    reach: toCountString(row.reach),
    frequency: row.frequency != null ? String(row.frequency) : null,
    cpp_minor: row.cpp != null ? majorDecimalToMinorString(row.cpp) : null,
    unique_clicks: toCountString(row.unique_clicks),
    unique_ctr: row.unique_ctr != null ? String(row.unique_ctr) : null,
    inline_link_clicks: toCountString(row.inline_link_clicks),
    inline_link_click_ctr: row.inline_link_click_ctr != null ? String(row.inline_link_click_ctr) : null,
    outbound_clicks: toCountString(outboundClicks),
    unique_outbound_clicks: toCountString(uniqueOutboundClicks),
    cost_per_unique_click_minor:
      row.cost_per_unique_click != null ? majorDecimalToMinorString(row.cost_per_unique_click) : null,
    cost_per_inline_link_click_minor:
      row.cost_per_inline_link_click != null
        ? majorDecimalToMinorString(row.cost_per_inline_link_click)
        : null,
    landing_page_views: toCountString(landingPageViews),
    purchase_roas_ratio: purchaseRoas,                         // raw ratio string passthrough
    website_purchase_roas_ratio: websitePurchaseRoas,
    mobile_app_purchase_roas_ratio: mobileAppPurchaseRoas,
    post_engagement: toCountString(postEngagement),
    page_engagement: toCountString(pageEngagement),
    inline_post_engagement: toCountString(
      row['inline_post_engagement'] as string | number | null | undefined,
    ),
    video_p25_watched: toCountString(videoP25),
    video_p50_watched: toCountString(videoP50),
    video_p75_watched: toCountString(videoP75),
    video_p100_watched: toCountString(videoP100),
    video_thruplay_watched: toCountString(videoThruplay),
    video_30_sec_watched: toCountString(video30Sec),
    video_avg_time_watched_secs: toCountString(videoAvgTime),
    quality_ranking: row.quality_ranking != null ? String(row.quality_ranking) : null,
    engagement_rate_ranking:
      row.engagement_rate_ranking != null ? String(row.engagement_rate_ranking) : null,
    conversion_rate_ranking:
      row.conversion_rate_ranking != null ? String(row.conversion_rate_ranking) : null,
    // Meta breakdown dims (base pass → all null; a breakdown pass populates only its dims):
    age: row.age != null ? String(row.age) : null,
    gender: row.gender != null ? String(row.gender) : null,
    country: row.country != null ? String(row.country) : null,
    region: row.region != null ? String(row.region) : null,
    dma: row.dma != null ? String(row.dma) : null,
    publisher_platform: row.publisher_platform != null ? String(row.publisher_platform) : null,
    platform_position: row.platform_position != null ? String(row.platform_position) : null,
    device_platform: row.device_platform != null ? String(row.device_platform) : null,
    impression_device: row.impression_device != null ? String(row.impression_device) : null,
    hourly_stats_aggregated_by_advertiser_time_zone:
      row.hourly_stats_aggregated_by_advertiser_time_zone != null
        ? String(row.hourly_stats_aggregated_by_advertiser_time_zone)
        : null,
  };

  // Final allowlist boundary (I-S02): drop anything not canonical, then re-assert shape.
  applyFieldAllowlist(props as unknown as Record<string, unknown>);

  return {
    event_name: SPEND_LIVE_V1_EVENT_NAME,
    occurred_at: occurredAt,
    properties: props,
  };
}

// ── Google mapper ─────────────────────────────────────────────────────────────

/**
 * Map a raw Google Ads SearchStream (GAQL) row → MappedSpendEvent (spend.live.v1).
 *
 * Invariants:
 *   1. Field allowlist applied (I-S02).
 *   2. cost_micros (integer micros) → spend_minor BIGINT-as-string (I-S07, micros/10_000).
 *   3. BOTH metrics.conversions AND metrics.all_conversions preserved RAW (ADR-AD-8).
 *   4. stat_date = segments.date (click-date anchored, canonical — ADR-AD-8).
 *   5. brand_id supplied by the caller from the connector (MT-1) — never the row.
 *
 * @param row             Raw flattened Google Ads row
 * @param accountCurrency Account currency_code (customer.currency_code, supplied by caller)
 * @param accountTz       Account stat timezone (customer.time_zone, nullable)
 */
export function mapGoogleRowToEvent(
  row: GoogleAdsRow,
  accountCurrency: string,
  accountTz: string | null = null,
): MappedSpendEvent {
  const level = resolveLevel(row.level, 'campaign');
  const campaignId = row.campaign_id != null ? String(row.campaign_id) : null;
  const adGroupId = row.ad_group_id != null ? String(row.ad_group_id) : null;
  const adId = row.ad_id != null ? String(row.ad_id) : null;
  // Google ad_group maps to the canonical 'adset' level.
  const ids = { campaignId, adsetId: adGroupId, adId };

  const levelId = resolveLevelId(level, ids);
  const parentId = resolveParentId(level, ids);
  const statDate = (row.segments_date ?? '').trim();

  const spendMinor = microsToMinorString(row.cost_micros ?? '0');
  const occurredAt = statDate ? statDateToIso(statDate) : new Date().toISOString();

  // ADR-AD-8: store BOTH conversion metrics RAW — Silver/Gold picks canonical. Firehose extension:
  // preserve the additional raw conversion/value blocks verbatim too (do NOT replace the existing
  // object — extend it, per the array-lift-preservation rule). Only non-null keys are added so a
  // row without the firehose fields keeps the { conversions, all_conversions } shape unchanged.
  const conversionsRaw: Record<string, unknown> = {
    conversions: row.conversions ?? null,
    all_conversions: row.all_conversions ?? null,
  };
  if (row.conversions_value != null) conversionsRaw.conversions_value = row.conversions_value;
  if (row.all_conversions_value != null) conversionsRaw.all_conversions_value = row.all_conversions_value;
  if (row.view_through_conversions != null) conversionsRaw.view_through_conversions = row.view_through_conversions;

  const props: SpendEventProperties = {
    source: 'google_ads',
    platform: 'google_ads',
    level,
    level_id: levelId,
    parent_id: parentId,
    campaign_id: campaignId,
    campaign_name: row.campaign_name != null ? String(row.campaign_name) : null,
    stat_date: statDate,
    spend_minor: spendMinor,
    currency_code: (row.currency_code ?? accountCurrency).trim().toUpperCase(),
    impressions: toCountString(row.impressions),
    clicks: toCountString(row.clicks),
    // conversions/all_conversions: lift the RAW counts to first-class count columns (still preserved
    // raw in conversions_raw). conversions_value is a MAJOR-unit double (account currency) → MINOR
    // units via the integer major-decimal path (no float). average_cpc/cpm are MICROS → MINOR units.
    conversions: toCountString(row.conversions),
    all_conversions: toCountString(row.all_conversions),
    conv_value_minor:
      row.conversions_value != null ? majorDecimalToMinorString(String(row.conversions_value)) : null,
    view_through_conversions: toCountString(row.view_through_conversions),
    ctr: row.ctr != null ? String(row.ctr) : null,
    cpc_minor: row.average_cpc != null ? microsToMinorString(row.average_cpc) : null,
    cpm_minor: row.average_cpm != null ? microsToMinorString(row.average_cpm) : null,
    advertising_channel_type:
      row.advertising_channel_type != null ? String(row.advertising_channel_type) : null,
    conversions_raw: conversionsRaw,
    account_timezone: accountTz,
    // ── COMMON (spec §1.A) — Google fills; money via micros→minor. ──
    video_views: toCountString(row.video_views),
    video_view_rate: toRatioString(row.video_view_rate),
    engagements: toCountString(row.engagements),
    engagement_rate: toRatioString(row.engagement_rate),
    cost_per_conversion_minor:
      row.cost_per_conversion != null ? microsToMinorString(row.cost_per_conversion) : null,
    value_per_conversion_minor:
      row.value_per_conversion != null ? microsToMinorString(row.value_per_conversion) : null,
    // ── GOOGLE-ONLY firehose metrics (Impl-G). all_conversions_value is a MAJOR double → minor;
    //    cost_per_all_conversions / average_cost are MICROS → minor; the rest are ratio passthroughs. ──
    all_conversions_value_minor:
      row.all_conversions_value != null ? majorDecimalToMinorString(String(row.all_conversions_value)) : null,
    cost_per_all_conversions_minor:
      row.cost_per_all_conversions != null ? microsToMinorString(row.cost_per_all_conversions) : null,
    average_cost_minor: row.average_cost != null ? microsToMinorString(row.average_cost) : null,
    search_impression_share: toRatioString(row.search_impression_share),
    search_budget_lost_impression_share: toRatioString(row.search_budget_lost_impression_share),
    search_rank_lost_impression_share: toRatioString(row.search_rank_lost_impression_share),
    absolute_top_impression_percentage: toRatioString(row.absolute_top_impression_percentage),
    top_impression_percentage: toRatioString(row.top_impression_percentage),
    interactions: toCountString(row.interactions),
    interaction_rate: toRatioString(row.interaction_rate),
    conversions_from_interactions_rate: toRatioString(row.conversions_from_interactions_rate),
    // ── GOOGLE-ONLY breakdown/segment dims (operational refs; fold into breakdownKey seed at emit). ──
    segment_device: row.segment_device != null ? String(row.segment_device) : null,
    segment_ad_network_type: row.segment_ad_network_type != null ? String(row.segment_ad_network_type) : null,
    segment_day_of_week: row.segment_day_of_week != null ? String(row.segment_day_of_week) : null,
    segment_hour: row.segment_hour != null ? String(row.segment_hour) : null,
    segment_click_type: row.segment_click_type != null ? String(row.segment_click_type) : null,
    segment_conversion_action: row.segment_conversion_action != null ? String(row.segment_conversion_action) : null,
    segment_conversion_action_name:
      row.segment_conversion_action_name != null ? String(row.segment_conversion_action_name) : null,
    segment_geo_target: row.segment_geo_target != null ? String(row.segment_geo_target) : null,
    segment_age_range: row.segment_age_range != null ? String(row.segment_age_range) : null,
    segment_gender: row.segment_gender != null ? String(row.segment_gender) : null,
    keyword_id: row.keyword_id != null ? String(row.keyword_id) : null,
    keyword_text: row.keyword_text != null ? String(row.keyword_text) : null,
    keyword_match_type: row.keyword_match_type != null ? String(row.keyword_match_type) : null,
    search_term: row.search_term != null ? String(row.search_term) : null,
    product_item_id: row.product_item_id != null ? String(row.product_item_id) : null,
    product_title: row.product_title != null ? String(row.product_title) : null,
    product_brand: row.product_brand != null ? String(row.product_brand) : null,
    // ── GOOGLE-ONLY entity-depth refs. campaign_budget / cpc_bid are MICROS → minor. ──
    advertising_channel_sub_type:
      row.advertising_channel_sub_type != null ? String(row.advertising_channel_sub_type) : null,
    bidding_strategy_type: row.bidding_strategy_type != null ? String(row.bidding_strategy_type) : null,
    campaign_status: row.campaign_status != null ? String(row.campaign_status) : null,
    campaign_start_date: row.campaign_start_date != null ? String(row.campaign_start_date) : null,
    campaign_end_date: row.campaign_end_date != null ? String(row.campaign_end_date) : null,
    campaign_budget_amount_minor:
      row.campaign_budget_amount_micros != null ? microsToMinorString(row.campaign_budget_amount_micros) : null,
    ad_group_type: row.ad_group_type != null ? String(row.ad_group_type) : null,
    ad_group_status: row.ad_group_status != null ? String(row.ad_group_status) : null,
    ad_group_cpc_bid_minor:
      row.ad_group_cpc_bid_micros != null ? microsToMinorString(row.ad_group_cpc_bid_micros) : null,
    ad_type: row.ad_type != null ? String(row.ad_type) : null,
    ad_final_urls: toJsonArrayString(row.ad_final_urls),
    ad_headlines: toJsonArrayString(row.ad_headlines),
    ad_descriptions: toJsonArrayString(row.ad_descriptions),
    occurred_at: occurredAt,
    // COMMON metrics are populated above (Google fills video_views…value_per_conversion_minor). The
    // Google segment breakdown_key is folded at Silver (build_google → u_gbk over the segment_* cols),
    // so the mapper emits base breakdown_key='' here and carries the segment_* dims for that fold.
    breakdown_key: '',
    // ── META-ONLY fields — never populated on the Google lane (null). ──────────────────────────────
    reach: null,
    frequency: null,
    cpp_minor: null,
    unique_clicks: null,
    unique_ctr: null,
    inline_link_clicks: null,
    inline_link_click_ctr: null,
    outbound_clicks: null,
    unique_outbound_clicks: null,
    cost_per_unique_click_minor: null,
    cost_per_inline_link_click_minor: null,
    landing_page_views: null,
    purchase_roas_ratio: null,
    website_purchase_roas_ratio: null,
    mobile_app_purchase_roas_ratio: null,
    post_engagement: null,
    page_engagement: null,
    inline_post_engagement: null,
    video_p25_watched: null,
    video_p50_watched: null,
    video_p75_watched: null,
    video_p100_watched: null,
    video_thruplay_watched: null,
    video_30_sec_watched: null,
    video_avg_time_watched_secs: null,
    quality_ranking: null,
    engagement_rate_ranking: null,
    conversion_rate_ranking: null,
    age: null,
    gender: null,
    country: null,
    region: null,
    dma: null,
    publisher_platform: null,
    platform_position: null,
    device_platform: null,
    impression_device: null,
    hourly_stats_aggregated_by_advertiser_time_zone: null,
  };

  applyFieldAllowlist(props as unknown as Record<string, unknown>);

  return {
    event_name: SPEND_LIVE_V1_EVENT_NAME,
    occurred_at: occurredAt,
    properties: props,
  };
}
