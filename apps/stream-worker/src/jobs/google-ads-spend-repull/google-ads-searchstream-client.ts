import { log } from "../../log.js";
import { CircuitBreaker } from '@brain/observability';

/**
 * google-ads-searchstream-client.ts — Google Ads API SearchStream client (ADR-AD-3 / ADR-AD-7).
 *
 * Mirrors razorpay-settlements-client.ts: streamed, throttle-aware.
 *   - Auth: OAuth refresh_token → short-lived access_token exchange at run start;
 *     developer-token header. Tokens NEVER logged (I-S09).
 *   - Google Ads API pinned to v24 (verified current base-URL May/Jun-2026).
 *   - GoogleAdsService.SearchStream: 1 query = 1 op. GAQL over campaign / ad_group /
 *     ad_group_ad with the FULL insight set (A3): metrics.cost_micros, metrics.impressions,
 *     metrics.clicks, metrics.conversions, metrics.all_conversions, metrics.conversions_value
 *     (platform-attributed REVENUE — major-unit double → minor in the mapper),
 *     metrics.view_through_conversions, metrics.ctr, metrics.average_cpc, metrics.average_cpm
 *     (micros), campaign.advertising_channel_type, segments.date (ADR-AD-8).
 *     NOTE: segments.device / segments.ad_network_type are DELIBERATELY NOT selected — they
 *     would split each (campaign, date) row into N device/network rows that all collapse onto
 *     the SAME deterministic event_id (the A1 dedup grain has no segment component) → silent
 *     spend overwrite under the Bronze MERGE. Adding them requires widening uuidV5FromSpendRow
 *     in lockstep (A1/Admission-owned). Deferred to preserve "no event loss".
 *   - ENTITY METADATA (A3): a SEPARATE no-metrics GAQL pass (streamEntities) over campaign /
 *     ad_group / ad_group_ad reads .name/.status/.advertising_channel_type/.bidding_strategy_type
 *     for the entity-sync job → ad.entity.updated. Decoupled from spend volume.
 *   - THROTTLE BRANCH (ADR-AD-7, the two-error policy):
 *       RESOURCE_EXHAUSTED            (daily ops-quota) → throw GOOGLE_RESOURCE_EXHAUSTED;
 *                                       caller marks RateLimited + ABORTS the run (no in-run
 *                                       retry — the quota is daily).
 *       RESOURCE_TEMPORARILY_EXHAUSTED (per-CID/per-token QPS) → bounded exponential backoff
 *                                       (≤5 retries, ≤30s), then continue.
 *   - SELF-IMPOSED QPS CAP: token-bucket (default 1 req/s/CID) keeps us under the bucket.
 *   - NEVER logs tokens or the raw response body (I-S09 / C5).
 *
 * micros → minor units conversion is the MAPPER's job (I-S07). This client returns raw rows.
 */

