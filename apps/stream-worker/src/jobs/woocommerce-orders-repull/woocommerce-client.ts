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
 * NEVER logs consumer_key/consumer_secret (I-S09) or raw customer PII (hashed in the mapper).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { WooOrderShape, DataSource } from '@brain/woocommerce-mapper';
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

/** Live HTTP mode when explicitly in production or opted in via WOOCOMMERCE_LIVE=1. */
function isLiveMode(): boolean {
  return process.env['NODE_ENV'] === 'production' || process.env['WOOCOMMERCE_LIVE'] === '1';
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURE_PATH = join(__dirname, '..', '_fixtures', 'woocommerce', 'woocommerce-orders.json');

function fixturePath(): string {
  return process.env['WOOCOMMERCE_FIXTURE_PATH'] ?? DEFAULT_FIXTURE_PATH;
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

  // ── LIVE: real wc/v3 REST read ────────────────────────────────────────────
  private async fetchOrdersPageLive(modifiedAfterIso: string, page: number): Promise<WooOrderPage> {
    if (!this.baseUrl) {
      throw new Error(`${WOOCOMMERCE_AUTH_ERROR}: site_url missing for WooCommerce live read`);
    }
    const url =
      `${this.baseUrl}/wp-json/wc/v3/orders` +
      `?per_page=${PAGE_SIZE}&page=${page}` +
      `&orderby=modified&order=asc&dates_are_gmt=true` +
      `&modified_after=${encodeURIComponent(modifiedAfterIso)}`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: { Authorization: this.authHeader, Accept: 'application/json' },
      });
    } catch (err) {
      // Never include credentials in the message (I-S09).
      throw new Error(`${WOOCOMMERCE_AUTH_ERROR}: orders request failed: ${String(err)}`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(`${WOOCOMMERCE_AUTH_ERROR}: orders rejected (${res.status})`);
    }
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

export { PAGE_SIZE as WOOCOMMERCE_PAGE_SIZE };
