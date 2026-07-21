/**
 * meta-insights-client.unit.test.ts
 *
 * Covers three new behaviours added in the meta-async-insights-throttle fix:
 *   1. parseUsageHeader — X-Business-Use-Case-Usage + X-App-Usage parse + THROTTLED detection
 *   2. isThrottleError — codes 17 / 80000 / 80004 / 4 / subcode 2446079
 *   3. MetaInsightsClient.pollAsyncJob — happy-path poll→complete + timeout
 *   4. MetaInsightsClient async ad_report_run full path: POST→poll→fetch
 *   5. Throttle code 80000 triggers backoff in getJson / the sync path (via fetchAccountMeta)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseUsageHeader,
  isThrottleError,
  MetaInsightsClient,
  META_AUTH_ERROR,
  META_RATE_LIMITED,
  META_ASYNC_TIMEOUT,
  META_TOO_MUCH_DATA,
  META_ACCESS_FORBIDDEN,
  type MetaApiCredentials,
} from '../jobs/meta-spend-repull/meta-insights-client.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

type FetchStub = (...args: any[]) => Promise<Response>;

function makeResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  }) as unknown as Response;
}

/** Build a minimal MetaInsightsClient with a stubbed global fetch. */
function makeClient(
  fetchImpl: FetchStub,
  opts: { asyncMode?: boolean; maxRetries?: number } = {},
): MetaInsightsClient {
  const creds: MetaApiCredentials = { accessToken: 'test-token', adAccountId: 'act_123' };
  // Patch global fetch for the duration of the test
  vi.stubGlobal('fetch', fetchImpl);
  return new MetaInsightsClient(creds, opts.maxRetries ?? 2, opts.asyncMode ?? false);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── 1. parseUsageHeader ──────────────────────────────────────────────────────

describe('parseUsageHeader', () => {
  describe('X-Business-Use-Case-Usage', () => {
    it('returns OK when call_count is below threshold', () => {
      const header = JSON.stringify({ '123': [{ call_count: 50, estimated_time_to_regain_access: 0 }] });
      const result = parseUsageHeader(header, 'X-Business-Use-Case-Usage');
      expect(result.type).toBe('OK');
      expect(result.callCountPct).toBe(50);
      expect(result.backoffMs).toBe(0);
    });

    it('returns THROTTLED with 30s default when call_count >= 80 and regain=0', () => {
      const header = JSON.stringify({ '123': [{ call_count: 85, estimated_time_to_regain_access: 0 }] });
      const result = parseUsageHeader(header, 'X-Business-Use-Case-Usage');
      expect(result.type).toBe('THROTTLED');
      expect(result.callCountPct).toBe(85);
      expect(result.backoffMs).toBe(30_000);
    });

    it('honours estimated_time_to_regain_access when non-zero', () => {
      const header = JSON.stringify({ '456': [{ call_count: 95, estimated_time_to_regain_access: 120 }] });
      const result = parseUsageHeader(header, 'X-Business-Use-Case-Usage');
      expect(result.type).toBe('THROTTLED');
      expect(result.backoffMs).toBe(120_000); // 120 s → ms
    });

    it('returns OK for null / undefined / empty string', () => {
      expect(parseUsageHeader(null, 'X-Business-Use-Case-Usage').type).toBe('OK');
      expect(parseUsageHeader(undefined, 'X-Business-Use-Case-Usage').type).toBe('OK');
      expect(parseUsageHeader('', 'X-Business-Use-Case-Usage').type).toBe('OK');
    });

    it('returns OK on malformed JSON (fail open)', () => {
      const result = parseUsageHeader('not-json', 'X-Business-Use-Case-Usage');
      expect(result.type).toBe('OK');
    });

    it('handles multiple business buckets, picks the first throttled one', () => {
      const header = JSON.stringify({
        '111': [{ call_count: 20, estimated_time_to_regain_access: 0 }],
        '222': [{ call_count: 90, estimated_time_to_regain_access: 60 }],
      });
      const result = parseUsageHeader(header, 'X-Business-Use-Case-Usage');
      expect(result.type).toBe('THROTTLED');
      expect(result.backoffMs).toBe(60_000);
    });
  });

  describe('X-App-Usage', () => {
    it('returns OK when call_count is below threshold', () => {
      const header = JSON.stringify({ call_count: 25, total_cputime: 10, total_time: 12 });
      const result = parseUsageHeader(header, 'X-App-Usage');
      expect(result.type).toBe('OK');
      expect(result.callCountPct).toBe(25);
    });

    it('returns THROTTLED with 30s backoff when call_count >= 80', () => {
      const header = JSON.stringify({ call_count: 100, total_cputime: 80, total_time: 80 });
      const result = parseUsageHeader(header, 'X-App-Usage');
      expect(result.type).toBe('THROTTLED');
      expect(result.backoffMs).toBe(30_000);
    });
  });
});

// ── 2. isThrottleError ───────────────────────────────────────────────────────

describe('isThrottleError', () => {
  it('returns true for code=17 (user request limit)', () => {
    expect(isThrottleError(17, undefined)).toBe(true);
  });

  it('returns true for code=80000 (ad insights throttle — the new code)', () => {
    expect(isThrottleError(80000, undefined)).toBe(true);
  });

  it('returns true for code=80004 (ad account rate limit)', () => {
    expect(isThrottleError(80004, undefined)).toBe(true);
  });

  it('returns true for code=4 (platform application request limit)', () => {
    expect(isThrottleError(4, undefined)).toBe(true);
  });

  it('returns true for subcode=2446079 (platform ad-account throttle subcode)', () => {
    expect(isThrottleError(undefined, 2446079)).toBe(true);
  });

  it('returns false for unrelated codes', () => {
    expect(isThrottleError(100, undefined)).toBe(false);
    expect(isThrottleError(190, undefined)).toBe(false);   // auth error, not throttle
    expect(isThrottleError(undefined, undefined)).toBe(false);
  });
});

// ── 3. MetaInsightsClient.pollAsyncJob — happy path + timeout ───────────────

describe('MetaInsightsClient.pollAsyncJob', () => {
  beforeEach(() => {
    // Speed up sleep for tests
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves immediately when first poll returns 100%', async () => {
    let callCount = 0;
    const fetchStub: FetchStub = async () => {
      callCount += 1;
      return makeResponse(200, { async_percent_completion: 100, async_status: 'Job Complete' });
    };
    const client = makeClient(fetchStub);

    await expect(client.pollAsyncJob('run-id-1')).resolves.toBeUndefined();
    expect(callCount).toBe(1);
  });

  it('polls multiple times before reaching 100%', async () => {
    let callCount = 0;
    const completions = [20, 60, 100];
    const fetchStub: FetchStub = async () => {
      const pct = completions[callCount] ?? 100;
      callCount += 1;
      return makeResponse(200, { async_percent_completion: pct, async_status: 'Job Running' });
    };
    const client = makeClient(fetchStub);

    // Run pollAsyncJob; advance fake timers for each sleep
    const pollPromise = client.pollAsyncJob('run-id-2');
    // Advance timers for each ASYNC_POLL_INTERVAL_MS sleep in the loop
    for (let i = 0; i < 3; i++) {
      await vi.runAllTimersAsync();
    }
    await expect(pollPromise).resolves.toBeUndefined();
    expect(callCount).toBe(3);
  });

  it('throws META_ASYNC_TIMEOUT when max attempts exceeded', async () => {
    const fetchStub: FetchStub = async () =>
      makeResponse(200, { async_percent_completion: 5, async_status: 'Job Running' });
    const client = makeClient(fetchStub, { maxRetries: 2 });

    // Set up the rejection expectation, advance all timers (60 poll cycles × ASYNC_POLL_INTERVAL_MS),
    // then await the rejection — all in a single Promise.all so neither side races.
    const rejectPromise = expect(client.pollAsyncJob('run-id-timeout')).rejects.toThrow(META_ASYNC_TIMEOUT);
    await vi.runAllTimersAsync();
    await rejectPromise;
  });

  it('throws on Job Failed status', async () => {
    const fetchStub: FetchStub = async () =>
      makeResponse(200, { async_percent_completion: 50, async_status: 'Job Failed' });
    const client = makeClient(fetchStub);
    await expect(client.pollAsyncJob('run-id-fail')).rejects.toThrow('Job Failed');
  });
});

// ── 4. Full async ad_report_run path: POST→poll→fetch ────────────────────────

describe('MetaInsightsClient async path (fetchInsightsFirstPage asyncMode=true)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates the async job, polls to completion, and returns the first results page', async () => {
    const calls: string[] = [];

    const fetchStub: FetchStub = async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      // POST to /insights → job creation
      if (url.includes('/insights') && url.includes('act_')) {
        calls.push('POST:create-job');
        return makeResponse(200, { report_run_id: 'RUN-42' });
      }
      // GET /RUN-42 → poll status
      if (url.includes('RUN-42') && !url.includes('/insights')) {
        calls.push('GET:poll');
        return makeResponse(200, { async_percent_completion: 100, async_status: 'Job Complete' });
      }
      // GET /RUN-42/insights → result pages
      if (url.includes('RUN-42/insights')) {
        calls.push('GET:results');
        return makeResponse(200, {
          data: [{ campaign_id: 'c1', spend: '100.00', date_start: '2026-06-01' }],
          paging: {},
        });
      }
      return makeResponse(200, {});
    };

    const creds: MetaApiCredentials = { accessToken: 'test-token', adAccountId: 'act_123' };
    vi.stubGlobal('fetch', fetchStub);
    const client = new MetaInsightsClient(creds, 2, true /* asyncMode */);

    const pagePromise = client.fetchInsightsFirstPage('campaign', '2026-06-01', '2026-06-21');
    await vi.runAllTimersAsync();
    const page = await pagePromise;

    expect(calls).toContain('POST:create-job');
    expect(calls).toContain('GET:poll');
    expect(calls).toContain('GET:results');
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]?.campaign_id).toBe('c1');
    expect(page.nextUrl).toBeNull();
  });

  it('falls back to no nextUrl when paging absent in result', async () => {
    const fetchStub: FetchStub = async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('act_') && url.includes('/insights')) {
        return makeResponse(200, { report_run_id: 'RUN-77' });
      }
      if (url.includes('RUN-77') && !url.includes('/insights')) {
        return makeResponse(200, { async_percent_completion: 100, async_status: 'Job Complete' });
      }
      if (url.includes('RUN-77/insights')) {
        return makeResponse(200, { data: [], paging: {} });
      }
      return makeResponse(200, {});
    };

    const creds: MetaApiCredentials = { accessToken: 'tok', adAccountId: 'act_99' };
    vi.stubGlobal('fetch', fetchStub);
    const client = new MetaInsightsClient(creds, 2, true);

    const pagePromise = client.fetchInsightsFirstPage('ad', '2026-06-01', '2026-06-21');
    await vi.runAllTimersAsync();
    const page = await pagePromise;

    expect(page.rows).toHaveLength(0);
    expect(page.nextUrl).toBeNull();
  });
});