const GOOGLE_ADS_API_VERSION = 'v24';
const GOOGLE_ADS_API_BASE = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}`;
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** T2-9: per-request timeouts — a hung Google socket aborts instead of stalling the spend re-pull.
 *  SearchStream streams batches and runs longer than a token exchange, so it gets a wider bound. */
const OAUTH_TIMEOUT_MS = 15_000;
const SEARCHSTREAM_TIMEOUT_MS = 60_000;

/** Daily ops-quota exhausted (ADR-AD-7) — caller marks RateLimited + aborts run. */
export const GOOGLE_RESOURCE_EXHAUSTED = 'GOOGLE_RESOURCE_EXHAUSTED';
/** Per-CID/token QPS bucket exhausted (ADR-AD-7) — bounded backoff then continue. */
export const GOOGLE_RESOURCE_TEMPORARILY_EXHAUSTED = 'GOOGLE_RESOURCE_TEMPORARILY_EXHAUSTED';
/** Non-retryable auth failure (refresh token revoked / invalid). */
export const GOOGLE_AUTH_ERROR = 'GOOGLE_AUTH_ERROR';
/**
 * The ad account itself is unusable — Google authorizationError CUSTOMER_NOT_ENABLED (account
 * deactivated / not yet enabled) or a customer-not-found. Distinct from GOOGLE_AUTH_ERROR (the
 * TOKEN is fine; the ACCOUNT is the problem). Caller marks the connector Disabled and backs off —
 * retrying a disabled account every tick just 403-loops (the original prod symptom).
 */
export const GOOGLE_ACCOUNT_DISABLED = 'GOOGLE_ACCOUNT_DISABLED';

export interface GoogleAdsCredentials {
  refreshToken: string;     // NEVER logged (I-S09)
  clientId: string;         // OAuth client — NEVER logged
  clientSecret: string;     // OAuth secret — NEVER logged
  developerToken: string;   // approved developer token — NEVER logged
  customerId: string;       // CID (digits only, no dashes)
  loginCustomerId?: string; // MCC login CID (optional)
}

/** Flattened Google Ads row (the mapper maps to canonical). Field names match @brain/ad-spend-mapper GoogleAdsRow. */
export interface GoogleAdsRawRow {
  level?: string | null;
  campaign_id?: string | null;
  campaign_name?: string | null;
  ad_group_id?: string | null;
  ad_id?: string | null;
  cost_micros?: string | null;   // integer micros
  impressions?: string | null;
  clicks?: string | null;
  conversions?: string | null;       // RAW (ADR-AD-8)
  all_conversions?: string | null;    // RAW (ADR-AD-8)
  // ── A3 full insight set (additive; the mapper folds these). conversions_value is a MAJOR-unit
  //    double (account currency) → minor in the mapper; average_cpc/cpm are integer MICROS → minor.
  conversions_value?: string | null;       // platform-attributed REVENUE (major-unit double)
  view_through_conversions?: string | null; // count
  ctr?: string | null;                       // click-through ratio (double)
  average_cpc?: string | null;               // integer MICROS cost-per-click
  average_cpm?: string | null;               // integer MICROS cost-per-mille
  advertising_channel_type?: string | null;  // SEARCH | DISPLAY | VIDEO | …
  segments_date?: string | null;
  currency_code?: string | null;
  [key: string]: unknown;
}

/**
 * Flattened Google Ads ENTITY-metadata row (A3 entity-sync). NO money/metrics — authoritative
 * latest name/status/channel/bidding, decoupled from spend volume. The job maps this to the
 * canonical `ad.entity.updated` payload (shape MUST match Meta's entity-sync output).
 */
export interface GoogleAdsEntityRow {
  level: 'campaign' | 'adset' | 'ad';
  entity_id: string | null;
  campaign_id: string | null;
  parent_id: string | null;
  name: string | null;
  status: string | null;
  advertising_channel_type: string | null; // campaign only
  bidding_strategy: string | null;          // campaign only (bidding_strategy_type)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Map the canonical level to the GAQL FROM resource + the id field projections.
 * A3: widened to the full grain-SAFE insight set (conversions_value/view_through/ctr/average_cpc/
 * average_cpm/advertising_channel_type). segments.device/ad_network_type are intentionally absent —
 * they would split rows under the unchanged dedup grain (see the file header / no-event-loss).
 */
const SPEND_METRICS = `metrics.cost_micros, metrics.impressions, metrics.clicks,
           metrics.conversions, metrics.all_conversions, metrics.conversions_value,
           metrics.view_through_conversions, metrics.ctr, metrics.average_cpc, metrics.average_cpm`;
const LEVEL_QUERIES: Record<'campaign' | 'adset' | 'ad', string> = {
  campaign: `
    SELECT campaign.id, campaign.name, campaign.advertising_channel_type, ${SPEND_METRICS},
           segments.date, customer.currency_code
    FROM campaign
    WHERE segments.date BETWEEN '{FROM}' AND '{TO}'`,
  adset: `
    SELECT campaign.id, campaign.name, campaign.advertising_channel_type, ad_group.id, ${SPEND_METRICS},
           segments.date, customer.currency_code
    FROM ad_group
    WHERE segments.date BETWEEN '{FROM}' AND '{TO}'`,
  ad: `
    SELECT campaign.id, campaign.name, campaign.advertising_channel_type, ad_group.id,
           ad_group_ad.ad.id, ${SPEND_METRICS},
           segments.date, customer.currency_code
    FROM ad_group_ad
    WHERE segments.date BETWEEN '{FROM}' AND '{TO}'`,
};

/**
 * Entity-metadata GAQL (A3 entity-sync) — NO metrics, NO date segment (it's a slowly-changing
 * dimension, not a time series). Authoritative latest name/status/channel/bidding per entity.
 * status filters exclude REMOVED so dead entities don't churn the dim every cycle, but the
 * Spark dim still derives is_active from whatever status DOES arrive.
 */
const ENTITY_QUERIES: Record<'campaign' | 'adset' | 'ad', string> = {
  campaign: `
    SELECT campaign.id, campaign.name, campaign.status,
           campaign.advertising_channel_type, campaign.bidding_strategy_type
    FROM campaign
    WHERE campaign.status != 'REMOVED'`,
  adset: `
    SELECT campaign.id, ad_group.id, ad_group.name, ad_group.status
    FROM ad_group
    WHERE ad_group.status != 'REMOVED'`,
  ad: `
    SELECT campaign.id, ad_group.id, ad_group_ad.ad.id,
           ad_group_ad.ad.name, ad_group_ad.status
    FROM ad_group_ad
    WHERE ad_group_ad.status != 'REMOVED'`,
};

/** Minimal token-bucket QPS limiter (ADR-AD-7 self-imposed cap). */
class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  constructor(private readonly ratePerSec: number, private readonly capacity = 1) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }
  async take(): Promise<void> {
    while (true) {
      const now = Date.now();
      const elapsedSec = (now - this.lastRefill) / 1000;
      this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.ratePerSec);
      this.lastRefill = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = Math.ceil(((1 - this.tokens) / this.ratePerSec) * 1000);
      await sleep(waitMs);
    }
  }
}

export class GoogleAdsSearchStreamClient {
  private accessToken: string | null = null;
  private readonly bucket: TokenBucket;
  private readonly breaker: CircuitBreaker;

  /**
   * @param creds            refresh_token + client + developer-token + CID — NEVER logged
   * @param qpsPerCid        self-imposed QPS cap (ADR-AD-7, default 1 rps/CID)
   * @param maxBackoffRetries bounded backoff cap on QPS exhaustion (default 5)
   */
  constructor(
    private readonly creds: GoogleAdsCredentials,
    qpsPerCid = 1,
    private readonly maxBackoffRetries = 5,
  ) {
    this.bucket = new TokenBucket(qpsPerCid);
    this.breaker = new CircuitBreaker({ name: 'google-ads', failureThreshold: 5, openMs: 60_000 });
  }

  /** Exchange the refresh_token for a short-lived access_token (run start). NEVER logs tokens. */
  async authenticate(): Promise<void> {
    await this.breaker.fire(async () => {
      const params = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.creds.refreshToken,
        client_id: this.creds.clientId,
        client_secret: this.creds.clientSecret,
      });
      const res = await fetch(OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
        signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
      });
      if (res.status === 400 || res.status === 401) {
        throw new Error(`${GOOGLE_AUTH_ERROR}: token exchange failed (HTTP ${res.status})`);
      }
      if (!res.ok) {
        throw new Error(`[google-ads-client] token exchange HTTP ${res.status}`);
      }
      const body = (await res.json()) as { access_token?: string };
      if (!body.access_token) {
        throw new Error(`${GOOGLE_AUTH_ERROR}: no access_token in exchange response`);
      }
      this.accessToken = body.access_token; // in memory only; never logged
    });
  }

  /**
   * Stream all rows for a level over [from, to] (inclusive YYYY-MM-DD).
   * SearchStream returns NDJSON-ish chunked results; we parse the full body
   * (Google returns an array of result batches). 1 query = 1 op.
   */
  async streamLevel(
    level: 'campaign' | 'adset' | 'ad',
    from: string,
    to: string,
  ): Promise<GoogleAdsRawRow[]> {
    if (!this.accessToken) {
      throw new Error('[google-ads-client] not authenticated — call authenticate() first');
    }
    const query = LEVEL_QUERIES[level].replace('{FROM}', from).replace('{TO}', to);
    const url = `${GOOGLE_ADS_API_BASE}/customers/${this.creds.customerId}/googleAds:searchStream`;

    const batches = await this.postWithThrottle(url, JSON.stringify({ query }));
    const rows: GoogleAdsRawRow[] = [];
    // SearchStream responds with an array of { results: [...] } batches.
    for (const batch of batches) {
      for (const r of batch.results ?? []) {
        rows.push(flattenGoogleRow(r, level));
      }
    }
    return rows;
  }

  /**
   * Stream ENTITY-metadata rows for a level (A3 entity-sync). NO metrics / NO date window —
   * the latest name/status/channel/bidding for each campaign / ad_group / ad. 1 query = 1 op,
   * same QPS bucket + two-error throttle branch as spend.
   */
  async streamEntities(level: 'campaign' | 'adset' | 'ad'): Promise<GoogleAdsEntityRow[]> {
    if (!this.accessToken) {
      throw new Error('[google-ads-client] not authenticated — call authenticate() first');
    }
    const query = ENTITY_QUERIES[level];
    const url = `${GOOGLE_ADS_API_BASE}/customers/${this.creds.customerId}/googleAds:searchStream`;
    const batches = await this.postWithThrottle(url, JSON.stringify({ query }));
    const rows: GoogleAdsEntityRow[] = [];
    for (const batch of batches) {
      for (const r of batch.results ?? []) {
        rows.push(flattenEntityRow(r, level));
      }
    }
    return rows;
  }

  /**
   * POST a SearchStream query with the QPS cap + the two-error throttle branch (ADR-AD-7).
   * NEVER logs tokens or the response body (I-S09 / C5).
   */
  private async postWithThrottle(
    url: string,
    body: string,
  ): Promise<Array<{ results?: GoogleRawResult[] }>> {
    return this.breaker.fire(async () => {
    for (let attempt = 0; attempt <= this.maxBackoffRetries; attempt++) {
      await this.bucket.take(); // self-imposed QPS cap (ADR-AD-7)

      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.accessToken}`,
        'developer-token': this.creds.developerToken,
        'Content-Type': 'application/json',
      };
      if (this.creds.loginCustomerId) {
        headers['login-customer-id'] = this.creds.loginCustomerId;
      }

      const res = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(SEARCHSTREAM_TIMEOUT_MS),
      });

      if (res.status === 200) {
        // SearchStream may return an array of batches.
        const parsed = (await res.json()) as
          | Array<{ results?: GoogleRawResult[] }>
          | { results?: GoogleRawResult[] };
        return Array.isArray(parsed) ? parsed : [parsed];
      }

      if (res.status === 401) {
        throw new Error(`${GOOGLE_AUTH_ERROR}: 401 Unauthorized from Google Ads`);
      }

      // Error envelope: { error: { status, message, details:[{ errors:[{ errorCode:{...}, message }]}] } }
      const errBody = (await res.json().catch(() => ({}))) as GoogleErrorBody;
      const kind = classifyGoogleError(errBody, res.status);

      if (kind === 'DAILY') {
        // RESOURCE_EXHAUSTED — daily ops-quota. NO in-run retry (ADR-AD-7). Abort the run.
        throw new Error(`${GOOGLE_RESOURCE_EXHAUSTED}: daily ops-quota exhausted`);
      }

      if (kind === 'QPS') {
        // RESOURCE_TEMPORARILY_EXHAUSTED — per-CID/token QPS. Bounded backoff, then continue.
        if (attempt >= this.maxBackoffRetries) {
          throw new Error(
            `${GOOGLE_RESOURCE_TEMPORARILY_EXHAUSTED}: QPS backoff retries exhausted`,
          );
        }
        const backoffMs = Math.min(30_000, 1000 * 2 ** attempt);
        log.info(`QPS throttled — backoff ${backoffMs}ms (attempt ${attempt + 1}/${this.maxBackoffRetries})`);
        await sleep(backoffMs);
        continue;
      }

      // Surface the REAL reason instead of a bare "HTTP 403". The GoogleAdsFailure errorCode +
      // message are API-level diagnostics (no tokens / no tenant row data), safe to log per C5 —
      // unlike the raw body. This is the production-observability fix: a 403 must say WHY.
      const detail = extractGoogleErrorDetail(errBody);
      const detailSuffix = detail.code
        ? ` code=${detail.code}${detail.message ? ` msg="${detail.message}"` : ''}`
        : '';

      if (kind === 'ACCOUNT_DISABLED') {
        // The ACCOUNT is unusable (CUSTOMER_NOT_ENABLED / not found). Token is fine; do NOT retry —
        // the caller marks the connector Disabled and stops hammering a dead account.
        log.warn(`[google-ads-client] ad account unusable (HTTP ${res.status})${detailSuffix} — RECONNECT/RE-ENABLE required`);
        throw new Error(`${GOOGLE_ACCOUNT_DISABLED}: ${detail.code ?? 'CUSTOMER_NOT_ENABLED'}`);
      }

      // Any other error: hard fail, but now WITH the parsed reason (C5-safe; never the raw body).
      log.error(`[google-ads-client] HTTP ${res.status} from Google Ads SearchStream${detailSuffix}`);
      throw new Error(`[google-ads-client] HTTP ${res.status} from Google Ads SearchStream${detail.code ? ` (${detail.code})` : ''}`);
    }
    throw new Error(`${GOOGLE_RESOURCE_TEMPORARILY_EXHAUSTED}: exceeded backoff retries`);
    }); // end breaker.fire
  }
}

