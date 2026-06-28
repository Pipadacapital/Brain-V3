import { log } from "../../log.js";
import { CircuitBreaker } from '@brain/observability';
import { loadStreamWorkerConfig } from '@brain/config';
import { GRAPH_API_BASE } from '../meta-constants.js';

/**
 * meta-insights-client.ts — Meta (Facebook) Ads Insights API client (ADR-AD-3 / ADR-AD-7).
 *
 * Mirrors razorpay-settlements-client.ts: paged, rate-limit-aware.
 *   - Auth: OAuth access_token (Bearer) — NEVER logged (I-S09).
 *   - Graph API version pinned in meta-constants.ts (one source of truth).
 *   - Rate limit (ADR-AD-7): Meta returns the X-Business-Use-Case-Usage / X-App-Usage headers
 *     and error codes 17 / 80000 / 80004 + platform error code 4 on throttle → bounded backoff,
 *     honouring estimated_time_to_regain_access when present. Persistent throttle surfaces as
 *     RateLimited (the caller marks health_state + aborts the run).
 *   - NEVER logs the access_token or the raw response body (I-S09 / C5).
 *
 * Sync vs Async path selection (ADR-AD-7 / large-account scale):
 *   - Small pulls (default): synchronous GET /insights — immediate response, cursor pagination.
 *   - Large pulls: async POST /insights → poll async_percent_completion until complete → cursor-
 *     fetch the result from the job's own paging URL. Enabled by passing asyncMode=true or
 *     META_INSIGHTS_ASYNC_MODE=1 env var. The caller can also force a level to async via opts.
 *
 * Endpoint (sync): GET /v25.0/act_{ad_account_id}/insights
 * Endpoint (async): POST /v25.0/act_{ad_account_id}/insights (returns {report_run_id})
 *   → GET /v25.0/{report_run_id} until async_percent_completion === 100
 *   → GET /v25.0/{report_run_id}/insights for pages
 *
 * Spend is returned as an account-currency MAJOR-unit decimal string — the mapper converts
 * to BIGINT minor units (I-S07). currency comes from the account, not the row.
 */

/** T2-9: per-request timeout — a hung Meta Graph socket aborts instead of stalling the spend re-pull. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Maximum number of poll attempts when waiting for an async ad_report_run to complete.
 * Each poll cycle waits ASYNC_POLL_INTERVAL_MS before the next check.
 */
const ASYNC_POLL_MAX_ATTEMPTS = 60;
const ASYNC_POLL_INTERVAL_MS = 5_000; // 5 s → max wait ≈ 5 min

/** Thrown when Meta signals a non-retryable auth failure (token expired/revoked). */
export const META_AUTH_ERROR = 'META_AUTH_ERROR';
/** Thrown when Meta throttles persistently — caller marks RateLimited + aborts run (ADR-AD-7). */
export const META_RATE_LIMITED = 'META_RATE_LIMITED';
/** Thrown when an async ad_report_run does not complete within ASYNC_POLL_MAX_ATTEMPTS. */
export const META_ASYNC_TIMEOUT = 'META_ASYNC_TIMEOUT';

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
  actions?: unknown;           // conversion COUNT array (ADR-AD-8)
  action_values?: unknown;     // conversion REVENUE array — MAJOR-unit per action_type (A2)
  cost_per_action_type?: unknown; // per-action CPA (spec-listed; passthrough — derivable downstream)
  ctr?: string | null;         // click-through ratio (string)
  cpc?: string | null;         // MAJOR-unit decimal cost-per-click (account currency)
  cpm?: string | null;         // MAJOR-unit decimal cost-per-mille (account currency)
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

/**
 * Parsed throttle state from X-Business-Use-Case-Usage or X-App-Usage headers.
 * type === 'THROTTLED' means the caller should back off for backoffMs milliseconds.
 */
export interface MetaUsageThrottleSignal {
  type: 'THROTTLED' | 'OK';
  /** Milliseconds to wait before the next call. 0 when not throttled. */
  backoffMs: number;
  /** Raw call_count percentage (0-100), for logging. */
  callCountPct: number | null;
}

