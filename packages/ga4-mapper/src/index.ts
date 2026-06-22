/**
 * @brain/ga4-mapper — GA4 Data API runReport row → canonical ga4.session.v1 CanonicalEvent.
 *
 * DETERMINISM CONTRACT (I-ST04):
 *   event_id = hashToUuidShaped(`${brandId}:ga4:${propertyId}:${dimensions}:ga4.session.v1`)
 *   where `dimensions` is a stable colon-joined string of all dimension values in declaration
 *   order. Same GA4 report row re-read in a trailing-window re-pull → same event_id →
 *   Bronze ON CONFLICT DO NOTHING dedup (idempotent replay).
 *
 * INVARIANTS:
 *   - I-S07 (money): GA4 carries revenue in major-unit decimal strings. All money fields are
 *     converted to BIGINT-as-string minor units. Currency code is mandatory alongside every
 *     money field.
 *   - I-S02 / D-10 (PII): GA4 runReport rows carry NO contact PII (email/phone). Dimension
 *     values such as `sessionSource`, `sessionMedium` are operational references, not PII.
 *     The field allowlist enforces this: nothing outside GA4_SESSION_FIELD_ALLOWLIST crosses
 *     the mapper boundary.
 *   - SAMPLING: GA4 returns `samplingMetadatas` when the report is sampled. The mapper stamps
 *     `is_sampled: true` and preserves `samples_read_count` + `sampling_space_size` so
 *     downstream consumers can reject or weight sampled data explicitly.
 *   - QUOTA: row-level quota metadata from the API is passed through for observability.
 *   - brand_id is NEVER derived from the GA4 row — it is always supplied by the caller from
 *     the connector record (MT-1).
 *
 * Exports:
 *   GA4_SESSION_EVENT_NAME          — 'ga4.session.v1'
 *   GA4_SESSION_FIELD_ALLOWLIST     — hard allowlist
 *   Ga4ReportRow                    — raw input type (one row from runReport response)
 *   Ga4SessionProperties            — typed canonical output properties
 *   Ga4MappedEvent                  — mapped event type
 *   Ga4SamplingMetadata             — per-report sampling annotation
 *   mapGa4RowToEvent                — row → Ga4MappedEvent (pure, deterministic)
 *   uuidV5FromGa4Row                — deterministic event_id seed
 *   majorDecimalToMinorString       — revenue string → BIGINT-as-string minor units (I-S07)
 */

import { hashToUuidShaped } from '@brain/connector-core';

// ── Event name constant ───────────────────────────────────────────────────────

/** Canonical GA4 session event name on the collector.event.v1 live lane. */
export const GA4_SESSION_EVENT_NAME = 'ga4.session.v1' as const;

// ── Field allowlist (HARD — nothing outside this set crosses the boundary) ────

export const GA4_SESSION_FIELD_ALLOWLIST = new Set([
  'source',
  'property_id',
  'date',
  'session_source',
  'session_medium',
  'session_campaign_name',
  'session_default_channel_group',
  'device_category',
  'country',
  'sessions',
  'engaged_sessions',
  'bounces',
  'total_users',
  'new_users',
  'screen_page_views',
  'event_count',
  'conversions',
  'revenue_minor',
  'currency_code',
  'is_sampled',
  'samples_read_count',
  'sampling_space_size',
  'occurred_at',
] as const);

// ── Output types ─────────────────────────────────────────────────────────────

/**
 * Sampling annotation from a GA4 runReport response.
 * Stamped on the mapped event when the report was sampled (is_sampled=true).
 */
export interface Ga4SamplingMetadata {
  /** Number of samples read for this report. */
  readonly samplesReadCount: string | null;
  /** Total sampling space size (universe). */
  readonly samplingSpaceSize: string | null;
}

/**
 * Typed properties for a ga4.session.v1 canonical event.
 * All monetary amounts are BIGINT-as-string minor units (I-S07).
 * No contact PII — dimension values are operational analytics references (I-S02).
 */
