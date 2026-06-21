/**
 * woocommerce-client.ts — WooCommerce REST order read client (DEV-HONEST).
 *
 * Mirrors shiprocket-client.ts / shopify live client (paged, auth, never-log-body).
 *
 * DEV BOUNDARY: there is no live WooCommerce store wired in dev, so this client reads a LABELLED
 * SYNTHETIC FIXTURE (_fixtures/woocommerce/woocommerce-orders.json) and stamps data_source=
 * 'synthetic' downstream. The cursor / order.live.v1 canonical mapping / ledger semantics are REAL
 * and production-shaped — only the data SOURCE is synthetic until a real store credential exists.
 *
 * PROD SWAP (documented, verified contract — SPEC 2): replace the fixture read with
 *   GET {site_url}/wp-json/wc/v3/orders?after={modifiedAfterIso}&page={n}&per_page=100&orderby=modified&order=asc
 *   Authorization: Basic base64(consumer_key:consumer_secret)   (HTTPS)
 * Read X-WP-TotalPages for pagination. On 401/403 throw `${WOOCOMMERCE_AUTH_ERROR}: ...` so the
 * repull records a reconnect signal — exactly as shopify/shiprocket do. The paged fetchOrdersPage
 * interface + data_source flip is the only change.
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURE_PATH = join(
  __dirname,
  '..',
  '_fixtures',
  'woocommerce',
  'woocommerce-orders.json',
);

function fixturePath(): string {
  return process.env['WOOCOMMERCE_FIXTURE_PATH'] ?? DEFAULT_FIXTURE_PATH;
}

interface OrdersFixtureFile {
  _synthetic?: boolean;
  orders: WooOrderShape[];
}

export class WooCommerceClient {
  private readonly fixtureOrders: WooOrderShape[];

  /**
   * @param _credentials  consumer_key/secret + site_url — held in memory only, NEVER logged (I-S09).
   *                       In dev they are accepted but not used (source is the synthetic fixture).
   */
  constructor(_credentials: WooCommerceApiCredentials) {
    let orders: WooOrderShape[] = [];
    try {
      const raw = readFileSync(fixturePath(), 'utf8');
      const parsed = JSON.parse(raw) as OrdersFixtureFile;
      orders = Array.isArray(parsed.orders) ? parsed.orders : [];
    } catch (err) {
      log.warn(`could not read synthetic WooCommerce fixture — empty source: ${String(err)}`);
    }
    this.fixtureOrders = orders;
  }

  /**
   * Fetch one page of orders modified at/after `modifiedAfterIso`.
   *
   * DEV: reads from the synthetic fixture (data_source='synthetic'). NEVER hits the network.
   * Shaped exactly like the real paged REST read for a one-line swap.
   *
   * @param modifiedAfterIso  ISO lower bound on date_modified_gmt (inclusive)
   * @param page              1-based page number
   */
  async fetchOrdersPage(modifiedAfterIso: string, page = 1): Promise<WooOrderPage> {
    const afterMs = Date.parse(modifiedAfterIso);
    const eligible = this.fixtureOrders
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
