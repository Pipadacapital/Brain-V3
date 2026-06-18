/**
 * meta-insights-client.ts — Meta (Facebook) Ads Insights API client (ADR-AD-3 / ADR-AD-7).
 *
 * Mirrors razorpay-settlements-client.ts: paged, rate-limit-aware.
 *   - Auth: OAuth access_token (Bearer) — NEVER logged (I-S09).
 *   - Graph API pinned to v25.0 (verified current Feb-2026; resolve latest-stable at build).
 *   - Rate limit (ADR-AD-7): Meta returns the X-Business-Use-Case-Usage header and
 *     error codes 17 / 80004 on throttle → bounded backoff. Persistent throttle surfaces
 *     as RateLimited (the caller marks health_state + aborts the run).
 *   - NEVER logs the access_token or the raw response body (I-S09 / C5).
 *
 * Endpoint: GET /v25.0/act_{ad_account_id}/insights
 *   level={campaign|adset|ad}, time_increment=1 (daily rows), time_range={since,until},
 *   fields=spend,impressions,clicks,actions,campaign_id,campaign_name,adset_id,ad_id
 *
 * Pagination: Graph API cursor pagination via paging.next (a full URL). Iterate until absent.
 *
 * Spend is returned as an account-currency MAJOR-unit decimal string — the mapper converts
 * to BIGINT minor units (I-S07). currency comes from the account, not the row.
 */

const GRAPH_API_VERSION = 'v25.0';
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

/** Thrown when Meta signals a non-retryable auth failure (token expired/revoked). */
export const META_AUTH_ERROR = 'META_AUTH_ERROR';
/** Thrown when Meta throttles persistently — caller marks RateLimited + aborts run (ADR-AD-7). */
export const META_RATE_LIMITED = 'META_RATE_LIMITED';

export interface MetaApiCredentials {
  accessToken: string;   // NEVER logged (I-S09)
  adAccountId: string;   // act_ prefix added internally if absent
}

/** One daily insights row (raw — mapper applies the allowlist). */
export interface MetaInsightsRawRow {
  level?: string | null;
  campaign_id?: string | null;
  campaign_name?: string | null;
  adset_id?: string | null;
  ad_id?: string | null;
  spend?: string | null;       // MAJOR-unit decimal string
  impressions?: string | null;
  clicks?: string | null;
  date_start?: string | null;  // YYYY-MM-DD
  actions?: unknown;
  [key: string]: unknown;
}

export interface MetaInsightsPage {
  rows: MetaInsightsRawRow[];
  /** Full URL of the next page (Graph cursor pagination), or null when exhausted. */
  nextUrl: string | null;
}

/** Account-level metadata (currency + timezone) — fetched once per run. */
export interface MetaAccountMeta {
  currencyCode: string;
  timezoneName: string | null;
}

const INSIGHTS_FIELDS = [
  'campaign_id',
  'campaign_name',
  'adset_id',
  'ad_id',
  'spend',
  'impressions',
  'clicks',
  'actions',
].join(',');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeAccountId(adAccountId: string): string {
  const id = adAccountId.trim();
  return id.startsWith('act_') ? id : `act_${id}`;
}

export class MetaInsightsClient {
  private readonly accessToken: string;
  private readonly actId: string;
  private readonly maxBackoffRetries: number;

  /**
   * @param creds  access_token + ad_account_id — token NEVER logged (I-S09)
   * @param maxBackoffRetries  bounded backoff cap on throttle (ADR-AD-7, default 5)
   */
  constructor(creds: MetaApiCredentials, maxBackoffRetries = 5) {
    this.accessToken = creds.accessToken; // stays in memory; never logged
    this.actId = normalizeAccountId(creds.adAccountId);
    this.maxBackoffRetries = maxBackoffRetries;
  }

  /** Fetch account currency + timezone once (currency authority is the account, not the row). */
  async fetchAccountMeta(): Promise<MetaAccountMeta> {
    const url = `${GRAPH_API_BASE}/${this.actId}?fields=currency,timezone_name`;
    const body = (await this.getJson(url)) as { currency?: string; timezone_name?: string };
    return {
      currencyCode: (body.currency ?? 'USD').trim().toUpperCase(),
      timezoneName: body.timezone_name ?? null,
    };
  }

  /**
   * Fetch the first page of daily insights for a level over [since, until].
   * @param level   'campaign' | 'adset' | 'ad'
   * @param since   YYYY-MM-DD inclusive
   * @param until   YYYY-MM-DD inclusive
   */
  async fetchInsightsFirstPage(
    level: 'campaign' | 'adset' | 'ad',
    since: string,
    until: string,
  ): Promise<MetaInsightsPage> {
    const timeRange = encodeURIComponent(JSON.stringify({ since, until }));
    const url =
      `${GRAPH_API_BASE}/${this.actId}/insights` +
      `?level=${level}&time_increment=1&time_range=${timeRange}` +
      `&fields=${INSIGHTS_FIELDS}&limit=500`;
    return this.fetchInsightsByUrl(url, level);
  }

  /** Fetch a subsequent page by its cursor URL (from paging.next). */
  async fetchInsightsByUrl(
    url: string,
    level: 'campaign' | 'adset' | 'ad',
  ): Promise<MetaInsightsPage> {
    const body = (await this.getJson(url)) as {
      data?: MetaInsightsRawRow[];
      paging?: { next?: string };
    };
    const rows = (body.data ?? []).map((r) => ({ ...r, level }));
    return { rows, nextUrl: body.paging?.next ?? null };
  }

  /**
   * GET a Graph API URL with Bearer auth + bounded backoff on throttle (ADR-AD-7).
   * NEVER logs the token or the response body (I-S09 / C5).
   */
  private async getJson(url: string): Promise<unknown> {
    // The token rides the Authorization header (not the query string) so it never
    // lands in any logged/recorded URL (I-S09).
    for (let attempt = 0; attempt <= this.maxBackoffRetries; attempt++) {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
      });

      // 401/190 → token expired/revoked → non-retryable auth error.
      if (res.status === 401) {
        throw new Error(`${META_AUTH_ERROR}: 401 Unauthorized from Meta Insights`);
      }

      // Throttle branch (ADR-AD-7): code 17 (user request limit) / 80004 (ad account rate),
      // or HTTP 429. Bounded exponential backoff, then surface RateLimited.
      if (res.status === 429 || res.status === 400) {
        const errBody = await res.json().catch(() => ({} as Record<string, unknown>));
        const code = ((errBody as { error?: { code?: number } }).error?.code) ?? (res.status === 429 ? 17 : 0);
        if (res.status === 429 || code === 17 || code === 80004) {
          if (attempt >= this.maxBackoffRetries) {
            throw new Error(`${META_RATE_LIMITED}: persistent throttle (code=${code})`);
          }
          const backoffMs = Math.min(30_000, 1000 * 2 ** attempt);
          console.info(
            `[meta-insights-client] throttled (code=${code}) — backoff ${backoffMs}ms (attempt ${attempt + 1}/${this.maxBackoffRetries})`,
          );
          await sleep(backoffMs);
          continue;
        }
        // a 400 that is NOT a throttle → hard error (no body logged — C5)
        throw new Error(`[meta-insights-client] HTTP 400 (non-throttle) from Meta Insights`);
      }

      if (!res.ok) {
        throw new Error(`[meta-insights-client] HTTP ${res.status} from Meta Insights`);
      }

      return res.json();
    }
    throw new Error(`${META_RATE_LIMITED}: exceeded backoff retries`);
  }
}
