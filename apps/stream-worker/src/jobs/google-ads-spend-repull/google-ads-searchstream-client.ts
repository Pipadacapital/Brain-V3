/**
 * google-ads-searchstream-client.ts — Google Ads API SearchStream client (ADR-AD-3 / ADR-AD-7).
 *
 * Mirrors razorpay-settlements-client.ts: streamed, throttle-aware.
 *   - Auth: OAuth refresh_token → short-lived access_token exchange at run start;
 *     developer-token header. Tokens NEVER logged (I-S09).
 *   - Google Ads API pinned to v24 (verified current base-URL May/Jun-2026).
 *   - GoogleAdsService.SearchStream: 1 query = 1 op. GAQL over campaign / ad_group /
 *     ad_group_ad with metrics.cost_micros, metrics.conversions, metrics.all_conversions,
 *     segments.date (ADR-AD-8).
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

/** Daily ops-quota exhausted (ADR-AD-7) — caller marks RateLimited + aborts run. */
export const GOOGLE_RESOURCE_EXHAUSTED = 'GOOGLE_RESOURCE_EXHAUSTED';
/** Per-CID/token QPS bucket exhausted (ADR-AD-7) — bounded backoff then continue. */
export const GOOGLE_RESOURCE_TEMPORARILY_EXHAUSTED = 'GOOGLE_RESOURCE_TEMPORARILY_EXHAUSTED';
/** Non-retryable auth failure (refresh token revoked / invalid). */
export const GOOGLE_AUTH_ERROR = 'GOOGLE_AUTH_ERROR';

export interface GoogleAdsCredentials {
  refreshToken: string;     // NEVER logged (I-S09)
  clientId: string;         // OAuth client — NEVER logged
  clientSecret: string;     // OAuth secret — NEVER logged
  developerToken: string;   // approved developer token — NEVER logged
  customerId: string;       // CID (digits only, no dashes)
  loginCustomerId?: string; // MCC login CID (optional)
}

/** Flattened Google Ads row (the mapper maps to canonical). */
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
  segments_date?: string | null;
  currency_code?: string | null;
  [key: string]: unknown;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Map the canonical level to the GAQL FROM resource + the id field projections. */
const LEVEL_QUERIES: Record<'campaign' | 'adset' | 'ad', string> = {
  campaign: `
    SELECT campaign.id, campaign.name, metrics.cost_micros, metrics.impressions,
           metrics.clicks, metrics.conversions, metrics.all_conversions,
           segments.date, customer.currency_code
    FROM campaign
    WHERE segments.date BETWEEN '{FROM}' AND '{TO}'`,
  adset: `
    SELECT campaign.id, campaign.name, ad_group.id, metrics.cost_micros, metrics.impressions,
           metrics.clicks, metrics.conversions, metrics.all_conversions,
           segments.date, customer.currency_code
    FROM ad_group
    WHERE segments.date BETWEEN '{FROM}' AND '{TO}'`,
  ad: `
    SELECT campaign.id, campaign.name, ad_group.id, ad_group_ad.ad.id, metrics.cost_micros,
           metrics.impressions, metrics.clicks, metrics.conversions, metrics.all_conversions,
           segments.date, customer.currency_code
    FROM ad_group_ad
    WHERE segments.date BETWEEN '{FROM}' AND '{TO}'`,
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
  }

  /** Exchange the refresh_token for a short-lived access_token (run start). NEVER logs tokens. */
  async authenticate(): Promise<void> {
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
   * POST a SearchStream query with the QPS cap + the two-error throttle branch (ADR-AD-7).
   * NEVER logs tokens or the response body (I-S09 / C5).
   */
  private async postWithThrottle(
    url: string,
    body: string,
  ): Promise<Array<{ results?: GoogleRawResult[] }>> {
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

      const res = await fetch(url, { method: 'POST', headers, body });

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

      // Error envelope: { error: { status, details:[{ errors:[{ errorCode:{ quotaError }}]}] } }
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
        console.info(
          `[google-ads-client] QPS throttled — backoff ${backoffMs}ms (attempt ${attempt + 1}/${this.maxBackoffRetries})`,
        );
        await sleep(backoffMs);
        continue;
      }

      // Any other error: hard fail (no body logged — C5).
      throw new Error(`[google-ads-client] HTTP ${res.status} from Google Ads SearchStream`);
    }
    throw new Error(`${GOOGLE_RESOURCE_TEMPORARILY_EXHAUSTED}: exceeded backoff retries`);
  }
}

// ── Error classification (ADR-AD-7 two-error branch) ─────────────────────────

interface GoogleErrorBody {
  error?: {
    status?: string;
    details?: Array<{ errors?: Array<{ errorCode?: { quotaError?: string } }> }>;
  };
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
): 'DAILY' | 'QPS' | 'OTHER' {
  const status = body.error?.status;
  const quotaErrors = (body.error?.details ?? [])
    .flatMap((d) => d.errors ?? [])
    .map((e) => e.errorCode?.quotaError)
    .filter((q): q is string => !!q);

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
  campaign?: { id?: string; name?: string };
  adGroup?: { id?: string };
  adGroupAd?: { ad?: { id?: string } };
  metrics?: {
    costMicros?: string;
    impressions?: string;
    clicks?: string;
    conversions?: number | string;
    allConversions?: number | string;
  };
  segments?: { date?: string };
  customer?: { currencyCode?: string };
}

function flattenGoogleRow(
  r: GoogleRawResult,
  level: 'campaign' | 'adset' | 'ad',
): GoogleAdsRawRow {
  return {
    level: level === 'adset' ? 'ad_group' : level,
    campaign_id: r.campaign?.id ?? null,
    campaign_name: r.campaign?.name ?? null,
    ad_group_id: r.adGroup?.id ?? null,
    ad_id: r.adGroupAd?.ad?.id ?? null,
    cost_micros: r.metrics?.costMicros != null ? String(r.metrics.costMicros) : null,
    impressions: r.metrics?.impressions != null ? String(r.metrics.impressions) : null,
    clicks: r.metrics?.clicks != null ? String(r.metrics.clicks) : null,
    conversions: r.metrics?.conversions != null ? String(r.metrics.conversions) : null,
    all_conversions: r.metrics?.allConversions != null ? String(r.metrics.allConversions) : null,
    segments_date: r.segments?.date ?? null,
    currency_code: r.customer?.currencyCode ?? null,
  };
}
