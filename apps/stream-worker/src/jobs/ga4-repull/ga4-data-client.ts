/**
 * ga4-data-client.ts — GA4 Data API (Analytics Reporting) runReport client.
 *
 * Mirrors google-ads-searchstream-client.ts: polling-aware, throttle-conscious.
 *
 *   - Auth: OAuth2 refresh_token → short-lived access_token (same flow as Google Ads);
 *     OR service-account JSON key → JWT-signed access_token.
 *     Tokens NEVER logged (I-S09).
 *   - GA4 Data API v1beta/v1 pinned to v1beta (the stable GA4 Reporting API endpoint).
 *   - API method: runReport (POST /properties/{propertyId}:runReport).
 *     GA4 has NO inbound webhooks — this is the ONLY data-fetch method.
 *   - Trailing-window re-pull: dateRanges[0] = {from, to} (passed by the caller).
 *   - QUOTA handling (GA4 Data API quotas are property-level tokens):
 *       RESOURCE_EXHAUSTED (429 / 503) → throw GA4_QUOTA_EXHAUSTED; caller marks RateLimited.
 *       UNAUTHENTICATED / PERMISSION_DENIED → throw GA4_AUTH_ERROR; caller marks token_expired.
 *   - SAMPLING: GA4 may return sampled data for high-cardinality requests. The client
 *     extracts samplingMetadatas and returns it alongside rows. The mapper stamps is_sampled.
 *   - NEVER logs tokens or raw response body (I-S09 / C5).
 *
 * Dimensions pulled per runReport call (session-grain, matching Ga4ReportRow):
 *   date, sessionSource, sessionMedium, sessionCampaignName,
 *   sessionDefaultChannelGroup, deviceCategory, country
 *
 * Metrics pulled:
 *   sessions, engagedSessions, bounces, totalUsers, newUsers,
 *   screenPageViews, eventCount, conversions, totalRevenue
 */

import type { Ga4ReportRow, Ga4RunReportSampling } from '@brain/ga4-mapper';
import { mintServiceAccountAccessToken, GOOGLE_SA_AUTH_ERROR } from '@brain/connector-core';
import { log } from '../../log.js';

// ── API constants ─────────────────────────────────────────────────────────────

const GA4_DATA_API_BASE = 'https://analyticsdata.googleapis.com/v1beta';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** Read-only Analytics scope — the only scope Brain requests for GA4 (least privilege). */
const GA4_ANALYTICS_READONLY_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';

const OAUTH_TIMEOUT_MS = 15_000;
const REPORT_TIMEOUT_MS = 60_000;

// ── Error sentinels ───────────────────────────────────────────────────────────

/** Property-level quota exhausted (daily token limit). Caller marks RateLimited + aborts run. */
export const GA4_QUOTA_EXHAUSTED = 'GA4_QUOTA_EXHAUSTED';
/** Non-retryable auth failure (refresh token revoked / wrong scope / PERMISSION_DENIED). */
export const GA4_AUTH_ERROR = 'GA4_AUTH_ERROR';

// ── Credential shape ──────────────────────────────────────────────────────────

export interface Ga4OAuthCredentials {
  readonly kind: 'oauth';
  readonly refreshToken: string;    // NEVER logged (I-S09)
  readonly clientId: string;        // OAuth client — NEVER logged
  readonly clientSecret: string;    // OAuth secret — NEVER logged
  readonly propertyId: string;      // GA4 property id (numeric string)
  /** ISO-4217 reporting currency of the property (from the connect form). Absent ⇒ USD. */
  readonly currencyCode?: string;
}

export interface Ga4ServiceAccountCredentials {
  readonly kind: 'service_account';
  /** The private key PEM string (from the service-account JSON key). NEVER logged. */
  readonly privateKeyPem: string;
  /** The service account email (client_email from the key JSON). */
  readonly clientEmail: string;
  readonly propertyId: string;
  /** ISO-4217 reporting currency of the property (from the connect form). Absent ⇒ USD. */
  readonly currencyCode?: string;
}

