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
  occurred_at: string;              // ISO-8601 — economic_effective_at
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
 */
export function uuidV5FromSpendRow(
  brandId: string,
  platform: AdPlatform,
  statDate: string,
  level: AdSpendLevel,
  levelId: string,
): string {
  return hashToUuidShaped(
    `${brandId}:${platform}:${statDate}:${level}:${levelId}:spend.live.v1`,
  );
}

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
  let conversionsRaw: Record<string, unknown> | null = null;
  if (row.actions != null || row.action_values != null) {
    conversionsRaw = {};
    if (row.actions != null) conversionsRaw.actions = row.actions;
    if (row.action_values != null) conversionsRaw.action_values = row.action_values;
  }

  // Canonical purchase COUNT (actions[]) and purchase REVENUE (action_values[], MAJOR-unit decimal in
  // the account currency → MINOR units, no float). conv_value_minor shares currency_code (never blended).
  const purchaseCount = metaActionValue(row.actions, META_PURCHASE_ACTION_TYPES);
  const purchaseValue = metaActionValue(row.action_values, META_PURCHASE_ACTION_TYPES);

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

  // ADR-AD-8: store BOTH conversion metrics RAW — Silver/Gold picks canonical.
  const conversionsRaw: Record<string, unknown> = {
    conversions: row.conversions ?? null,
    all_conversions: row.all_conversions ?? null,
  };

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
    occurred_at: occurredAt,
  };

  applyFieldAllowlist(props as unknown as Record<string, unknown>);

  return {
    event_name: SPEND_LIVE_V1_EVENT_NAME,
    occurred_at: occurredAt,
    properties: props,
  };
}
