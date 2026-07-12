import { log } from "../../log.js";
import { CircuitBreaker } from '@brain/observability';

/**
 * razorpay-settlements-client.ts — Razorpay Settlements API client (ADR-RZ-4).
 *
 * Mirrors shopify-live-client.ts: paged, rate-limit-aware.
 *   - Auth: key_id:key_secret Basic auth (Razorpay standard)
 *   - Rate limit: Razorpay returns 429 → back-off Retry-After header (or 2s default)
 *   - NEVER logs raw API response body (C5)
 *   - NEVER logs key_id or key_secret (I-S09)
 *
 * Endpoints:
 *   - /v1/settlements/recon/combined — per-payment breakdown with all settlement fields
 *     (settlement_id, payment_id, order_id, amount, fee, tax, settlement_utr, type, etc.)
 *   - /v1/settlements — summary-level settlements list (for reserve/adjustment batch events)
 *
 * All amounts returned by Razorpay are already integer paisa (no decimal conversion needed).
 * The mapper (mapSettlementItemToEvent) applies the field allowlist + boundary hash.
 *
 * QUERY SHAPE (audit fix, razorpay.com/docs/api/settlements/fetch-recon — verified 2026-07-12):
 *   recon/combined does NOT accept from/to Unix-timestamp params. The documented params are:
 *     year  (required, YYYY)  — "The year the settlement was received"
 *     month (required, MM)    — "The month the settlement was received"
 *     day   (optional, DD)    — "The date on which the settlement was received"
 *     count (optional, 1-1000) + skip (offset pagination)
 *   The previous from/to shape silently returned nothing useful. Callers still think in
 *   [fromTs, toTs] Unix windows (cursor + backfill lanes), so this client WALKS the calendar
 *   months covering the window (IST — Razorpay settles in Asia/Kolkata), pages each month via
 *   skip offsets, and filters items client-side to settled_at/created_at ∈ [fromTs, toTs].
 *   The month walk is padded ±1 day so timezone bucketing skew can never drop a boundary item;
 *   the exact client-side window filter keeps output identical to the old contract.
 */

export interface RazorpayApiCredentials {
  keyId: string;      // NEVER logged (I-S09)
  keySecret: string;  // NEVER logged (I-S09)
}

/** Raw item from /v1/settlements/recon/combined — allowlist applied in mapper */
export interface RazorpayReconItem {
  settlement_id?: string | null;
  payment_id?: string | null;
  order_id?: string | null;
  amount?: number | null;
  fee?: number | null;
  tax?: number | null;
  /** Recon items carry the UTR as settlement_utr (docs); utr kept for legacy/summary shapes. */
  utr?: string | null;
  settlement_utr?: string | null;
  status?: string | null;
  created_at?: number | null;    // Unix timestamp
  settled_at?: number | null;    // Unix timestamp
  currency?: string | null;
  /** Docs field name is `type` (payment|refund|transfer|adjustment); entity_type kept for legacy shapes. */
  type?: string | null;
  entity_type?: string | null;
  debit?: number | null;         // paisa integer — payout debit leg
  credit?: number | null;        // paisa integer — payout credit leg
  on_hold?: boolean | number | null;
  settled?: boolean | number | null;
  // card.* and other fields will be present — mapper drops them all (C4)
  [key: string]: unknown;
}

export interface SettlementsPage {
  items: RazorpayReconItem[];
  /** true if there may be more pages (items.length === PAGE_SIZE) */
  hasMore: boolean;
}

/** One recon calendar bucket (IST) the window walk queries. */
export interface ReconMonth {
  year: number;
  month: number; // 1-12
}

const PAGE_SIZE = 100;   // recon/combined count param (docs allow 1-1000; 100 kept for parity)
const RAZORPAY_API_BASE = 'https://api.razorpay.com/v1';

/** T2-9: per-request timeout — a hung Razorpay socket aborts instead of stalling the settlement re-pull. */
const REQUEST_TIMEOUT_MS = 30_000;

/** Razorpay settles in IST (Asia/Kolkata, fixed +05:30) — recon year/month/day buckets follow it. */
const IST_OFFSET_SECONDS = 19_800;

/** ±1 day pad on the month walk — timezone bucketing skew can never drop a boundary item. */
const WINDOW_PAD_SECONDS = 86_400;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Enumerate the IST calendar months (year, month) whose recon buckets can contain items
 * settled within [fromTs, toTs] (Unix seconds). Padded ±1 day for bucketing-skew safety.
 * Exported for unit tests.
 */