export type Ga4Credentials = Ga4OAuthCredentials | Ga4ServiceAccountCredentials;

// ── runReport response shape ──────────────────────────────────────────────────

interface Ga4RunReportResponse {
  dimensionHeaders?: Array<{ name?: string }>;
  metricHeaders?: Array<{ name?: string; type?: string }>;
  rows?: Array<{
    dimensionValues?: Array<{ value?: string }>;
    metricValues?: Array<{ value?: string }>;
  }>;
  samplingMetadatas?: Array<{
    samplesReadCount?: string;
    samplingSpaceSize?: string;
  }>;
  rowCount?: number;
  quotaConsumed?: unknown;
}

interface Ga4ErrorBody {
  error?: {
    code?: number;
    status?: string;
    message?: string;
  };
}

// ── Dimensions + metrics declared in order ────────────────────────────────────

const DIMENSIONS = [
  'date',
  'sessionSource',
  'sessionMedium',
  'sessionCampaignName',
  'sessionDefaultChannelGroup',
  'deviceCategory',
  'country',
] as const;

const METRICS = [
  'sessions',
  'engagedSessions',
  'bounces',
  'totalUsers',
  'newUsers',
  'screenPageViews',
  'eventCount',
  'conversions',
  'totalRevenue',
] as const;

// ── Client ────────────────────────────────────────────────────────────────────

export interface Ga4RunReportResult {
  rows: Ga4ReportRow[];
  sampling: Ga4RunReportSampling | null;
  rowCount: number;
}

export class Ga4DataClient {
  private accessToken: string | null = null;

  constructor(private readonly creds: Ga4Credentials) {}

  /**
   * Exchange the refresh_token (OAuth) or service-account key (RS256 JWT-bearer grant, via the
   * shared @brain/connector-core helper) for a short-lived access_token.
   * NEVER logs the token or the raw response (I-S09).
   */
  async authenticate(): Promise<void> {
    if (this.creds.kind === 'oauth') {
      await this.authenticateOAuth();
    } else {
      await this.authenticateServiceAccount();
    }
  }

