/**
 * woocommerce-client.ts — WooCommerce REST order read client.
 *
 * Two source modes (the established dev=fixture / prod=HTTP posture, like gokwik/shiprocket):
 *   - LIVE (NODE_ENV=production OR WOOCOMMERCE_LIVE=1): real HTTP against the store's wc/v3 REST
 *     API — GET {site_url}/wp-json/wc/v3/orders, Basic base64(consumer_key:consumer_secret) over
 *     HTTPS, paged by page/per_page with the X-WP-TotalPages header, incremental via modified_after
 *     (dates_are_gmt). Emits data_source='real'. On 401/403 throws WOOCOMMERCE_AUTH_ERROR so the
 *     repull records a reconnect signal (parity with shopify/shiprocket).
 *   - DEV (default): reads the labelled SYNTHETIC fixture (_fixtures/woocommerce/woocommerce-orders.json),
 *     data_source='synthetic'. The cursor / order.live.v1 mapping / ledger semantics are identical;
 *     only the SOURCE differs. WOOCOMMERCE_FIXTURE_PATH overrides the fixture (e2e now-relative dates).
 *
 * The wc/v3 order JSON IS the WooOrderShape the mapper consumes (date_created_gmt/date_modified_gmt/
 * total/line_items/billing/refunds/coupon_lines …) — no transform at the client edge.
 *
 * Retry-backoff (live mode): 429 and 5xx transient errors are retried with exponential back-off +
 * jitter (up to MAX_RETRIES attempts). 429 uses Retry-After if present; 5xx uses exponential delay.
 * 401/403 skip retries and throw WOOCOMMERCE_AUTH_ERROR immediately (reconnect signal, parity with
 * shopify/shiprocket). Non-retriable 4xx throw immediately.
 *
 * NEVER logs consumer_key/consumer_secret (I-S09) or raw customer PII (hashed in the mapper).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { WooOrderShape, DataSource } from '@brain/woocommerce-mapper';
import { loadStreamWorkerConfig } from '@brain/config';
import { log } from '../../log.js';

export const WOOCOMMERCE_AUTH_ERROR = 'WOOCOMMERCE_AUTH_ERROR';

export interface WooCommerceApiCredentials {
  consumer_key: string;    // NEVER logged (I-S09)
  consumer_secret: string; // NEVER logged (I-S09)
  site_url: string;
}

export interface WooOrderPage {
  orders: WooOrderShape[];
  hasMore: boolean;
  dataSource: DataSource;
}

const PAGE_SIZE = 100; // WooCommerce REST per_page max

/** Maximum retry attempts for 429/5xx transient errors (live mode only). */
const MAX_RETRIES = 4;
/** Base backoff delay in ms; doubles on each attempt (exponential + jitter). */
const BASE_BACKOFF_MS = 500;

/** Live HTTP mode when explicitly in production or opted in via WOOCOMMERCE_LIVE=1. */
function isLiveMode(): boolean {
  return process.env['NODE_ENV'] === 'production' || process.env['WOOCOMMERCE_LIVE'] === '1';
}

/**
 * Classify an HTTP status for retry eligibility.
 *   - 401/403 → auth failure (throw immediately, no retry).
 *   - 429     → rate-limited (retry after Retry-After header or exponential back-off).
 *   - 5xx     → transient server error (retry with exponential back-off).
 *   - other   → non-retriable (throw immediately).
 */
