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

/** Carries the HTTP status so callers can branch (e.g. 403 → missing scope → reconnect required). */
export class ShopifyApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ShopifyApiError';
  }
}

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
      // Do not echo the token; surface status + truncated body for diagnosis. ShopifyApiError
      // carries the status so callers can branch (e.g. 403 missing-scope → reconnect required).
      throw new ShopifyApiError(res.status, `Shopify GET ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return JSON.parse(text) as T;
  }

  /** POST helper — same token + timeout discipline as get(); surfaces status + truncated body. */
  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': this.accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new ShopifyApiError(res.status, `Shopify POST ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return JSON.parse(text) as T;
  }

  // ── Pixel install: ScriptTag API (online-store injection) ─────────────────────
  // ScriptTags inject a <script src> into the online storefront on page load — no manual
  // theme edit. (They do NOT run on checkout/thank-you; the Web Pixels path below covers those.)

  /** List Brain-owned ScriptTags (those whose src points at our pixel asset). Idempotency source. */
  async listScriptTags(): Promise<Array<{ id: number; src: string }>> {
    const { script_tags } = await this.get<{ script_tags: Array<{ id: number; src: string }> }>(
      '/script_tags.json?limit=250',
    );
    return script_tags ?? [];
  }

  /** Create an onload ScriptTag for the given pixel src. Requires the write_script_tags scope. */
  async createScriptTag(src: string): Promise<{ id: number; src: string }> {
    const { script_tag } = await this.post<{ script_tag: { id: number; src: string } }>(
      '/script_tags.json',
      { script_tag: { event: 'onload', src, display_scope: 'online_store' } },
    );
    return script_tag;
  }

  /** Remove a ScriptTag (uninstall). Best-effort — 404 (already gone) is treated as success. */
  async deleteScriptTag(id: number): Promise<void> {
    const res = await fetch(`${this.base}/script_tags/${id}.json`, {
      method: 'DELETE',
      headers: { 'X-Shopify-Access-Token': this.accessToken },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok && res.status !== 404) {
      const t = await res.text().catch(() => '');
      throw new ShopifyApiError(res.status, `Shopify DELETE script_tag ${id} → HTTP ${res.status}: ${t.slice(0, 200)}`);
    }
  }

  // ── Pixel install: Web Pixels API (storefront + CHECKOUT coverage) ────────────
  // The modern, sandboxed path. Activates the app's web-pixel extension per-merchant with
  // settings (install_token, ingest URL). Requires the extension to be DEPLOYED to the Shopify
  // app (`shopify app deploy`) + the write_pixels scope — see extensions/brain-web-pixel.

  /** Activate the app's Web Pixel with per-brand settings. GraphQL Admin API. */
  async webPixelCreate(settings: Record<string, string>): Promise<{ id: string }> {
    const query =
      'mutation webPixelCreate($webPixel: WebPixelInput!) {' +
      ' webPixelCreate(webPixel: $webPixel) {' +
      ' webPixel { id } userErrors { field message } } }';
    const res = await this.post<{
      data?: { webPixelCreate?: { webPixel?: { id: string }; userErrors?: Array<{ message: string }> } };
      errors?: Array<{ message: string }>;
    }>(`/graphql.json`, { query, variables: { webPixel: { settings: JSON.stringify(settings) } } });
    const top = res.errors?.[0]?.message;
    if (top) throw new ShopifyApiError(200, `Shopify webPixelCreate GraphQL error: ${top}`);
    const userErr = res.data?.webPixelCreate?.userErrors?.[0]?.message;
    if (userErr) throw new ShopifyApiError(422, `Shopify webPixelCreate userError: ${userErr}`);
    const id = res.data?.webPixelCreate?.webPixel?.id;
    if (!id) throw new ShopifyApiError(500, 'Shopify webPixelCreate returned no id (extension deployed?)');
    return { id };
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