// ── 4b. A2: insights request carries action_values + attribution windows ──────

describe('MetaInsightsClient A2 insights request fields', () => {
  it('sync insights URL requests action_values + action_attribution_windows([7d_click,1d_view]) + cpc/cpm/ctr', async () => {
    let seenUrl = '';
    const fetchStub: FetchStub = async (input) => {
      seenUrl = typeof input === 'string' ? input : (input as Request).url;
      return makeResponse(200, { data: [], paging: {} });
    };
    const client = makeClient(fetchStub, { asyncMode: false });
    await client.fetchInsightsFirstPage('campaign', '2026-06-01', '2026-06-21');

    expect(seenUrl).toContain('action_values');
    expect(seenUrl).toContain('cost_per_action_type');
    expect(seenUrl).toContain('cpc');
    expect(seenUrl).toContain('cpm');
    expect(seenUrl).toContain('ctr');
    // attribution windows are URL-encoded JSON: ["7d_click","1d_view"]
    const decoded = decodeURIComponent(seenUrl);
    expect(decoded).toContain('action_attribution_windows=["7d_click","1d_view"]');
  });
});

// ── 4b-light. lightProjection drops the VIDEO + ENGAGEMENT_RANKING tiers ──────
//
// Backfill async-result-read 2637 fix: the backfill passes lightProjection:true so the built request
// carries only IDENTITY + CORE + ACTION fields (drop video + engagement rankings) — a large ad account
// 2637s on the async RESULT READ purely on projection WIDTH, even at the 1-day floor. The live repull
// leaves lightProjection default false → the FULL field set is unchanged.