function shouldRetry(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * Compute backoff delay in ms for attempt `n` (0-indexed).
 * Uses exponential growth (BASE_BACKOFF_MS * 2^n) plus ±20% random jitter.
 * If the server provides a Retry-After header (for 429), that takes precedence.
 */
function backoffDelayMs(attempt: number, retryAfterHeader: string | null): number {
  if (retryAfterHeader) {
    const parsed = parseFloat(retryAfterHeader);
    if (Number.isFinite(parsed) && parsed > 0) return Math.ceil(parsed * 1000);
  }
  const base = BASE_BACKOFF_MS * Math.pow(2, attempt);
  const jitter = base * 0.2 * (Math.random() * 2 - 1);
  return Math.round(base + jitter);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURE_PATH = join(__dirname, '..', '_fixtures', 'woocommerce', 'woocommerce-orders.json');

function fixturePath(): string {
  return loadStreamWorkerConfig().WOOCOMMERCE_FIXTURE_PATH ?? DEFAULT_FIXTURE_PATH;
}

interface OrdersFixtureFile {
  _synthetic?: boolean;
  orders: WooOrderShape[];
}

export class WooCommerceClient {
  private readonly live: boolean;
  private readonly creds: WooCommerceApiCredentials;
  private readonly authHeader: string;
  private readonly baseUrl: string;
  private fixtureOrders: WooOrderShape[] | null = null;

  constructor(credentials: WooCommerceApiCredentials) {
    this.creds = credentials;
    this.live = isLiveMode();
    // Basic auth: base64(consumer_key:consumer_secret). Held in memory only (I-S09).
    this.authHeader =
      'Basic ' + Buffer.from(`${credentials.consumer_key}:${credentials.consumer_secret}`).toString('base64');
    this.baseUrl = (credentials.site_url ?? '').replace(/\/+$/, '');
  }

  /**
   * Fetch one page of orders modified at/after `modifiedAfterIso` (ascending by modified date).
   *
   * @param modifiedAfterIso  ISO lower bound on date_modified (GMT)
   * @param page              1-based page number
   */
  async fetchOrdersPage(modifiedAfterIso: string, page = 1): Promise<WooOrderPage> {
    return this.live
      ? this.fetchOrdersPageLive(modifiedAfterIso, page)
      : this.fetchOrdersPageFixture(modifiedAfterIso, page);
  }

  // ── LIVE: real wc/v3 REST read (with 429/5xx retry-backoff) ─────────────
  private async fetchOrdersPageLive(modifiedAfterIso: string, page: number): Promise<WooOrderPage> {
    if (!this.baseUrl) {
      throw new Error(`${WOOCOMMERCE_AUTH_ERROR}: site_url missing for WooCommerce live read`);
    }
    const url =
      `${this.baseUrl}/wp-json/wc/v3/orders` +
      `?per_page=${PAGE_SIZE}&page=${page}` +
      `&orderby=modified&order=asc&dates_are_gmt=true` +
      `&modified_after=${encodeURIComponent(modifiedAfterIso)}`;

    let lastErr: Error = new Error('no attempts made');
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        // We only reach here on a retriable status from the previous attempt. The last
        // response's Retry-After is carried via lastErr.message — parse it back out.
        const retryAfterMatch = lastErr.message.match(/retry-after=(\S+)/);
        const retryAfterHeader = retryAfterMatch ? retryAfterMatch[1]! : null;
        const delay = backoffDelayMs(attempt - 1, retryAfterHeader);
        log.warn(`[woocommerce-client] attempt=${attempt} page=${page} backing off ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
      }

      let res: Response;
      try {
        res = await fetch(url, {
          method: 'GET',
          headers: { Authorization: this.authHeader, Accept: 'application/json' },
        });
      } catch (err) {
        // Network-level error (no response). Never include credentials in the message (I-S09).
        throw new Error(`${WOOCOMMERCE_AUTH_ERROR}: orders request failed: ${String(err)}`);
      }

      // Auth failure → throw immediately (reconnect signal, no retry).
      if (res.status === 401 || res.status === 403) {
        throw new Error(`${WOOCOMMERCE_AUTH_ERROR}: orders rejected (${res.status})`);
      }

      // 429 / 5xx → record and retry if attempts remain.
      if (!res.ok && shouldRetry(res.status)) {
        const retryAfter = res.headers.get('retry-after') ?? null;
        lastErr = new Error(
          `woocommerce orders fetch transient (${res.status})${retryAfter ? ` retry-after=${retryAfter}` : ''}`,
        );
        if (attempt < MAX_RETRIES) continue;
        // Exhausted retries.
        throw lastErr;
      }

      // Non-retriable 4xx error (not auth) → throw immediately.
      if (!res.ok) {
        throw new Error(`woocommerce orders fetch failed (${res.status})`);
      }

      const orders = (await res.json()) as WooOrderShape[];
      // X-WP-TotalPages drives pagination; fall back to "full page ⇒ maybe more".
      const totalPagesHeader = res.headers.get('x-wp-totalpages');
      const totalPages = totalPagesHeader ? parseInt(totalPagesHeader, 10) : NaN;
      const hasMore = Number.isFinite(totalPages)
        ? page < totalPages
        : Array.isArray(orders) && orders.length === PAGE_SIZE;

      log.info(`[woocommerce-client] live page=${page} orders=${Array.isArray(orders) ? orders.length : 0} totalPages=${totalPagesHeader ?? '?'}`);
      return { orders: Array.isArray(orders) ? orders : [], hasMore, dataSource: 'real' };
    }

    // Should be unreachable (loop throws before falling through).
    throw lastErr;
  }

  /**
   * Resolve the store's ISO-4217 currency — the single sibling every catalogue/customer/coupon money
   * field is denominated in (MONEY FIX: never hardcoded, never an INR default).
   *
   *   - LIVE: GET {site_url}/wp-json/wc/v3/settings/general → the `woocommerce_currency` setting's
   *     value (e.g. "INR" / "JPY" / "KWD"). A 401/403 throws WOOCOMMERCE_AUTH_ERROR (reconnect
   *     signal); any other failure returns null (the caller fails closed — money degrades to null,
   *     never blends).
   *   - DEV: derive from the synthetic orders fixture's first order currency (the store currency the
   *     fixture transacts in), so the dev path is currency-honest without a separate config key.
   *
   * Returns an UPPERCASE ISO code, or null when it cannot be resolved.
   */
  async fetchStoreCurrency(): Promise<string | null> {
    if (!this.live) {
      const order = this.loadFixture().find((o) => (o.currency ?? '').trim() !== '');
      const code = (order?.currency ?? '').trim().toUpperCase();
      return code || null;
    }
    if (!this.baseUrl) return null;
    const url = `${this.baseUrl}/wp-json/wc/v3/settings/general`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: { Authorization: this.authHeader, Accept: 'application/json' },
      });
    } catch (err) {
      log.warn(`[woocommerce-client] store-currency request failed: ${String(err)}`);
      return null;
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(`${WOOCOMMERCE_AUTH_ERROR}: settings rejected (${res.status})`);
    }
    if (!res.ok) {
      log.warn(`[woocommerce-client] store-currency fetch failed (${res.status})`);
      return null;
    }
    try {
      const settings = (await res.json()) as Array<{ id?: string; value?: unknown }>;
      const row = Array.isArray(settings) ? settings.find((s) => s.id === 'woocommerce_currency') : undefined;
      const code = typeof row?.value === 'string' ? row.value.trim().toUpperCase() : '';
      return code || null;
    } catch {
      return null;
    }
  }

  // ── DEV: synthetic fixture ────────────────────────────────────────────────
  private loadFixture(): WooOrderShape[] {
    if (this.fixtureOrders !== null) return this.fixtureOrders;
    let orders: WooOrderShape[] = [];
    try {
      const raw = readFileSync(fixturePath(), 'utf8');
      const parsed = JSON.parse(raw) as OrdersFixtureFile;
      orders = Array.isArray(parsed.orders) ? parsed.orders : [];
    } catch (err) {
      log.warn(`could not read synthetic WooCommerce fixture — empty source: ${String(err)}`);
    }
    this.fixtureOrders = orders;
    return orders;
  }

  private fetchOrdersPageFixture(modifiedAfterIso: string, page: number): Promise<WooOrderPage> {
    const afterMs = Date.parse(modifiedAfterIso);
    const eligible = this.loadFixture()
      .filter((o) => {
        const m = o.date_modified_gmt ?? o.date_created_gmt ?? null;
        if (!m) return false;
        const hasTz = /[zZ]$/.test(m) || /[+-]\d{2}:?\d{2}$/.test(m);
        const ms = Date.parse(hasTz ? m : `${m}Z`);
        return !Number.isNaN(ms) && ms >= afterMs;
      })
      .sort((a, b) => {
        const am = Date.parse((a.date_modified_gmt ?? a.date_created_gmt ?? '') + 'Z');
        const bm = Date.parse((b.date_modified_gmt ?? b.date_created_gmt ?? '') + 'Z');
        return am - bm;
      });

    const start = (page - 1) * PAGE_SIZE;
    const slice = eligible.slice(start, start + PAGE_SIZE);
    return Promise.resolve({
      orders: slice,
      hasMore: start + PAGE_SIZE < eligible.length,
      dataSource: 'synthetic',
    });
  }
}

export { PAGE_SIZE as WOOCOMMERCE_PAGE_SIZE, MAX_RETRIES as WOOCOMMERCE_MAX_RETRIES };