export function reconMonthsForWindow(fromTs: number, toTs: number): ReconMonth[] {
  const startDate = new Date((fromTs - WINDOW_PAD_SECONDS + IST_OFFSET_SECONDS) * 1000);
  const endDate = new Date((toTs + WINDOW_PAD_SECONDS + IST_OFFSET_SECONDS) * 1000);

  const months: ReconMonth[] = [];
  let year = startDate.getUTCFullYear();
  let month = startDate.getUTCMonth() + 1;
  const endYear = endDate.getUTCFullYear();
  const endMonth = endDate.getUTCMonth() + 1;

  while (year < endYear || (year === endYear && month <= endMonth)) {
    months.push({ year, month });
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

/**
 * Window filter for a recon item: settled_at (fallback created_at) ∈ [fromTs, toTs].
 * Items with NO usable timestamp are KEPT (no event loss — deterministic event_ids
 * dedupe any resulting overlap in Bronze). Exported for unit tests.
 */
export function reconItemWithinWindow(item: RazorpayReconItem, fromTs: number, toTs: number): boolean {
  const raw = item.settled_at ?? item.created_at;
  const ts = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(ts)) return true;
  return ts >= fromTs && ts <= toTs;
}

export class RazorpaySettlementsClient {
  private readonly authHeader: string;
  private readonly breaker: CircuitBreaker;

  /**
   * @param credentials  key_id + key_secret — NEVER logged (I-S09)
   */
  constructor(credentials: RazorpayApiCredentials) {
    // Basic auth: base64(key_id:key_secret) — credentials stay in memory only
    const encoded = Buffer.from(`${credentials.keyId}:${credentials.keySecret}`, 'utf8').toString('base64');
    this.authHeader = `Basic ${encoded}`;
    // credentials object DROPPED here — raw values don't escape this scope
    this.breaker = new CircuitBreaker({ name: 'razorpay', failureThreshold: 5, openMs: 60_000 });
  }

  /**
   * Fetch one page of settlement reconciliation items for ONE documented calendar bucket.
   * Sends the DOCUMENTED query shape: year (YYYY) + month (MM) [+ day (DD)] + count + skip.
   *
   * NEVER logs response body (C5).
   *
   * @param year   Settlement year, YYYY (required by the API)
   * @param month  Settlement month, 1-12 (required by the API)
   * @param skip   Pagination offset (0-indexed; increment by PAGE_SIZE)
   * @param day    Optional settlement day-of-month, 1-31
   */
  async fetchReconMonthPage(year: number, month: number, skip = 0, day?: number): Promise<SettlementsPage> {
    const dayParam = day !== undefined ? `&day=${day}` : '';
    const url =
      `${RAZORPAY_API_BASE}/settlements/recon/combined` +
      `?year=${year}&month=${month}${dayParam}&count=${PAGE_SIZE}&skip=${skip}`;

    return this.breaker.fire(async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const res = await fetch(url, {
        headers: {
          Authorization: this.authHeader,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (res.status === 429) {
        const retryAfterHeader = res.headers.get('Retry-After');
        const sleepSec = retryAfterHeader ? parseInt(retryAfterHeader, 10) : 2;
        const sleepMs = Math.max(1000, sleepSec * 1000);
        // Log the rate-limit event — but NOT the URL (contains no PII; safe to log path only)
        log.info(`429 rate limited recon — sleeping ${sleepSec}s (attempt ${attempt + 1}/10)`);
        await sleep(sleepMs);
        continue;
      }

      if (res.status === 401) {
        throw new Error(`RAZORPAY_AUTH_ERROR: 401 Unauthorized from Razorpay settlements recon`);
      }

      if (!res.ok) {
        // Log HTTP status but NOT response body (may contain PII or raw IDs — C5)
        throw new Error(`[razorpay-settlements-client] recon HTTP ${res.status}`);
      }

      // Response body parsed in memory — never persisted / never logged (C5)
      const body = await res.json() as { items?: RazorpayReconItem[]; count?: number };
      const items = body.items ?? [];

      return {
        items,
        hasMore: items.length === PAGE_SIZE,
      };
    }

    throw new Error('[razorpay-settlements-client] Exceeded max 429 retry attempts on recon page');
    }); // end breaker.fire
  }

  /**
   * Stream all recon pages whose items fall in [fromTs, toTs] (Unix seconds).
   * Walks the IST calendar months covering the window (documented year/month query shape),
   * pages each month via skip offsets, and yields only the items inside the exact window.
   * Empty (fully-filtered) pages are not yielded.
   *
   * @param fromTs  Unix timestamp (seconds) — start of the query window
   * @param toTs    Unix timestamp (seconds) — end of the query window
   */
  async *fetchReconWindowPages(fromTs: number, toTs: number): AsyncGenerator<SettlementsPage, void, undefined> {
    for (const { year, month } of reconMonthsForWindow(fromTs, toTs)) {
      let skip = 0;
      while (true) {
        const page = await this.fetchReconMonthPage(year, month, skip);
        const items = page.items.filter((item) => reconItemWithinWindow(item, fromTs, toTs));
        if (items.length > 0) {
          yield { items, hasMore: page.hasMore };
        }
        if (!page.hasMore) break;
        skip += PAGE_SIZE;

        // Rate-limit courtesy: minimal sleep between pages (not required but polite)
        await sleep(100);
      }
    }
  }

  /**
   * Fetch all recon items for a given time window (all months, all skip offsets).
   * Returns a flat array of all items. For very large windows (reserves 180d),
   * callers should sub-divide the window to avoid excessive memory.
   *
   * @param fromTs  Unix timestamp (seconds) — start of window
   * @param toTs    Unix timestamp (seconds) — end of window
   */
  async fetchAllReconItems(fromTs: number, toTs: number): Promise<RazorpayReconItem[]> {
    const allItems: RazorpayReconItem[] = [];
    for await (const page of this.fetchReconWindowPages(fromTs, toTs)) {
      allItems.push(...page.items);
    }
    return allItems;
  }
}