describe('MetaInsightsClient lightProjection field selection', () => {
  it('lightProjection:true drops video + engagement fields, keeps identity + core + action', async () => {
    let seenUrl = '';
    const fetchStub: FetchStub = async (input) => {
      seenUrl = typeof input === 'string' ? input : (input as Request).url;
      return makeResponse(200, { data: [], paging: {} });
    };
    const client = makeClient(fetchStub, { asyncMode: false });
    // Route through fetchInsightsForWindow so the lightProjection opt threads down to the URL builder.
    await client.fetchInsightsForWindow('campaign', '2026-06-01', '2026-06-01', null, {
      lightProjection: true,
    });

    const fieldsParam = /[?&]fields=([^&]+)/.exec(seenUrl)?.[1] ?? '';
    const fields = decodeURIComponent(fieldsParam).split(',');
    // Kept: identity + core + action tiers.
    expect(fields).toContain('campaign_id');       // IDENTITY
    expect(fields).toContain('spend');             // CORE
    expect(fields).toContain('cpc');               // CORE
    expect(fields).toContain('actions');           // ACTION
    expect(fields).toContain('action_values');     // ACTION
    expect(fields).toContain('purchase_roas');     // ACTION (ROAS retained at base grain)
    // Dropped: video + engagement/ranking tiers.
    expect(fields).not.toContain('video_play_actions');
    expect(fields).not.toContain('video_thruplay_watched_actions');
    expect(fields).not.toContain('inline_post_engagement');
    expect(fields).not.toContain('quality_ranking');
    expect(fields).not.toContain('engagement_rate_ranking');
    expect(fields).not.toContain('conversion_rate_ranking');
  });

  it('lightProjection:false (default) keeps the FULL field set — video + engagement present', async () => {
    let seenUrl = '';
    const fetchStub: FetchStub = async (input) => {
      seenUrl = typeof input === 'string' ? input : (input as Request).url;
      return makeResponse(200, { data: [], paging: {} });
    };
    const client = makeClient(fetchStub, { asyncMode: false });
    // Default path (the live repull) — no lightProjection flag.
    await client.fetchInsightsFirstPage('campaign', '2026-06-01', '2026-06-21');

    const fieldsParam = /[?&]fields=([^&]+)/.exec(seenUrl)?.[1] ?? '';
    const fields = decodeURIComponent(fieldsParam).split(',');
    // Full set: identity + core + action + video + engagement all present.
    expect(fields).toContain('spend');
    expect(fields).toContain('actions');
    expect(fields).toContain('video_play_actions');
    expect(fields).toContain('video_thruplay_watched_actions');
    expect(fields).toContain('inline_post_engagement');
    expect(fields).toContain('quality_ranking');
    expect(fields).toContain('conversion_rate_ranking');
  });
});