export interface Ga4SessionProperties {
  /** Fixed: 'ga4' — origin source identifier. */
  readonly source: 'ga4';
  /** GA4 property id (e.g. '123456789'). Operational reference, not PII. */
  readonly property_id: string;
  /** Report date YYYY-MM-DD. */
  readonly date: string;
  /** Traffic source (e.g. 'google', 'direct', 'email'). */
  readonly session_source: string | null;
  /** Traffic medium (e.g. 'cpc', 'organic', 'email'). */
  readonly session_medium: string | null;
  /** Campaign name dimension. */
  readonly session_campaign_name: string | null;
  /** Default channel grouping (e.g. 'Organic Search', 'Paid Social'). */
  readonly session_default_channel_group: string | null;
  /** Device category ('desktop' | 'mobile' | 'tablet'). */
  readonly device_category: string | null;
  /** ISO-3166-1 alpha-2 country code. */
  readonly country: string | null;
  /** Total sessions count (BIGINT-as-string). */
  readonly sessions: string | null;
  /** Engaged sessions count (BIGINT-as-string). */
  readonly engaged_sessions: string | null;
  /** Bounce count (BIGINT-as-string). */
  readonly bounces: string | null;
  /** Total users (BIGINT-as-string). */
  readonly total_users: string | null;
  /** New users (BIGINT-as-string). */
  readonly new_users: string | null;
  /** Screen/page views (BIGINT-as-string). */
  readonly screen_page_views: string | null;
  /** Event count (BIGINT-as-string). */
  readonly event_count: string | null;
  /** Conversions count (BIGINT-as-string). */
  readonly conversions: string | null;
  /**
   * Total revenue in BIGINT-as-string minor units (I-S07).
   * GA4 totalRevenue is a major-unit decimal string (e.g. "12.34" USD).
   */
  readonly revenue_minor: string;
  /** ISO-4217 currency code supplied by the caller (from connector, not from row). */
  readonly currency_code: string;
  /** True when the GA4 report was sampled (quota or property volume threshold). */
  readonly is_sampled: boolean;
  /** GA4 samplesReadCount when sampled, null otherwise. */
  readonly samples_read_count: string | null;
  /** GA4 samplingSpaceSize when sampled, null otherwise. */
  readonly sampling_space_size: string | null;
  /** ISO-8601 occurred_at — UTC midnight of the report date. */
  readonly occurred_at: string;
}

export interface Ga4MappedEvent {
  readonly event_name: typeof GA4_SESSION_EVENT_NAME;
  readonly occurred_at: string;
  readonly properties: Ga4SessionProperties;
}

// ── Raw input types (runReport API shape) ────────────────────────────────────

/**
 * One flattened row from a GA4 Data API runReport response.
 * Dimension and metric values arrive as strings in the API; we keep them as strings here.
 * The caller (ga4-repull) is responsible for flattening the dimension/metric arrays into this
 * record keyed by the dimension/metric name.
 */
export interface Ga4ReportRow {
  /** YYYY-MM-DD from the 'date' dimension (required — the dedup grain). */
  date?: string | null;
  sessionSource?: string | null;
  sessionMedium?: string | null;
  sessionCampaignName?: string | null;
  sessionDefaultChannelGroup?: string | null;
  deviceCategory?: string | null;
  country?: string | null;
  sessions?: string | null;
  engagedSessions?: string | null;
  bounceRate?: string | null;       // bounce rate [0–1]; we compute bounces = round(bounceRate * sessions)
  bounces?: string | null;          // some runReport configurations return bounces directly
  totalUsers?: string | null;
  newUsers?: string | null;
  screenPageViews?: string | null;
  eventCount?: string | null;
  conversions?: string | null;
  totalRevenue?: string | null;     // major-unit decimal string, e.g. "12.34" (I-S07 conversion needed)
  /** Extra fields are accepted but dropped by the allowlist. */
  [key: string]: unknown;
}