// ── Error classification (ADR-AD-7 two-error branch) ─────────────────────────

interface GoogleAdsError {
  errorCode?: Record<string, string | undefined>;
  message?: string;
}
interface GoogleErrorBody {
  error?: {
    status?: string;
    message?: string;
    details?: Array<{ errors?: GoogleAdsError[] }>;
  };
}

/** authorizationError values (and an authenticationError) that mean the ACCOUNT is unusable. */
const ACCOUNT_DISABLED_CODES = new Set([
  'CUSTOMER_NOT_ENABLED',          // account deactivated / not yet enabled (the prod symptom)
  'CUSTOMER_NOT_FOUND',
  'USER_PERMISSION_DENIED',        // the (login) user can't access this customer at all
]);

/** Flatten the first Google Ads error to a { code, message } for safe logging (no raw body / token). */
export function extractGoogleErrorDetail(body: GoogleErrorBody): { code: string | null; message: string | null } {
  const first = (body.error?.details ?? []).flatMap((d) => d.errors ?? [])[0];
  // errorCode is a one-key object like { authorizationError: 'CUSTOMER_NOT_ENABLED' } — take its value.
  const code =
    (first?.errorCode ? Object.values(first.errorCode).find((v): v is string => !!v) : undefined) ?? null;
  const message = first?.message ?? body.error?.message ?? null;
  return { code, message };
}

