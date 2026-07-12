/**
 * gen-ad-spend-golden.ts — ADR-0006 P4 golden-vector generator for the ad-spend normalizer.
 *
 * Runs the REAL TypeScript @brain/ad-spend-mapper (mapMetaInsightToEvent + mapGoogleRowToEvent +
 * uuidV5FromSpendRow) over representative RAW Meta/Google rows and dumps {raw, brand_id, salt_hex,
 * account_currency, account_timezone, expected:{...canonical fields...}} JSON. test_ad-spend-golden.py
 * then asserts the PySpark-side ports reproduce `expected` byte-for-byte — closing the parity loop.
 *
 * Ad spend has NO PII (I-S02) so salt_hex is a no-op (kept for the P4 golden-vector schema shape).
 *
 * Run:  pnpm --filter @brain/ad-spend-mapper... tsx db/iceberg/spark/silver/_p4_golden/gen-ad-spend-golden.ts \
 *         > db/iceberg/spark/silver/_p4_golden/ad-spend-golden.json
 */
import {
  mapMetaInsightToEvent,
  mapGoogleRowToEvent,
  uuidV5FromSpendRow,
} from '@brain/ad-spend-mapper';

const SALT = 'a'.repeat(64); // fixed 64-hex salt (unused for ad-spend — schema parity only)
const BRAND = '444a25f2-57d4-4e04-9f70-98a6480e1fc4';

// ── Representative RAW inputs (envelope.source discriminates platform) ─────────────────────────────────
const metaRows: Array<{ row: any; account_currency: string; account_timezone: string | null }> = [
  {
    // campaign level, fractional spend, conversions actions present
    row: {
      level: 'campaign', campaign_id: 'c_42', campaign_name: 'Summer Sale',
      spend: '123.45', impressions: '1000', clicks: '50', date_start: '2026-06-10',
      actions: [{ action_type: 'purchase', value: '3' }],
    },
    account_currency: 'usd', account_timezone: 'America/Los_Angeles',
  },
  {
    // adset level → parent_id resolves to campaign; whole-number spend; no actions
    row: {
      level: 'adset', campaign_id: 'c1', adset_id: 'as1', ad_id: null,
      spend: '799', impressions: null, clicks: '0', date_start: '2026-06-21',
    },
    account_currency: 'inr', account_timezone: null,
  },
  {
    // FIREHOSE demographic breakdown (age+gender) — breakdown_key folds the dims; event_id distinct
    // from the base row at the same (brand,platform,statDate,level,levelId).
    row: {
      level: 'campaign', campaign_id: 'c_42', campaign_name: 'Summer Sale',
      spend: '10.00', impressions: '100', clicks: '5', date_start: '2026-06-10',
      age: '25-34', gender: 'female',
    },
    account_currency: 'usd', account_timezone: 'America/Los_Angeles',
  },
  {
    // FIREHOSE placement breakdown (publisher_platform + platform_position + device_platform).
    row: {
      level: 'campaign', campaign_id: 'c_42', spend: '5.50', impressions: '50', clicks: '2',
      date_start: '2026-06-10', publisher_platform: 'instagram', platform_position: 'feed',
      device_platform: 'mobile_app',
    },
    account_currency: 'usd', account_timezone: null,
  },
  {
    // FIREHOSE geo breakdown (country + region) — verifies escaping-free byte join + sort order.
    row: {
      level: 'campaign', campaign_id: 'c_42', spend: '3.25', impressions: '30', clicks: '1',
      date_start: '2026-06-10', country: 'US', region: 'California',
    },
    account_currency: 'usd', account_timezone: null,
  },
  {
    // FIREHOSE hourly breakdown — a single-dim breakdown_key.
    row: {
      level: 'campaign', campaign_id: 'c_42', spend: '1.00', impressions: '10', clicks: '0',
      date_start: '2026-06-10',
      hourly_stats_aggregated_by_advertiser_time_zone: '00:00:00 - 00:59:59',
    },
    account_currency: 'usd', account_timezone: null,
  },
];

const googleRows: Array<{ row: any; account_currency: string; account_timezone: string | null }> = [
  {
    // ad_group → canonical adset; micros→minor; BOTH conversion metrics raw; row currency wins
    row: {
      level: 'ad_group', campaign_id: 'gc1', campaign_name: 'Brand', ad_group_id: 'ag1', ad_id: null,
      cost_micros: '5550000', impressions: '200', clicks: '10',
      conversions: '2.5', all_conversions: '4.0', segments_date: '2026-06-09', currency_code: 'usd',
    },
    account_currency: 'USD', account_timezone: 'America/New_York',
  },
  {
    // ad level → level_id = ad_id, parent_id = ad_group; large micros (no float loss); account currency fallback
    row: {
      level: 'ad', campaign_id: 'gc2', ad_group_id: 'ag2', ad_id: 'adx',
      cost_micros: '999999999999990000', impressions: '7', clicks: '1',
      conversions: '0', all_conversions: '0', segments_date: '2026-06-22', currency_code: null,
    },
    account_currency: 'aed', account_timezone: null,
  },
];

function expectedFrom(ev: ReturnType<typeof mapMetaInsightToEvent>) {
  const p = ev.properties;
  // FIREHOSE: fold the row's breakdown_key ('' for base) into the event_id seed (§2.A). Base vectors
  // keep breakdown_key='' → base event_ids are byte-unchanged; a breakdown vector proves distinctness.
  const event_id = uuidV5FromSpendRow(
    BRAND, p.platform, p.stat_date, p.level, p.level_id, p.breakdown_key ?? '',
  );
  return {
    event_id,
    breakdown_key: p.breakdown_key,
    occurred_at: ev.occurred_at,
    platform: p.platform,
    level: p.level,
    level_id: p.level_id,
    parent_id: p.parent_id,
    campaign_id: p.campaign_id,
    campaign_name: p.campaign_name,
    stat_date: p.stat_date,
    spend_minor: p.spend_minor,
    currency_code: p.currency_code,
    impressions: p.impressions,
    clicks: p.clicks,
  };
}

const vectors = [
  ...metaRows.map((m) => ({
    platform: 'meta' as const,
    raw_row: m.row,
    brand_id: BRAND,
    salt_hex: SALT,
    account_currency: m.account_currency,
    account_timezone: m.account_timezone,
    expected: expectedFrom(mapMetaInsightToEvent(m.row, m.account_currency, m.account_timezone)),
  })),
  ...googleRows.map((g) => ({
    platform: 'google_ads' as const,
    raw_row: g.row,
    brand_id: BRAND,
    salt_hex: SALT,
    account_currency: g.account_currency,
    account_timezone: g.account_timezone,
    expected: expectedFrom(mapGoogleRowToEvent(g.row, g.account_currency, g.account_timezone)),
  })),
];

console.log(JSON.stringify(vectors, null, 2));
