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
 *     (settlement_id, payment_id, order_id, amount, fee, tax, utr, entity_type, etc.)
 *   - /v1/settlements — summary-level settlements list (for reserve/adjustment batch events)
 *
 * All amounts returned by Razorpay are already integer paisa (no decimal conversion needed).
 * The mapper (mapSettlementItemToEvent) applies the field allowlist + boundary hash.
 *
 * Pagination: Razorpay uses from/to (Unix timestamps) + skip/count (offset pagination).
 *   count=100 per page (Razorpay max for recon/combined is 100).
 *   Iterate: skip=0, 100, 200, ... until items.length < count.
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
  utr?: string | null;
  status?: string | null;
  created_at?: number | null;    // Unix timestamp
  settled_at?: number | null;    // Unix timestamp
  currency?: string | null;
  entity_type?: string | null;
  // card.* and other fields will be present — mapper drops them all (C4)
  [key: string]: unknown;
}

export interface SettlementsPage {
  items: RazorpayReconItem[];
  /** true if there may be more pages (items.length === PAGE_SIZE) */
  hasMore: boolean;
}

const PAGE_SIZE = 100;   // Razorpay max for recon/combined
const RAZORPAY_API_BASE = 'https://api.razorpay.com/v1';

/** T2-9: per-request timeout — a hung Razorpay socket aborts instead of stalling the settlement re-pull. */
const REQUEST_TIMEOUT_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
   * Fetch one page of settlement reconciliation items (per-payment breakdown).
   * Uses /v1/settlements/recon/combined with from/to time range + skip offset.
   *
   * NEVER logs response body (C5).
   *
   * @param fromTs    Unix timestamp (seconds) — start of the query window
   * @param toTs      Unix timestamp (seconds) — end of the query window
   * @param skip      Pagination offset (0-indexed; increment by PAGE_SIZE)
   */
  async fetchReconPage(fromTs: number, toTs: number, skip = 0): Promise<SettlementsPage> {
    const url =
      `${RAZORPAY_API_BASE}/settlements/recon/combined` +
      `?from=${fromTs}&to=${toTs}&count=${PAGE_SIZE}&skip=${skip}`;

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
   * Fetch all recon items for a given time window, paging through all skip offsets.
   * Returns a flat array of all items. For very large windows (reserves 180d),
   * callers should sub-divide the window to avoid excessive memory.
   *
   * @param fromTs  Unix timestamp (seconds) — start of window
   * @param toTs    Unix timestamp (seconds) — end of window
   */
  async fetchAllReconItems(fromTs: number, toTs: number): Promise<RazorpayReconItem[]> {
    const allItems: RazorpayReconItem[] = [];
    let skip = 0;

    while (true) {
      const page = await this.fetchReconPage(fromTs, toTs, skip);
      allItems.push(...page.items);

      if (!page.hasMore) break;

      skip += PAGE_SIZE;

      // Rate-limit courtesy: minimal sleep between pages (not required but polite)
      await sleep(100);
    }

    return allItems;
  }
}