/**
 * Classify a Google Ads error envelope into the two throttle branches (ADR-AD-7).
 * Exported for unit testing of the error mapping.
 *   'DAILY' → RESOURCE_EXHAUSTED  (daily ops-quota)  → abort run
 *   'QPS'   → RESOURCE_TEMPORARILY_EXHAUSTED (QPS)    → bounded backoff
 *   'OTHER' → anything else
 */
export function classifyGoogleError(
  body: GoogleErrorBody,
  httpStatus: number,
): 'DAILY' | 'QPS' | 'ACCOUNT_DISABLED' | 'OTHER' {
  const status = body.error?.status;
  const allErrors = (body.error?.details ?? []).flatMap((d) => d.errors ?? []);
  const quotaErrors = allErrors
    .map((e) => e.errorCode?.quotaError)
    .filter((q): q is string => !!q);

  // ACCOUNT_DISABLED is the most specific + terminal branch (CUSTOMER_NOT_ENABLED etc.). It carries
  // NO quotaError, so it never shadows the quota branches below — but we check it first so a 403 on a
  // dead account is classified terminal (caller backs off) instead of falling through to OTHER.
  const anyDisabledCode = allErrors.some((e) =>
    Object.values(e.errorCode ?? {}).some((v) => v && ACCOUNT_DISABLED_CODES.has(v)),
  );
  if (anyDisabledCode) {
    return 'ACCOUNT_DISABLED';
  }

  // Q-CURSOR (ADR-AD-7): the quotaError field is the authoritative discriminator,
  // and precedence matters. A QPS throttle arrives inside a gRPC RESOURCE_EXHAUSTED
  // envelope (status===RESOURCE_EXHAUSTED) AND HTTP 429 — but carries the explicit
  // RESOURCE_TEMPORARILY_EXHAUSTED quotaError, which means bounded-backoff, NOT a
  // daily abort. So:
  //   1. explicit TEMPORARILY quotaError → QPS  (wins over the RESOURCE_EXHAUSTED status)
  //   2. explicit RESOURCE_EXHAUSTED (status or quotaError) → DAILY (abort run)
  //   3. bare 429 with no quota detail → QPS (transient; backoff, never abort)
  // If step 3 ran before step 2 a daily-quota error (which is ALSO 429) would be
  // mis-read as QPS; if step 1 ran after step 2 a QPS burst would abort the whole
  // day's spend repull → silent missed spend / corrupted ROAS. Do not reorder.
  if (quotaErrors.includes('RESOURCE_TEMPORARILY_EXHAUSTED')) {
    return 'QPS';
  }
  if (status === 'RESOURCE_EXHAUSTED' || quotaErrors.includes('RESOURCE_EXHAUSTED')) {
    return 'DAILY';
  }
  if (httpStatus === 429) {
    return 'QPS';
  }
  return 'OTHER';
}

