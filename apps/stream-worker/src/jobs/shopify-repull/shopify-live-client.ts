import { log } from "../../log.js";
import { CircuitBreaker } from '@brain/observability';

/**
 * shopify-live-client.ts — Shopify Admin REST client for the live re-pull job.
 *
 * Extends ShopifyBackfillClient for the re-pull use case:
 *   - Adds 'updated_at' to the fields request (required for uuidV5FromOrderLive / D-6)
 *   - Filters by updated_at_min instead of created_at_min
 *   - Pagination is still since_id based (id-ascending walk)
 *
 * The re-pull fetches orders updated in the last 35 days using updated_at_min.
 * Shopify's since_id + status=any still gives us a stable page walk; we just
 * request updated_at in the response to derive the per-state event_id.
 */

export interface ShopifyLiveOrder {
  id: number;
  name: string;
  created_at: string;
  processed_at: string | null;
  updated_at: string;          // Required for uuidV5FromOrderLive (D-6)
  cancelled_at: string | null;
  currency: string;
  current_total_price: string;
  financial_status: string;
  fulfillment_status: string | null;
  gateway?: string | null;
  payment_gateway_names?: string[] | null;
  tags?: string | null;
  customer?: {
    id?: number;
    email?: string | null;
    phone?: string | null;
  } | null;
}

export interface LiveOrdersPage {
  orders: ShopifyLiveOrder[];
  /** next page since_id, or null if no more pages */
  nextSinceId: string | null;
}

const DEFAULT_API_VERSION = '2025-07';

/** T2-9: per-request timeout — a hung Shopify socket aborts instead of stalling the live re-pull. */
const REQUEST_TIMEOUT_MS = 20_000;

export class ShopifyLiveClient {
  private readonly base: string;
  private readonly breaker: CircuitBreaker;

  constructor(
    private readonly shopDomain: string,
    private readonly accessToken: string,  // NEVER logged (I-S09)
    apiVersion: string = process.env['SHOPIFY_API_VERSION'] ?? DEFAULT_API_VERSION,
  ) {
    const host = shopDomain.replace(/^https?:\/\//, '');
    this.base = `https://${host}/admin/api/${apiVersion}`;
    this.breaker = new CircuitBreaker({ name: 'shopify-live', failureThreshold: 5, openMs: 30_000 });
  }

  /**
   * Fetch one page of orders updated since updatedAtMin, using since_id pagination.
   * Includes 'updated_at' in the fields for D-6 live event_id derivation.
   *
   * @param sinceId       Shopify order ID to start after (null = from beginning)
   * @param updatedAtMin  ISO-8601 lower bound for updated_at (35-day window)
   */
  async fetchOrdersPage(
    sinceId: string | null,
    updatedAtMin: string,
  ): Promise<LiveOrdersPage> {
    const fields = [
      'id', 'name', 'created_at', 'processed_at', 'updated_at', 'cancelled_at',
      'currency', 'current_total_price', 'financial_status', 'fulfillment_status',
      'gateway', 'payment_gateway_names', 'tags', 'customer',
    ].join(',');

    // since_id=0 forces id-ascending stable walk (same fix as ShopifyBackfillClient)
    const effectiveSinceId = sinceId ?? '0';
    const query =
      `status=any&limit=250&updated_at_min=${encodeURIComponent(updatedAtMin)}` +
      `&fields=${fields}&since_id=${encodeURIComponent(effectiveSinceId)}`;

    const url = `${this.base}/orders.json?${query}`;

    return this.breaker.fire(async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const res = await fetch(url, {
        headers: {
          'X-Shopify-Access-Token': this.accessToken,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (res.status === 429) {
        const retryAfterHeader = res.headers.get('Retry-After');
        const sleepSec = retryAfterHeader ? parseInt(retryAfterHeader, 10) : 2;
        const sleepMs = Math.max(1000, sleepSec * 1000);
        log.info(`429 rate limited — sleeping ${sleepSec}s (attempt ${attempt + 1}/10)`);
        await sleep(sleepMs);
        continue;
      }

      if (res.status === 401) {
        throw new Error(`SHOPIFY_AUTH_ERROR: 401 Unauthorized from Shopify GET orders`);
      }

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Shopify GET orders → HTTP ${res.status}: ${body.slice(0, 200)}`);
      }

      const body = await res.json() as { orders: ShopifyLiveOrder[] };
      const orders = body.orders ?? [];

      const lastOrder = orders[orders.length - 1];
      const nextSinceId = orders.length === 250 && lastOrder ? String(lastOrder.id) : null;

      return { orders, nextSinceId };
    }

    throw new Error('[shopify-repull] Exceeded max 429 retry attempts on orders page');
    }); // end breaker.fire
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