const INSIGHTS_FIELDS = [
  'campaign_id',
  'campaign_name',
  'adset_id',
  'ad_id',
  'spend',
  'impressions',
  'clicks',
  'ctr',                  // A2: click-through ratio (spec-listed)
  'cpc',                  // A2: MAJOR-unit cost-per-click  → cpc_minor (mapper)
  'cpm',                  // A2: MAJOR-unit cost-per-mille   → cpm_minor (mapper)
  'actions',              // conversion COUNT array (ADR-AD-8)
  'action_values',        // A2: conversion REVENUE array → conv_value_minor (mapper) → platform ROAS
  'cost_per_action_type', // A2: per-action CPA (passthrough; spec-listed, derivable downstream)
].join(',');

/**
 * A2: request Meta-attributed action counts/values under EXPLICIT attribution windows
 * (`7d_click` + `1d_view`) rather than the account default — so the conversion counts and
 * revenue (action_values) can be reconciled against Meta's own canonical windows. Pre-encoded
 * once (a constant JSON array) and appended to every insights URL (sync + async). Money stays
 * out of this — it only scopes WHICH attributed actions Meta returns.
 */
const ACTION_ATTRIBUTION_WINDOWS = encodeURIComponent(JSON.stringify(['7d_click', '1d_view']));

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeAccountId(adAccountId: string): string {
  const id = adAccountId.trim();
  return id.startsWith('act_') ? id : `act_${id}`;
}

/**
 * Parse X-Business-Use-Case-Usage or X-App-Usage response headers to extract
 * throttle signals. Returns a MetaUsageThrottleSignal.
 *
 * X-Business-Use-Case-Usage is a JSON object keyed by business_id:
 *   { "<biz_id>": [{ "type": "...", "estimated_time_to_regain_access": 0,
 *                    "call_count": 10, "total_cputime": 5, "total_time": 6 }] }
 *
 * X-App-Usage is a flat JSON object:
 *   { "call_count": 28, "total_cputime": 25, "total_time": 25 }
 *
 * We treat call_count >= 80 as THROTTLED with a synthetic 30 s backoff when
 * estimated_time_to_regain_access is 0. When the header provides a non-zero
 * estimated_time_to_regain_access (seconds), we use that instead.
 */
export function parseUsageHeader(
  headerValue: string | null | undefined,
  headerName: 'X-Business-Use-Case-Usage' | 'X-App-Usage',
): MetaUsageThrottleSignal {
  if (!headerValue) return { type: 'OK', backoffMs: 0, callCountPct: null };

  try {
    const parsed = JSON.parse(headerValue) as unknown;

    // X-Business-Use-Case-Usage: { "<biz_id>": [{ ... }] }
    if (headerName === 'X-Business-Use-Case-Usage' && typeof parsed === 'object' && parsed !== null) {
      const buckets = Object.values(parsed as Record<string, unknown>);
      let highestCallCount: number | null = null;
      // Scan ALL buckets — return THROTTLED if any bucket is at/above threshold.
      for (const bucket of buckets) {
        if (!Array.isArray(bucket)) continue;
        for (const entry of bucket as unknown[]) {
          if (typeof entry !== 'object' || entry === null) continue;
          const e = entry as Record<string, unknown>;
          const callCount = typeof e['call_count'] === 'number' ? e['call_count'] : null;
          if (callCount === null) continue;
          if (highestCallCount === null || callCount > highestCallCount) highestCallCount = callCount;
          if (callCount >= 80) {
            const regainSec = typeof e['estimated_time_to_regain_access'] === 'number'
              ? e['estimated_time_to_regain_access']
              : 0;
            const backoffMs = regainSec > 0 ? regainSec * 1000 : 30_000;
            return { type: 'THROTTLED', backoffMs, callCountPct: callCount };
          }
        }
      }
      return { type: 'OK', backoffMs: 0, callCountPct: highestCallCount };
    }

    // X-App-Usage: { "call_count": N, ... }
    if (typeof parsed === 'object' && parsed !== null) {
      const e = parsed as Record<string, unknown>;
      const callCount = typeof e['call_count'] === 'number' ? e['call_count'] : null;
      if (callCount !== null && callCount >= 80) {
        return { type: 'THROTTLED', backoffMs: 30_000, callCountPct: callCount };
      }
      return { type: 'OK', backoffMs: 0, callCountPct: callCount };
    }
  } catch {
    // malformed header — treat as OK (fail open for non-throttle path)
  }
  return { type: 'OK', backoffMs: 0, callCountPct: null };
}