// ── Row flattening ────────────────────────────────────────────────────────────

interface GoogleRawResult {
  campaign?: { id?: string; name?: string; advertisingChannelType?: string; status?: string; biddingStrategyType?: string };
  adGroup?: { id?: string; name?: string; status?: string };
  adGroupAd?: { ad?: { id?: string; name?: string }; status?: string };
  metrics?: {
    costMicros?: string;
    impressions?: string;
    clicks?: string;
    conversions?: number | string;
    allConversions?: number | string;
    conversionsValue?: number | string;
    viewThroughConversions?: number | string;
    ctr?: number | string;
    averageCpc?: number | string;
    averageCpm?: number | string;
  };
  segments?: { date?: string };
  customer?: { currencyCode?: string };
}

function flattenGoogleRow(
  r: GoogleRawResult,
  level: 'campaign' | 'adset' | 'ad',
): GoogleAdsRawRow {
  const m = r.metrics;
  return {
    level: level === 'adset' ? 'ad_group' : level,
    campaign_id: r.campaign?.id ?? null,
    campaign_name: r.campaign?.name ?? null,
    ad_group_id: r.adGroup?.id ?? null,
    ad_id: r.adGroupAd?.ad?.id ?? null,
    cost_micros: m?.costMicros != null ? String(m.costMicros) : null,
    impressions: m?.impressions != null ? String(m.impressions) : null,
    clicks: m?.clicks != null ? String(m.clicks) : null,
    conversions: m?.conversions != null ? String(m.conversions) : null,
    all_conversions: m?.allConversions != null ? String(m.allConversions) : null,
    // A3 enriched: major-unit double revenue + counts + ratios + micros — the mapper folds them.
    conversions_value: m?.conversionsValue != null ? String(m.conversionsValue) : null,
    view_through_conversions: m?.viewThroughConversions != null ? String(m.viewThroughConversions) : null,
    ctr: m?.ctr != null ? String(m.ctr) : null,
    average_cpc: m?.averageCpc != null ? String(m.averageCpc) : null,
    average_cpm: m?.averageCpm != null ? String(m.averageCpm) : null,
    advertising_channel_type: r.campaign?.advertisingChannelType ?? null,
    segments_date: r.segments?.date ?? null,
    currency_code: r.customer?.currencyCode ?? null,
  };
}