// ── 4c. Adaptive window-halving on code 2637 (fetchInsightsForWindow) ─────────
//
// Locks down the meta-backfill fix: Meta code 2637 ("reduce the amount of data") on a too-large
// window must NOT fail the run. fetchInsightsForWindow uses the SYNC GET path (client default — the
// same proven path the live spend-repull lane uses; the async ad_report_run result-read 2637s on some
// accounts even for a 1-day report) and, if a window still 2637s, halves it and retries each half
// recursively down to a single-day floor.

/** Inclusive day span between two YYYY-MM-DD dates. */
function daySpanInclusive(since: string, until: string): number {
  return Math.round((Date.parse(`${until}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)) / 86_400_000) + 1;
}

/**
 * A window-aware SYNC-GET fetch stub. Parses [since, until] from the insights GET's `time_range` query
 * param: a window spanning MORE than `maxDays` returns Meta code 2637; anything ≤ maxDays returns one
 * row tagged with the window (single page, no nextUrl). Records every GET URL for assertions.
 */
function windowAwareFetch(maxDays: number, seenUrls?: string[]): FetchStub {
  return async (input: unknown) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const m = /time_range=([^&]+)/.exec(url);
    if (url.includes('/insights') && m) {
      seenUrls?.push(url);
      const { since, until } = JSON.parse(decodeURIComponent(m[1]!)) as { since: string; until: string };
      if (daySpanInclusive(since, until) > maxDays) {
        return makeResponse(400, { error: { code: 2637, message: 'Please reduce the amount of data you are asking for' } });
      }
      return makeResponse(200, {
        data: [{ campaign_id: `c_${since}_${until}`, spend: '1.00', date_start: since }],
        paging: {},
      });
    }
    return makeResponse(200, {});
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CURSOR-STALL SAFETY CONTRACT (documents the meta-spend-repull backfillConnector invariant):
// the backfill chunk loop (meta-spend-repull/run.ts backfillConnector) HOLDS its chunk cursor
// whenever a (breakdown,level) pass THROWS out of fetchInsightsForWindow for a TRANSIENT reason,
// so the next run re-attempts the SAME chunk (audit LOSS fix — a skipped >28-day-old window is
// never re-fetched by any other lane). Two things prevent that hold from becoming an infinite
// re-run loop:
//   (1) The SPLITTER'S NO-THROW CONTRACT for raw HTTP 5xx (proven by the describe blocks below):
//       a 5xx on too-large windows is recursively window-halved down to the 1-day floor, where a
//       persistent 5xx is SKIPPED (returns [], a NORMAL return, never a throw).
//   (2) The FLOOR-2637 UNSERVABLE classification in the backfill catch: an above-floor 2637 is
//       window-split internally (never throws); a floor-2637 (1-day window that still 2637s even
//       with the light projection) DOES throw, but the per-pass catch classifies it as UNSERVABLE
//       and `continue`s WITHOUT latching transientFailure — the identical retry would 2637
//       identically, so the cursor advances (explicit, logged data gap) rather than wedging.
// A pass therefore only latches on genuinely transient conditions (async-report timeout, network
// failure, unknown errors) which eventually clear. If the skip-at-floor 5xx behaviour proven below
// is ever changed to rethrow, OR the floor-2637 catch is reclassified as transient, the backfill
// chunk cursor CAN wedge — keep all three in sync.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('MetaInsightsClient.fetchInsightsForWindow — adaptive halving on code 2637', () => {
  it('halves a too-large window and returns rows from every in-limit sub-window', async () => {
    const seenUrls: string[] = [];
    // Account tolerates ≤15-day windows; a 30-day pull trips 2637 and must be split. asyncMode:false =
    // the SYNC GET path the backfill now follows.
    const client = makeClient(windowAwareFetch(15, seenUrls), { asyncMode: false, maxRetries: 2 });

    const rows = await client.fetchInsightsForWindow('campaign', '2026-06-01', '2026-06-30');

    // 30d → 2637 → split into [06-01..06-15] + [06-16..06-30], each 15d and in-limit → one row each.
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.campaign_id).sort()).toEqual(
      ['c_2026-06-01_2026-06-15', 'c_2026-06-16_2026-06-30'],
    );
    // The first (30d) GET 2637s; the two 15d GETs succeed → 3 insights GETs total.
    expect(seenUrls).toHaveLength(3);
  });

  it('re-throws META_TOO_MUCH_DATA at the single-day floor (no infinite recursion)', async () => {
    // Every window — even one day — 2637s. The walk must split down to a day, then re-throw (not loop).
    const client = makeClient(windowAwareFetch(0), { asyncMode: false, maxRetries: 2 });

    await expect(
      client.fetchInsightsForWindow('ad', '2026-06-01', '2026-06-02'),
    ).rejects.toThrow(META_TOO_MUCH_DATA);
  });

  it('does not split on a non-2637 error — a hard 400 propagates unchanged', async () => {
    // A different non-throttle 400 (code 100) must NOT trigger window-splitting; it fails fast.
    const fetchStub: FetchStub = async (input: unknown) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('/insights')) {
        return makeResponse(400, { error: { code: 100, message: 'bad field' } });
      }
      return makeResponse(200, {});
    };
    const client = makeClient(fetchStub, { asyncMode: false, maxRetries: 2 });

    const p = client.fetchInsightsForWindow('campaign', '2026-06-01', '2026-06-30');
    await expect(p).rejects.toThrow('code=100');
    await expect(p).rejects.not.toThrow(META_TOO_MUCH_DATA);
  });
});

// ── 4d. Adaptive window-halving on a raw HTTP 5xx (fetchInsightsForWindow) ─────
//
// Locks down the meta-spend-repull firehose fix: Meta returns a raw HTTP 500 (NOT Graph code 2637)
// on heavy ad-level breakdowns (demographic) — a hidden "too much data" signal. getJson tags a 5xx
// with META_SERVER_ERROR, and fetchInsightsForWindow treats it the SAME as 2637 while the window is
// splittable — BUT at the 1-day floor a persistent 5xx SKIPS the window (returns []) rather than
// failing the whole resource (unlike 2637, which re-throws at the floor).

/**
 * A window-aware SYNC-GET fetch stub that returns a raw HTTP 500 for any window spanning MORE than
 * `maxDays`, and one window-tagged row (single page, no nextUrl) for anything ≤ maxDays. Records every
 * GET URL for assertions.
 */
function windowAware5xxFetch(maxDays: number, seenUrls?: string[]): FetchStub {
  return async (input: unknown) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const m = /time_range=([^&]+)/.exec(url);
    if (url.includes('/insights') && m) {
      seenUrls?.push(url);
      const { since, until } = JSON.parse(decodeURIComponent(m[1]!)) as { since: string; until: string };
      if (daySpanInclusive(since, until) > maxDays) {
        // Raw 500 — the ad-level-breakdown "server couldn't build this report" signal (no Graph code).
        return makeResponse(500, { error: { message: 'An unexpected error occurred' } });
      }
      return makeResponse(200, {
        data: [{ campaign_id: `c_${since}_${until}`, spend: '1.00', date_start: since }],
        paging: {},
      });
    }
    return makeResponse(200, {});
  };
}

describe('MetaInsightsClient.fetchInsightsForWindow — adaptive halving on raw HTTP 5xx', () => {
  it('halves a too-large window on a 5xx and returns rows from every in-limit sub-window', async () => {
    const seenUrls: string[] = [];
    // Account tolerates ≤15-day windows; a 30-day pull 500s (not 2637) and must still be split.
    const client = makeClient(windowAware5xxFetch(15, seenUrls), { asyncMode: false, maxRetries: 0 });

    const rows = await client.fetchInsightsForWindow('ad', '2026-06-01', '2026-06-30', 'demographic');

    // 30d → 500 → split into [06-01..06-15] + [06-16..06-30], each 15d and in-limit → one row each.
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.campaign_id).sort()).toEqual(
      ['c_2026-06-01_2026-06-15', 'c_2026-06-16_2026-06-30'],
    );
    // The first (30d) GET 500s; the two 15d GETs succeed → 3 insights GETs total.
    expect(seenUrls).toHaveLength(3);
  });

  it('SKIPS (returns []) — never throws — when a 5xx persists down to the 1-day floor', async () => {
    // Every window — even one day — 500s. Unlike 2637 (which re-throws at the floor), a persistent
    // 5xx is a single window Meta cannot serve: the walk splits to a day, then returns [] so the one
    // unservable window doesn't fail the whole resource/run.
    const client = makeClient(windowAware5xxFetch(0), { asyncMode: false, maxRetries: 0 });

    const rows = await client.fetchInsightsForWindow('ad', '2026-06-01', '2026-06-02', 'demographic');

    expect(rows).toEqual([]);
  });
});

// ── 4e. fetchInsightsForWindow driving the ASYNC ad_report_run path + splitting ──
//
// Locks down the meta-backfill infinite-loop fix (PART A): the backfill lane routes through
// fetchInsightsForWindow with { asyncMode: true } so it uses the async ad_report_run path (POST → poll
// → GET result). The 2637/5xx window-halving + 1-day-floor skip must apply on that async path too, and
// the recursive split must thread asyncMode down (each sub-window is fetched async as well).

/**
 * A window-aware ASYNC fetch stub. Parses [since, until] from the POST /insights `time_range` param and
 * mints a per-window report_run_id; the POST 5xx's (raw HTTP 500 — the ad-level-breakdown "too much
 * data" signal) for any window spanning MORE than `maxDays`. Otherwise: POST → { report_run_id }, GET
 * /{id} → 100% complete, GET /{id}/insights → one window-tagged row. Records every POST window for
 * assertions on the split shape.
 */
function windowAwareAsyncFetch(maxDays: number, seenWindows?: string[]): FetchStub {
  const idToWindow = new Map<string, { since: string; until: string }>();
  let seq = 0;
  return async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const method = (init?.method ?? (typeof input === 'string' ? 'GET' : (input as Request).method)) || 'GET';
    // POST /insights → create the async job (or 5xx if the window is too wide).
    if (method === 'POST' && url.includes('/insights')) {
      const m = /time_range=([^&]+)/.exec(url);
      const { since, until } = JSON.parse(decodeURIComponent(m![1]!)) as { since: string; until: string };
      seenWindows?.push(`${since}..${until}`);
      if (daySpanInclusive(since, until) > maxDays) {
        return makeResponse(500, { error: { message: 'server could not build this report' } });
      }
      const id = `RUN-${++seq}`;
      idToWindow.set(id, { since, until });
      return makeResponse(200, { report_run_id: id });
    }
    // GET /{id}/insights → the completed report's result page.
    const resultsMatch = /\/(RUN-\d+)\/insights/.exec(url);
    if (resultsMatch) {
      const win = idToWindow.get(resultsMatch[1]!)!;
      return makeResponse(200, {
        data: [{ campaign_id: `c_${win.since}_${win.until}`, spend: '1.00', date_start: win.since }],
        paging: {},
      });
    }
    // GET /{id} → poll status (complete immediately).
    if (/\/RUN-\d+(\?|$)/.test(url)) {
      return makeResponse(200, { async_percent_completion: 100, async_status: 'Job Complete' });
    }
    return makeResponse(200, {});
  };
}

describe('MetaInsightsClient.fetchInsightsForWindow — asyncMode drives the async report path', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: false }));
  afterEach(() => vi.useRealTimers());

  it('splits a too-large window on the async path and returns rows from every in-limit sub-window', async () => {
    const seenWindows: string[] = [];
    // Account tolerates ≤15-day windows; a 30-day async POST 500s and must be split — each sub-window is
    // also fetched via the async path (asyncMode threaded down the recursion).
    const client = makeClient(windowAwareAsyncFetch(15, seenWindows), { asyncMode: false, maxRetries: 0 });

    const pending = client.fetchInsightsForWindow('ad', '2026-06-01', '2026-06-30', 'demographic', {
      asyncMode: true,
    });
    await vi.runAllTimersAsync();
    const rows = await pending;

    // 30d → 500 → split into [06-01..06-15] + [06-16..06-30], each 15d and in-limit → one row each.
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.campaign_id).sort()).toEqual(
      ['c_2026-06-01_2026-06-15', 'c_2026-06-16_2026-06-30'],
    );
    // The 30d POST 500s; the two 15d POSTs succeed → the async path was exercised on all three windows.
    expect(seenWindows).toEqual(['2026-06-01..2026-06-30', '2026-06-01..2026-06-15', '2026-06-16..2026-06-30']);
  });

  it('SKIPS (returns []) when a 5xx persists to the 1-day floor on the async path', async () => {
    // Every window — even one day — async-POST 500s: the walk splits to a day, then returns [] so one
    // unservable window never fails the pass (identical floor behaviour to the sync path).
    const client = makeClient(windowAwareAsyncFetch(0), { asyncMode: false, maxRetries: 0 });

    const pending = client.fetchInsightsForWindow('ad', '2026-06-01', '2026-06-02', 'demographic', {
      asyncMode: true,
    });
    await vi.runAllTimersAsync();
    const rows = await pending;

    expect(rows).toEqual([]);
  });
});

// ── 5. Throttle code 80000 triggers backoff ───────────────────────────────────

describe('MetaInsightsClient throttle code 80000 backoff', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: false }));
  afterEach(() => vi.useRealTimers());

  it('backs off on code=80000 then succeeds on retry', async () => {
    let callCount = 0;
    const fetchStub: FetchStub = async () => {
      callCount += 1;
      if (callCount === 1) {
        // First call: throttle with code 80000
        return makeResponse(400, { error: { code: 80000, message: 'throttled' } });
      }
      // Second call: success
      return makeResponse(200, { currency: 'USD', timezone_name: 'UTC' });
    };

    const client = makeClient(fetchStub, { maxRetries: 2 });

    const metaPromise = client.fetchAccountMeta();
    await vi.runAllTimersAsync();
    const result = await metaPromise;

    expect(callCount).toBe(2);
    expect(result.currencyCode).toBe('USD');
  });

  it('throws META_RATE_LIMITED when code=80000 exhausts all retries', async () => {
    const fetchStub: FetchStub = async () =>
      makeResponse(400, { error: { code: 80000, message: 'throttled' } });

    const client = makeClient(fetchStub, { maxRetries: 1 });

    // Register rejection expectation before advancing timers to avoid unhandled rejection.
    const rejectPromise = expect(client.fetchAccountMeta()).rejects.toThrow(META_RATE_LIMITED);
    await vi.runAllTimersAsync();
    await rejectPromise;
  });

  it('backs off on code=4 (platform application request limit)', async () => {
    let callCount = 0;
    const fetchStub: FetchStub = async () => {
      callCount += 1;
      if (callCount === 1) {
        return makeResponse(400, { error: { code: 4, message: 'application limit' } });
      }
      return makeResponse(200, { currency: 'INR', timezone_name: 'Asia/Kolkata' });
    };

    const client = makeClient(fetchStub, { maxRetries: 2 });

    const metaPromise = client.fetchAccountMeta();
    await vi.runAllTimersAsync();
    const result = await metaPromise;

    expect(callCount).toBe(2);
    expect(result.currencyCode).toBe('INR');
  });

  it('backs off when X-Business-Use-Case-Usage header reports call_count=90', async () => {
    let callCount = 0;
    const throttleHeader = JSON.stringify({ '123': [{ call_count: 90, estimated_time_to_regain_access: 5 }] });

    const fetchStub: FetchStub = async () => {
      callCount += 1;
      if (callCount === 1) {
        return makeResponse(200, { currency: 'USD' }, {
          'X-Business-Use-Case-Usage': throttleHeader,
        });
      }
      return makeResponse(200, { currency: 'USD', timezone_name: null });
    };

    const client = makeClient(fetchStub, { maxRetries: 2 });

    // The first response has a 200 status but signals throttle via header.
    // The client should sleep and retry → but the header triggers a THROTTLED signal
    // and the status is 200 (not a throttle status code), so handleThrottleResponse
    // runs the header check branch first.
    const metaPromise = client.fetchAccountMeta();
    await vi.runAllTimersAsync();
    const result = await metaPromise;

    expect(callCount).toBe(2);
    expect(result.currencyCode).toBe('USD');
  });

  it('throws META_AUTH_ERROR on 401', async () => {
    const fetchStub: FetchStub = async () =>
      makeResponse(401, { error: { code: 190, message: 'Invalid token' } });

    const client = makeClient(fetchStub);
    await expect(client.fetchAccountMeta()).rejects.toThrow(META_AUTH_ERROR);
  });

  it('throws META_ACCESS_FORBIDDEN (not auth, not generic) on 403 — the accessible-history boundary', async () => {
    const fetchStub: FetchStub = async () =>
      makeResponse(403, { error: { code: 200, message: 'Permissions error' } });

    const client = makeClient(fetchStub);
    const p = client.fetchAccountMeta();
    await expect(p).rejects.toThrow(META_ACCESS_FORBIDDEN);
    await expect(p).rejects.not.toThrow(META_AUTH_ERROR);
  });
});