  private async authenticateOAuth(): Promise<void> {
    const creds = this.creds as Ga4OAuthCredentials;
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: creds.refreshToken,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
    });

    const res = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
    });

    if (res.status === 400 || res.status === 401) {
      throw new Error(`${GA4_AUTH_ERROR}: OAuth token exchange failed (HTTP ${res.status})`);
    }
    if (!res.ok) {
      throw new Error(`[ga4-client] OAuth token exchange HTTP ${res.status}`);
    }

    const body = (await res.json()) as { access_token?: string };
    if (!body.access_token) {
      throw new Error(`${GA4_AUTH_ERROR}: no access_token in OAuth response`);
    }
    this.accessToken = body.access_token; // in memory only; never logged (I-S09)
  }

  private async authenticateServiceAccount(): Promise<void> {
    // Service-account JWT-bearer grant (RFC 7523): sign an RS256 assertion with the key's
    // private_key and exchange it at Google's token endpoint for a short-lived access token.
    // Implemented via the SHARED @brain/connector-core helper (the same one the core
    // HandleGa4ConnectCommand uses to validate the pasted key at connect time), so the
    // connect-time validation and the repull auth can never drift. NEVER logs the key/token.
    const creds = this.creds as Ga4ServiceAccountCredentials;
    if (!creds.privateKeyPem || !creds.clientEmail) {
      throw new Error(`${GA4_AUTH_ERROR}: service-account key missing privateKeyPem or clientEmail`);
    }
    try {
      const { accessToken } = await mintServiceAccountAccessToken({
        key: { clientEmail: creds.clientEmail, privateKeyPem: creds.privateKeyPem },
        scope: GA4_ANALYTICS_READONLY_SCOPE,
        tokenUrl: OAUTH_TOKEN_URL,
        timeoutMs: OAUTH_TIMEOUT_MS,
      });
      this.accessToken = accessToken; // in memory only; never logged (I-S09)
    } catch (err) {
      // Non-retryable SA auth rejection (bad PEM / rejected assertion) → the GA4 auth sentinel
      // so the caller marks token_expired / RECONNECT_REQUIRED, same as the OAuth path.
      if ((err as { code?: string }).code === GOOGLE_SA_AUTH_ERROR) {
        throw new Error(`${GA4_AUTH_ERROR}: ${(err as Error).message}`);
      }
      throw err; // transient (5xx/network) — retryable next run
    }
  }

  /**
   * Run a GA4 Data API report for the given date range.
   * Returns flattened rows and sampling metadata.
   *
   * @throws GA4_QUOTA_EXHAUSTED if the property-level daily token is exhausted.
   * @throws GA4_AUTH_ERROR if credentials are invalid / expired.
   */
  async runReport(fromDate: string, toDate: string): Promise<Ga4RunReportResult> {
    if (!this.accessToken) {
      throw new Error('[ga4-client] not authenticated — call authenticate() first');
    }

    const propertyId = this.creds.propertyId;
    const url = `${GA4_DATA_API_BASE}/properties/${propertyId}:runReport`;

    const body = JSON.stringify({
      dateRanges: [{ startDate: fromDate, endDate: toDate }],
      dimensions: DIMENSIONS.map((name) => ({ name })),
      metrics: METRICS.map((name) => ({ name })),
      // keepEmptyRows: false (default) — we only want rows with actual sessions
    });

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body,
      signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
    });

    if (res.status === 200) {
      const parsed = (await res.json()) as Ga4RunReportResponse;
      return this.parseReportResponse(parsed);
    }

    // Error handling — NEVER log raw response body (C5)
    const errBody = (await res.json().catch(() => ({}))) as Ga4ErrorBody;
    const status = errBody.error?.status ?? '';

    if (res.status === 401 || status === 'UNAUTHENTICATED') {
      throw new Error(`${GA4_AUTH_ERROR}: 401/UNAUTHENTICATED from GA4 Data API`);
    }
    if (res.status === 403 || status === 'PERMISSION_DENIED') {
      throw new Error(
        `${GA4_AUTH_ERROR}: 403/PERMISSION_DENIED — check analytics.readonly scope and property access`,
      );
    }
    if (res.status === 429 || res.status === 503 || status === 'RESOURCE_EXHAUSTED') {
      throw new Error(`${GA4_QUOTA_EXHAUSTED}: property-level daily quota exhausted (HTTP ${res.status})`);
    }

    throw new Error(`[ga4-client] GA4 Data API HTTP ${res.status}`);
  }

  /** Parse a runReport response into typed rows + sampling metadata. */
  private parseReportResponse(resp: Ga4RunReportResponse): Ga4RunReportResult {
    const dimHeaders = (resp.dimensionHeaders ?? []).map((h) => h.name ?? '');
    const metHeaders = (resp.metricHeaders ?? []).map((h) => h.name ?? '');

    const rows: Ga4ReportRow[] = [];
    for (const row of resp.rows ?? []) {
      const record: Record<string, string | null> = {};

      // Map dimension values by declaration order
      for (let i = 0; i < dimHeaders.length; i++) {
        const name = dimHeaders[i]!;
        record[name] = row.dimensionValues?.[i]?.value ?? null;
      }

      // Map metric values by declaration order
      for (let i = 0; i < metHeaders.length; i++) {
        const name = metHeaders[i]!;
        record[name] = row.metricValues?.[i]?.value ?? null;
      }

      rows.push(record as Ga4ReportRow);
    }

    // Extract first sampling metadata entry (one per date range)
    const sm = resp.samplingMetadatas?.[0];
    const sampling: Ga4RunReportSampling | null = sm
      ? { samplesReadCount: sm.samplesReadCount ?? null, samplingSpaceSize: sm.samplingSpaceSize ?? null }
      : null;

    if (sampling) {
      log.warn(`[ga4-client] GA4 report is SAMPLED: samplesRead=${sm?.samplesReadCount} space=${sm?.samplingSpaceSize}`);
    }

    return { rows, sampling, rowCount: resp.rowCount ?? rows.length };
  }
}