/**
 * Sampling metadata from the runReport response level.
 * The GA4 API returns samplingMetadatas as an array (one entry per date range).
 * The caller extracts and passes this for the mapper to stamp.
 */
export interface Ga4RunReportSampling {
  readonly samplesReadCount?: string | null;
  readonly samplingSpaceSize?: string | null;
}

// ── Money util ────────────────────────────────────────────────────────────────

/**
 * Convert a GA4 major-unit decimal revenue string to BIGINT-as-string minor units.
 * GA4 totalRevenue arrives as a major-unit decimal string (e.g. "12.34" USD).
 *
 * Integer arithmetic only via BigInt — NO parseFloat (I-S07).
 * Normalises fractional part to exactly 2 digits (truncates beyond 2, no rounding).
 *
 * "12.34" → "1234"
 * "12"    → "1200"
 * "12.3"  → "1230"
 * "0"     → "0"
 * ""      → "0"
 * null    → "0"
 *
 * @throws if the value is not a well-formed non-negative decimal
 */
export function majorDecimalToMinorString(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '0';
  const str = String(value).trim();
  if (str === '' || str === '0') return '0';
  const m = /^(\d+)(?:\.(\d+))?$/.exec(str);
  if (!m) {
    throw new Error(
      `[ga4-mapper] majorDecimalToMinorString: expected non-negative decimal, got "${str}" (I-S07)`,
    );
  }
  const whole = m[1]!;
  const frac = (m[2] ?? '').padEnd(2, '0').slice(0, 2);
  const minor = BigInt(whole) * 100n + BigInt(frac.length > 0 ? frac : '0');
  return minor.toString();
}

// ── Count util ────────────────────────────────────────────────────────────────

/** Parse an integer-ish count string to BIGINT-as-string, or null if absent/invalid. */
function toCountString(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  if (str === '') return null;
  // Counts may arrive as "123" or "123.0" — take the integer part.
  const m = /^(\d+)(?:\.\d+)?$/.exec(str);
  if (!m) return null;
  return m[1]!;
}

// ── Bounce calc ───────────────────────────────────────────────────────────────

/**
 * Resolve bounce count from the raw row.
 * GA4 may provide either `bounces` directly (preferred) or `bounceRate` (a 0–1 fraction)
 * + `sessions`. We compute bounces = round(bounceRate * sessions) only when `bounces` is absent.
 */
function resolveBounces(row: Ga4ReportRow): string | null {
  if (row.bounces != null && row.bounces !== '') return toCountString(row.bounces);
  if (row.bounceRate != null && row.sessions != null) {
    const rate = parseFloat(String(row.bounceRate));
    const sessions = parseInt(String(row.sessions), 10);
    if (!isNaN(rate) && !isNaN(sessions)) {
      return String(Math.round(rate * sessions));
    }
  }
  return null;
}

// ── Deterministic event_id ────────────────────────────────────────────────────

/**
 * Deterministic event_id for a GA4 session report row (I-ST04).
 *
 * Seed: sha256(`${brandId}:ga4:${propertyId}:${date}:${source}:${medium}:${campaign}:${channel}:${device}:${country}:ga4.session.v1`)
 *
 * The dimension tuple (date + source + medium + campaign + channel + device + country) is the
 * natural dedup grain for a GA4 session report grouped by those dimensions. The same report row
 * re-pulled in a trailing window produces the same event_id → idempotent Bronze dedup.
 *
 * Includes the literal 'ga4' token + ':ga4.session.v1' suffix — provably non-colliding with
 * ':spend.live.v1' / ':order.live.v1' / ':settlement.live.v1' namespaces.
 *
 * @param brandId     Brand UUID — from connector, NEVER from GA4 API (MT-1)
 * @param propertyId  GA4 property id string (e.g. '123456789')
 * @param date        YYYY-MM-DD report date
 * @param source      sessionSource dimension value (empty string if absent)
 * @param medium      sessionMedium dimension value (empty string if absent)
 * @param campaign    sessionCampaignName dimension value (empty string if absent)
 * @param channel     sessionDefaultChannelGroup dimension value (empty string if absent)
 * @param device      deviceCategory dimension value (empty string if absent)
 * @param country     country dimension value (empty string if absent)
 */