/**
 * Decide whether an error response body represents a Meta throttle condition.
 * Throttle error codes: 17 (user request limit), 80000 (ad insights throttle),
 * 80004 (ad account rate limit). Platform error code 4 (application-level limit).
 */
export function isThrottleError(code: number | undefined, subcode: number | undefined): boolean {
  if (code === 17) return true;
  if (code === 80000) return true;
  if (code === 80004) return true;
  if (code === 4) return true;       // platform error: application request limit
  if (subcode === 2446079) return true; // platform-level ad-account throttle subcode
  return false;
}

export class MetaInsightsClient {
  private readonly accessToken: string;
  private readonly actId: string;
  private readonly maxBackoffRetries: number;
  private readonly breaker: CircuitBreaker;
  /**
   * When true, large async ad_report_run path is used.
   * Overridden per-call by fetchInsightsFirstPage(…, { asyncMode }) if needed.
   */
  private readonly defaultAsyncMode: boolean;

  /**
   * @param creds           access_token + ad_account_id — token NEVER logged (I-S09)
   * @param maxBackoffRetries  bounded backoff cap on throttle (ADR-AD-7, default 5)
   * @param defaultAsyncMode   when true, prefer the async ad_report_run path (default: env flag)
   */
  constructor(
    creds: MetaApiCredentials,
    maxBackoffRetries = 5,
    defaultAsyncMode = loadStreamWorkerConfig().META_INSIGHTS_ASYNC_MODE,
  ) {
    this.accessToken = creds.accessToken; // stays in memory; never logged
    this.actId = normalizeAccountId(creds.adAccountId);
    this.maxBackoffRetries = maxBackoffRetries;
    this.defaultAsyncMode = defaultAsyncMode;
    this.breaker = new CircuitBreaker({ name: 'meta-insights', failureThreshold: 5, openMs: 60_000 });
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
   *
   * @param level      'campaign' | 'adset' | 'ad'
   * @param since      YYYY-MM-DD inclusive
   * @param until      YYYY-MM-DD inclusive
   * @param opts.asyncMode  when true, use the async ad_report_run path regardless of default
   */
  async fetchInsightsFirstPage(
    level: 'campaign' | 'adset' | 'ad',
    since: string,
    until: string,
    opts: { asyncMode?: boolean } = {},
  ): Promise<MetaInsightsPage> {
    const useAsync = opts.asyncMode ?? this.defaultAsyncMode;
    if (useAsync) {
      return this.fetchInsightsAsync(level, since, until);
    }
    return this.fetchInsightsSync(level, since, until);
  }

  // ── Synchronous path (small pulls) ─────────────────────────────────────────

  private async fetchInsightsSync(
    level: 'campaign' | 'adset' | 'ad',
    since: string,
    until: string,
  ): Promise<MetaInsightsPage> {
    const timeRange = encodeURIComponent(JSON.stringify({ since, until }));
    const url =
      `${GRAPH_API_BASE}/${this.actId}/insights` +
      `?level=${level}&time_increment=1&time_range=${timeRange}` +
      `&fields=${INSIGHTS_FIELDS}&action_attribution_windows=${ACTION_ATTRIBUTION_WINDOWS}&limit=500`;
    return this.fetchInsightsByUrl(url, level);
  }

  // ── Async path (large-account scale) ───────────────────────────────────────

  /**
   * Async ad_report_run path (ADR-AD-7 / large-account scale):
   *   1. POST to /insights → { report_run_id }
   *   2. Poll GET /{report_run_id} until async_percent_completion === 100
   *   3. Cursor-fetch results from /{report_run_id}/insights
   */
  private async fetchInsightsAsync(
    level: 'campaign' | 'adset' | 'ad',
    since: string,
    until: string,
  ): Promise<MetaInsightsPage> {
    const timeRange = encodeURIComponent(JSON.stringify({ since, until }));
    const postUrl =
      `${GRAPH_API_BASE}/${this.actId}/insights` +
      `?level=${level}&time_increment=1&time_range=${timeRange}` +
      `&fields=${INSIGHTS_FIELDS}&action_attribution_windows=${ACTION_ATTRIBUTION_WINDOWS}&limit=500`;

    // Step 1: create the async job
    const jobBody = (await this.postJson(postUrl)) as { report_run_id?: string | number };
    const reportRunId = String(jobBody.report_run_id ?? '');
    if (!reportRunId) {
      throw new Error('[meta-insights-client] async POST /insights did not return a report_run_id');
    }

    log.info(`[meta-insights-client] async job created report_run_id=${reportRunId}`);

    // Step 2: poll until complete
    await this.pollAsyncJob(reportRunId);

    // Step 3: fetch the first page of results
    const resultsUrl =
      `${GRAPH_API_BASE}/${reportRunId}/insights` +
      `?fields=${INSIGHTS_FIELDS}&limit=500`;
    return this.fetchInsightsByUrl(resultsUrl, level);
  }

  /**
   * Poll an async ad_report_run until async_percent_completion reaches 100.
   * Throws META_ASYNC_TIMEOUT if ASYNC_POLL_MAX_ATTEMPTS is reached without completion.
   */
  async pollAsyncJob(reportRunId: string): Promise<void> {
    const statusUrl = `${GRAPH_API_BASE}/${reportRunId}`;

    for (let attempt = 0; attempt < ASYNC_POLL_MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await sleep(ASYNC_POLL_INTERVAL_MS);
      }

      const status = (await this.getJson(statusUrl)) as {
        async_percent_completion?: number;
        async_status?: string;
      };

      const pct = status.async_percent_completion ?? 0;
      const asyncStatus = status.async_status ?? 'Job Running';

      log.info(
        `[meta-insights-client] async poll report_run_id=${reportRunId} ` +
        `pct=${pct} status=${asyncStatus} attempt=${attempt + 1}/${ASYNC_POLL_MAX_ATTEMPTS}`,
      );

      // Terminal failure states returned by Meta
      if (asyncStatus === 'Job Failed' || asyncStatus === 'Job Skipped') {
        throw new Error(`[meta-insights-client] async job ${asyncStatus} report_run_id=${reportRunId}`);
      }

      if (pct >= 100) {
        return;
      }
    }

    throw new Error(
      `${META_ASYNC_TIMEOUT}: async job did not complete after ` +
      `${ASYNC_POLL_MAX_ATTEMPTS} attempts (report_run_id=${reportRunId})`,
    );
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

  // ── HTTP helpers ────────────────────────────────────────────────────────────

  /**
   * POST a Graph API URL with Bearer auth + bounded backoff on throttle.
   * Used to create async ad_report_run jobs.
   * NEVER logs the token or the response body (I-S09 / C5).
   */
  private async postJson(url: string): Promise<unknown> {
    return this.breaker.fire(async () => {
      for (let attempt = 0; attempt <= this.maxBackoffRetries; attempt++) {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json',
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        if (res.status === 401) {
          throw new Error(`${META_AUTH_ERROR}: 401 Unauthorized from Meta Insights`);
        }

        const throttled = await this.handleThrottleResponse(res, attempt, 'POST');
        if (throttled === 'retry') continue;
        if (throttled === 'exhausted') {
          throw new Error(`${META_RATE_LIMITED}: persistent throttle on POST`);
        }

        if (!res.ok) {
          throw new Error(`[meta-insights-client] HTTP ${res.status} from Meta Insights POST`);
        }

        return res.json();
      }
      throw new Error(`${META_RATE_LIMITED}: exceeded backoff retries on POST`);
    });
  }

  /**
   * GET a Graph API URL with Bearer auth + bounded backoff on throttle (ADR-AD-7).
   * NEVER logs the token or the response body (I-S09 / C5).
   */
  private async getJson(url: string): Promise<unknown> {
    return this.breaker.fire(async () => {
      for (let attempt = 0; attempt <= this.maxBackoffRetries; attempt++) {
        const res = await fetch(url, {
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json',
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        // 401/190 → token expired/revoked → non-retryable auth error.
        if (res.status === 401) {
          throw new Error(`${META_AUTH_ERROR}: 401 Unauthorized from Meta Insights`);
        }

        const throttled = await this.handleThrottleResponse(res, attempt, 'GET');
        if (throttled === 'retry') continue;
        if (throttled === 'exhausted') {
          throw new Error(`${META_RATE_LIMITED}: persistent throttle on GET`);
        }

        if (!res.ok) {
          throw new Error(`[meta-insights-client] HTTP ${res.status} from Meta Insights`);
        }

        return res.json();
      }
      throw new Error(`${META_RATE_LIMITED}: exceeded backoff retries`);
    }); // end breaker.fire
  }

  /**
   * Inspect a response for throttle signals:
   *   - X-Business-Use-Case-Usage / X-App-Usage header call_count >= 80
   *   - HTTP 429
   *   - HTTP 400 with error.code in {17, 80000, 80004, 4}
   *
   * Returns:
   *   'retry'     — backed off, caller should continue the retry loop
   *   'exhausted' — retries exhausted, caller should throw META_RATE_LIMITED
   *   null        — not a throttle signal, caller continues normally
   *
   * When a backoff is warranted the method sleeps before returning 'retry'.
   */
  private async handleThrottleResponse(
    res: Response,
    attempt: number,
    method: 'GET' | 'POST',
  ): Promise<'retry' | 'exhausted' | null> {
    // ── Header-based throttle signals (honour estimated_time_to_regain_access) ──
    const bucSignal = parseUsageHeader(
      res.headers.get('X-Business-Use-Case-Usage'),
      'X-Business-Use-Case-Usage',
    );
    const appSignal = parseUsageHeader(
      res.headers.get('X-App-Usage'),
      'X-App-Usage',
    );
    const headerThrottle = bucSignal.type === 'THROTTLED' ? bucSignal : appSignal;

    if (headerThrottle.type === 'THROTTLED') {
      if (attempt >= this.maxBackoffRetries) return 'exhausted';
      const backoffMs = headerThrottle.backoffMs > 0 ? headerThrottle.backoffMs : Math.min(30_000, 1000 * 2 ** attempt);
      log.info(
        `[meta-insights-client] ${method} header-throttle call_count=${headerThrottle.callCountPct}% ` +
        `— backoff ${backoffMs}ms (attempt ${attempt + 1}/${this.maxBackoffRetries})`,
      );
      await sleep(backoffMs);
      return 'retry';
    }

    // ── HTTP 429 ────────────────────────────────────────────────────────────────
    if (res.status === 429) {
      if (attempt >= this.maxBackoffRetries) return 'exhausted';
      const backoffMs = Math.min(30_000, 1000 * 2 ** attempt);
      log.info(
        `[meta-insights-client] ${method} HTTP 429 — backoff ${backoffMs}ms (attempt ${attempt + 1}/${this.maxBackoffRetries})`,
      );
      await sleep(backoffMs);
      return 'retry';
    }

    // ── HTTP 400 with a throttle error code ────────────────────────────────────
    if (res.status === 400) {
      let errBody: Record<string, unknown> = {};
      try {
        errBody = (await res.clone().json()) as Record<string, unknown>;
      } catch { /* malformed — treat as non-throttle 400 */ }

      const err = (errBody as { error?: { code?: number; error_subcode?: number } }).error;
      const code = err?.code;
      const subcode = err?.error_subcode;

      if (isThrottleError(code, subcode)) {
        if (attempt >= this.maxBackoffRetries) return 'exhausted';
        const backoffMs = Math.min(30_000, 1000 * 2 ** attempt);
        log.info(
          `[meta-insights-client] ${method} throttle code=${code} subcode=${subcode} ` +
          `— backoff ${backoffMs}ms (attempt ${attempt + 1}/${this.maxBackoffRetries})`,
        );
        await sleep(backoffMs);
        return 'retry';
      }
      // non-throttle 400 → hard error (no body logged — C5)
      throw new Error(`[meta-insights-client] HTTP 400 (non-throttle code=${code}) from Meta Insights ${method}`);
    }

    return null; // not a throttle condition
  }
}
