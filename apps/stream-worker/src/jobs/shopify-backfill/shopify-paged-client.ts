/**
 * shopify-paged-client.ts — Shopify Admin REST client for backfill (ADR-BF-6 / D-14 / IR-2).
 *
 * Extends the ShopifyAdminClient pattern for backfill-specific pagination:
 *   - since_id + Link header pagination (D-14 — more stable than date-range pagination)
 *   - limit=250 (max — IR-2: under-batching was the gap in the existing client)
 *   - created_at_min filter (24-month window for count denominator / depth bound)
 *   - 429 → Retry-After header extraction + sleep (IR-2 / D-14)
 *   - 401 → caller handles (SP-3: mark job failed, checkpoint cursor)
 *
 * This is NOT a general Shopify client — it is scoped to the backfill job's
 * order-history pagination. It is self-contained so it can be instantiated in
 * the worker without importing from apps/core.
 *
 * Security: the access token is NEVER logged (I-S09). It is held in the constructor
 * and used only in the X-Shopify-Access-Token header.
 */

export interface ShopifyBackfillOrder {
  id: number;
  name: string;
  created_at: string;
  processed_at: string | null;
  cancelled_at: string | null;
  currency: string;
  current_total_price: string;  // decimal string (e.g. "1250.00")
  financial_status: string;
  fulfillment_status: string | null;
  gateway: string | null;
  payment_gateway_names: string[] | null;
  // customer field — consumed for PII hashing then DROPPED at worker boundary (D-10)
  customer?: {
    id?: number;
    email?: string;
    phone?: string;
  } | null;
  tags: string | null;
}

export interface OrdersPage {
  orders: ShopifyBackfillOrder[];
  /** next page since_id (last order ID on this page), or null if no more pages */
  nextSinceId: string | null;
}

const DEFAULT_API_VERSION = '2025-07';

export class ShopifyBackfillClient {
  private readonly base: string;

  /**
   * @param shopDomain    Shopify shop domain (e.g. mystore.myshopify.com)
   * @param accessToken   OAuth access token — NEVER logged (I-S09)
   * @param apiVersion    Shopify API version (default: 2025-07)
   */
  constructor(
    private readonly shopDomain: string,
    private readonly accessToken: string,
    apiVersion: string = process.env['SHOPIFY_API_VERSION'] ?? DEFAULT_API_VERSION,
  ) {
    const host = shopDomain.replace(/^https?:\/\//, '');
    this.base = `https://${host}/admin/api/${apiVersion}`;
  }

  /**
   * Count orders with status=any and created_at_min filter (D-8).
   * Used to set estimated_total before the page loop starts.
   * Returns null on any error (honesty: show "Collecting..." not 0 — HP-1).
   */
  async countOrders(createdAtMin: string): Promise<number | null> {
    const url = `${this.base}/orders/count.json?status=any&created_at_min=${encodeURIComponent(createdAtMin)}`;
    try {
      const res = await fetch(url, {
        headers: {
          'X-Shopify-Access-Token': this.accessToken,
          'Content-Type': 'application/json',
        },
      });
      if (res.status === 429) {
        // Rate limited on count — return null (HP-1: never fabricate)
        return null;
      }
      if (!res.ok) {
        return null;
      }
      const body = await res.json() as { count: number };
      return body.count;
    } catch {
      // Network error on count — return null (HP-1)
      return null;
    }
  }

  /**
   * Fetch one page of orders using since_id + Link header pagination (D-14).
   *
   * @param sinceId        Shopify order ID to start after (null = from beginning of window)
   * @param createdAtMin   ISO-8601 lower bound for created_at (24-month window)
   * @returns              { orders, nextSinceId } — nextSinceId is null if no more pages
   *
   * @throws Error with status=401 message on Shopify auth error (SP-3: caller marks job failed)
   * @throws Error on 5xx or other unrecoverable errors (caller retries up to MAX_RETRY)
   *
   * On 429: sleeps for Retry-After seconds and retries the SAME page (IR-2 / D-14).
   * Retry-After is extracted from the response header; fallback = 2 seconds.
   */
  async fetchOrdersPage(
    sinceId: string | null,
    createdAtMin: string,
  ): Promise<OrdersPage> {
    const fields = [
      'id', 'name', 'created_at', 'processed_at', 'cancelled_at',
      'currency', 'current_total_price', 'financial_status', 'fulfillment_status',
      'gateway', 'payment_gateway_names', 'tags', 'customer',
    ].join(',');

    // since_id pagination orders by id ASC. Page 1 MUST start at since_id=0 (not omit it) — if
    // omitted, Shopify returns the page in its default order (newest-first), and since_id=last-id
    // then can't advance, so pagination stalls after ~2 pages (the 499-of-10009 bug). Starting at 0
    // forces a stable id-ascending walk through the whole result set.
    const effectiveSinceId = sinceId ?? '0';
    const query =
      `status=any&limit=250&created_at_min=${encodeURIComponent(createdAtMin)}` +
      `&fields=${fields}&since_id=${encodeURIComponent(effectiveSinceId)}`;

    const url = `${this.base}/orders.json?${query}`;

    // Retry loop for 429 rate-limit handling (IR-2 / D-14)
    for (let attempt = 0; attempt < 10; attempt++) {
      const res = await fetch(url, {
        headers: {
          'X-Shopify-Access-Token': this.accessToken,
          'Content-Type': 'application/json',
        },
      });

      if (res.status === 429) {
        // Extract Retry-After header (integer seconds); fallback = 2s (IR-2)
        const retryAfterHeader = res.headers.get('Retry-After');
        const sleepSec = retryAfterHeader ? parseInt(retryAfterHeader, 10) : 2;
        const sleepMs = Math.max(1000, sleepSec * 1000);
        console.info(
          `[shopify-backfill] 429 rate limited — sleeping ${sleepSec}s (attempt ${attempt + 1}/10)`,
        );
        await sleep(sleepMs);
        continue; // retry same page
      }

      if (res.status === 401) {
        // Auth error — caller must mark job failed + checkpoint (SP-3)
        throw new Error(`SHOPIFY_AUTH_ERROR: 401 Unauthorized from Shopify GET orders`);
      }

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(
          `Shopify GET orders → HTTP ${res.status}: ${body.slice(0, 200)}`,
        );
      }

      const body = await res.json() as { orders: ShopifyBackfillOrder[] };
      const orders = body.orders ?? [];

      // Determine next since_id from the last order in this page
      // (per Shopify docs: next page uses since_id = last order's id)
      const lastOrder = orders[orders.length - 1];
      const nextSinceId = orders.length === 250 && lastOrder
        ? String(lastOrder.id)
        : null;

      return { orders, nextSinceId };
    }

    throw new Error('[shopify-backfill] Exceeded max 429 retry attempts on orders page');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
