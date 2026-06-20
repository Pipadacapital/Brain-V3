/**
 * ShopifyAdminClient — thin Shopify Admin REST client.
 *
 * The first real read-side connector code (seeds the order-sync the M1 ingestion will
 * build on). Kept minimal: shop info, order count, and an orders page. Pagination,
 * retries/backoff, and webhook handling come with the productionized sync.
 *
 * The access token is passed in (resolved from Secrets Manager by the caller) and is
 * NEVER logged (I-S09).
 */

export interface ShopifyShopInfo {
  name: string;
  myshopifyDomain: string;
  currency: string;
  ianaTimezone: string;
  countryCode: string;
  planName: string;
  createdAt: string;
}

/** Raw Shopify order — loosely typed; the spike inspects shape before we model it. */
export type ShopifyOrder = Record<string, unknown>;

const DEFAULT_API_VERSION = '2025-07';

/** T2-9: per-request timeout — a hung Shopify socket aborts instead of stalling the caller forever. */
const REQUEST_TIMEOUT_MS = 20_000;

export class ShopifyAdminClient {
  private readonly base: string;

  constructor(
    private readonly shopDomain: string,
    private readonly accessToken: string,
    apiVersion: string = process.env['SHOPIFY_API_VERSION'] ?? DEFAULT_API_VERSION,
  ) {
    const host = shopDomain.replace(/^https?:\/\//, '');
    this.base = `https://${host}/admin/api/${apiVersion}`;
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      headers: { 'X-Shopify-Access-Token': this.accessToken, 'Content-Type': 'application/json' },
      // T2-9: bound the request so a hung Shopify socket can't stall the caller indefinitely.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) {
      // Do not echo the token; surface status + truncated body for diagnosis.
      throw new Error(`Shopify GET ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return JSON.parse(text) as T;
  }

  async getShop(): Promise<ShopifyShopInfo> {
    const { shop } = await this.get<{ shop: Record<string, string> }>('/shop.json');
    return {
      name: shop['name'] ?? '',
      myshopifyDomain: shop['myshopify_domain'] ?? this.shopDomain,
      currency: shop['currency'] ?? '',
      ianaTimezone: shop['iana_timezone'] ?? '',
      countryCode: shop['country_code'] ?? '',
      planName: shop['plan_display_name'] ?? '',
      createdAt: shop['created_at'] ?? '',
    };
  }

  /** Total order count including cancelled/archived (status=any). */
  async countOrders(): Promise<number> {
    const { count } = await this.get<{ count: number }>('/orders/count.json?status=any');
    return count;
  }

  /** One page of recent orders (newest first), status=any. */
  async getOrders(limit = 50): Promise<ShopifyOrder[]> {
    const fields = [
      'id', 'name', 'created_at', 'processed_at', 'updated_at', 'cancelled_at',
      'currency', 'current_total_price', 'total_price', 'subtotal_price', 'total_tax',
      'financial_status', 'fulfillment_status', 'gateway', 'payment_gateway_names',
      'tags', 'test', 'refunds', 'customer',
    ].join(',');
    const { orders } = await this.get<{ orders: ShopifyOrder[] }>(
      `/orders.json?status=any&limit=${limit}&fields=${fields}`,
    );
    return orders;
  }
}