/** Flatten an entity-metadata GAQL result row → GoogleAdsEntityRow (A3 entity-sync). */
function flattenEntityRow(
  r: GoogleRawResult,
  level: 'campaign' | 'adset' | 'ad',
): GoogleAdsEntityRow {
  const campaignId = r.campaign?.id ?? null;
  if (level === 'campaign') {
    return {
      level,
      entity_id: campaignId,
      campaign_id: campaignId,
      parent_id: null, // a campaign is its own root
      name: r.campaign?.name ?? null,
      status: r.campaign?.status ?? null,
      advertising_channel_type: r.campaign?.advertisingChannelType ?? null,
      bidding_strategy: r.campaign?.biddingStrategyType ?? null,
    };
  }
  if (level === 'adset') {
    return {
      level,
      entity_id: r.adGroup?.id ?? null,
      campaign_id: campaignId,
      parent_id: campaignId, // ad_group → parent campaign
      name: r.adGroup?.name ?? null,
      status: r.adGroup?.status ?? null,
      advertising_channel_type: null,
      bidding_strategy: null,
    };
  }
  return {
    level,
    entity_id: r.adGroupAd?.ad?.id ?? null,
    campaign_id: campaignId,
    parent_id: r.adGroup?.id ?? null, // ad → parent ad_group
    name: r.adGroupAd?.ad?.name ?? null,
    status: r.adGroupAd?.status ?? null,
    advertising_channel_type: null,
    bidding_strategy: null,
  };
}