export function uuidV5FromGa4Row(
  brandId: string,
  propertyId: string,
  date: string,
  source: string,
  medium: string,
  campaign: string,
  channel: string,
  device: string,
  country: string,
): string {
  return hashToUuidShaped(
    `${brandId}:ga4:${propertyId}:${date}:${source}:${medium}:${campaign}:${channel}:${device}:${country}:ga4.session.v1`,
  );
}

// ── Core mapper ───────────────────────────────────────────────────────────────

/**
 * Map one flattened GA4 runReport row to a Ga4MappedEvent (ga4.session.v1).
 *
 * Invariants:
 *   1. Field allowlist enforced (I-S02) — only GA4_SESSION_FIELD_ALLOWLIST fields survive.
 *   2. totalRevenue major-decimal → revenue_minor BIGINT-as-string (I-S07, no parseFloat).
 *   3. Sampling metadata stamped when present (is_sampled / samples_read_count / sampling_space_size).
 *   4. brand_id is NOT in the output properties — it travels on the CanonicalProvenance wrapper.
 *   5. property_id is the GA4 property identifier supplied by the caller (not a brand id).
 *   6. occurred_at = UTC midnight of the report date (economics time of the fact).
 *
 * @param row          Flattened GA4 runReport row (keyed by dimension/metric name).
 * @param propertyId   GA4 property id (e.g. '123456789') — from the connector record, not the row.
 * @param currencyCode ISO-4217 currency code — from the connector / account config.
 * @param sampling     Optional sampling metadata from the runReport response level.
 */
export function mapGa4RowToEvent(
  row: Ga4ReportRow,
  propertyId: string,
  currencyCode: string,
  sampling?: Ga4RunReportSampling | null,
): Ga4MappedEvent {
  const date = (row.date ?? '').trim();
  const occurredAt = date ? new Date(`${date}T00:00:00.000Z`).toISOString() : new Date().toISOString();

  const isSampled = sampling != null &&
    (sampling.samplesReadCount != null || sampling.samplingSpaceSize != null);

  const props: Ga4SessionProperties = {
    source: 'ga4',
    property_id: propertyId.trim(),
    date,
    session_source: row.sessionSource != null ? String(row.sessionSource) : null,
    session_medium: row.sessionMedium != null ? String(row.sessionMedium) : null,
    session_campaign_name: row.sessionCampaignName != null ? String(row.sessionCampaignName) : null,
    session_default_channel_group: row.sessionDefaultChannelGroup != null ? String(row.sessionDefaultChannelGroup) : null,
    device_category: row.deviceCategory != null ? String(row.deviceCategory) : null,
    country: row.country != null ? String(row.country) : null,
    sessions: toCountString(row.sessions),
    engaged_sessions: toCountString(row.engagedSessions),
    bounces: resolveBounces(row),
    total_users: toCountString(row.totalUsers),
    new_users: toCountString(row.newUsers),
    screen_page_views: toCountString(row.screenPageViews),
    event_count: toCountString(row.eventCount),
    conversions: toCountString(row.conversions),
    revenue_minor: majorDecimalToMinorString(row.totalRevenue),
    currency_code: currencyCode.trim().toUpperCase(),
    is_sampled: isSampled,
    samples_read_count: isSampled ? (sampling?.samplesReadCount ?? null) : null,
    sampling_space_size: isSampled ? (sampling?.samplingSpaceSize ?? null) : null,
    occurred_at: occurredAt,
  };

  return {
    event_name: GA4_SESSION_EVENT_NAME,
    occurred_at: occurredAt,
    properties: props,
  };
}
