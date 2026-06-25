/**
 * woocommerce-resource-fetchers.ts — IResourcePageFetcher implementations for WooCommerce onboarded
 * onto the resumable backfill framework: orders + products.
 *
 * WooCommerce pages by page_number (classic offset paging, ordered by modified asc). The framework
 * cursor is therefore the next page number (as a string); a null nextCursor ends the walk. Each
 * fetcher maps raw wc/v3 records → CanonicalEventDraft via the pure @brain/woocommerce-mapper
 * resource mappers (orders reuse the FROZEN order mapper via mapWooOrderToDraft; products via
 * mapWooProductToDraft) and returns the dedup identity for the driver to stamp the event_id.
 *
 * Two source modes mirror the existing woocommerce-orders-repull client: LIVE (real wc/v3 HTTP) and
 * DEV (labelled synthetic fixture). A 401/403 throws WOOCOMMERCE_AUTH_ERROR so the driver fails the
 * run and preserves the cursor. consumer_key/secret are NEVER logged (I-S09).
 */

import type {
  IResourcePageFetcher,
  ResourcePage,
  FetchedRecord,
  ResourceDescriptor,
} from '@brain/connector-core';
import {
  mapWooOrderToDraft,
  mapWooProductToDraft,
  type WooOrderShape,
  type WooProductShape,
  type DataSource,
} from '@brain/woocommerce-mapper';
import {
  WooCommerceClient,
  type WooCommerceApiCredentials,
} from '../woocommerce-orders-repull/woocommerce-client.js';
import { loadStreamWorkerConfig } from '@brain/config';

/**
 * The framework cursor for a page_number resource encodes BOTH the page number and the window
 * start (so resume re-uses the same modified_after lower bound). Format: "page#modifiedAfterIso".
 * On the first call cursor is null → page 1, modifiedAfter = floorAt.
 */
function parsePageCursor(cursor: string | null, floorAt: Date): { page: number; modifiedAfterIso: string } {
  if (!cursor) return { page: 1, modifiedAfterIso: floorAt.toISOString() };
  const hashIdx = cursor.indexOf('#');
  if (hashIdx === -1) {
    const page = parseInt(cursor, 10);
    return { page: Number.isFinite(page) && page > 0 ? page : 1, modifiedAfterIso: floorAt.toISOString() };
  }
  const page = parseInt(cursor.slice(0, hashIdx), 10);
  const iso = cursor.slice(hashIdx + 1);
  return { page: Number.isFinite(page) && page > 0 ? page : 1, modifiedAfterIso: iso || floorAt.toISOString() };
}

function buildPageCursor(page: number, modifiedAfterIso: string): string {
  return `${page}#${modifiedAfterIso}`;
}

// ── Orders ───────────────────────────────────────────────────────────────────

export class WooOrdersFetcher implements IResourcePageFetcher {
  private readonly client: WooCommerceClient;
  constructor(
    creds: WooCommerceApiCredentials,
    private readonly brandId: string,
    private readonly saltHex: string,
    private readonly regionCode: string,
  ) {
    this.client = new WooCommerceClient(creds);
  }

  async fetchPage(args: {
    resource: ResourceDescriptor;
    cursor: string | null;
    floorAt: Date;
  }): Promise<ResourcePage> {
    const { page, modifiedAfterIso } = parsePageCursor(args.cursor, args.floorAt);
    const result = await this.client.fetchOrdersPage(modifiedAfterIso, page);

    const records: FetchedRecord[] = [];
    let oldest: Date | undefined;
    for (const raw of result.orders) {
      const order = raw as WooOrderShape;
      if (order.id == null || String(order.id).trim() === '') continue;
      const mapped = mapWooOrderToDraft(order, this.brandId, this.saltHex, this.regionCode, result.dataSource);
      records.push({ providerId: mapped.providerId, events: mapped.events });
      if (!oldest || mapped.occurredAt < oldest) oldest = mapped.occurredAt;
    }

    const nextCursor = result.hasMore ? buildPageCursor(page + 1, modifiedAfterIso) : null;
    return { records, nextCursor, ...(oldest ? { oldestOccurredAt: oldest } : {}) };
  }
}

// ── Products ───────────────────────────────────────────────────────────────────

export class WooProductsFetcher implements IResourcePageFetcher {
  private readonly client: WooCommerceProductsClient;
  constructor(creds: WooCommerceApiCredentials, private readonly brandId: string) {
    this.client = new WooCommerceProductsClient(creds);
  }

  async fetchPage(args: {
    resource: ResourceDescriptor;
    cursor: string | null;
    floorAt: Date;
  }): Promise<ResourcePage> {
    const { page, modifiedAfterIso } = parsePageCursor(args.cursor, args.floorAt);
    const result = await this.client.fetchProductsPage(modifiedAfterIso, page, args.resource.pageSize ?? 100);

    const records: FetchedRecord[] = [];
    let oldest: Date | undefined;
    for (const raw of result.products) {
      if (raw.id == null) continue;
      const mapped = mapWooProductToDraft(raw, this.brandId);
      records.push({ providerId: mapped.providerId, events: mapped.events });
      if (!oldest || mapped.occurredAt < oldest) oldest = mapped.occurredAt;
    }

    const nextCursor = result.hasMore ? buildPageCursor(page + 1, modifiedAfterIso) : null;
    return { records, nextCursor, ...(oldest ? { oldestOccurredAt: oldest } : {}) };
  }
}

// ── WooCommerce products REST client (live + synthetic-fixture parity with orders) ──

interface WooProductPage {
  products: WooProductShape[];
  hasMore: boolean;
  dataSource: DataSource;
}

const WOOCOMMERCE_AUTH_ERROR = 'WOOCOMMERCE_AUTH_ERROR';

/**
 * A minimal wc/v3 /products reader. LIVE in production / WOOCOMMERCE_LIVE=1 (real HTTP, Basic auth,
 * X-WP-TotalPages paging); DEV reads the labelled synthetic fixture
 * (_fixtures/woocommerce/woocommerce-products.json). Mirrors WooCommerceClient's posture so the
 * framework path has the SAME dev/prod parity orders already have.
 */
class WooCommerceProductsClient {
  private readonly live: boolean;
  private readonly authHeader: string;
  private readonly baseUrl: string;
  private fixture: WooProductShape[] | null = null;

  constructor(creds: WooCommerceApiCredentials) {
    this.live = process.env['NODE_ENV'] === 'production' || process.env['WOOCOMMERCE_LIVE'] === '1';
    this.authHeader =
      'Basic ' + Buffer.from(`${creds.consumer_key}:${creds.consumer_secret}`).toString('base64');
    this.baseUrl = (creds.site_url ?? '').replace(/\/+$/, '');
  }

  async fetchProductsPage(modifiedAfterIso: string, page: number, perPage: number): Promise<WooProductPage> {
    return this.live
      ? this.fetchLive(modifiedAfterIso, page, perPage)
      : this.fetchFixture(modifiedAfterIso, page, perPage);
  }

  private async fetchLive(modifiedAfterIso: string, page: number, perPage: number): Promise<WooProductPage> {
    if (!this.baseUrl) {
      throw new Error(`${WOOCOMMERCE_AUTH_ERROR}: site_url missing for WooCommerce products read`);
    }
    const url =
      `${this.baseUrl}/wp-json/wc/v3/products` +
      `?per_page=${perPage}&page=${page}&orderby=modified&order=asc&dates_are_gmt=true` +
      `&modified_after=${encodeURIComponent(modifiedAfterIso)}`;
    let res: Response;
    try {
      res = await fetch(url, { method: 'GET', headers: { Authorization: this.authHeader, Accept: 'application/json' } });
    } catch (err) {
      throw new Error(`${WOOCOMMERCE_AUTH_ERROR}: products request failed: ${String(err)}`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(`${WOOCOMMERCE_AUTH_ERROR}: products rejected (${res.status})`);
    }
    if (!res.ok) {
      throw new Error(`woocommerce products fetch failed (${res.status})`);
    }
    const products = (await res.json()) as WooProductShape[];
    const totalPagesHeader = res.headers.get('x-wp-totalpages');
    const totalPages = totalPagesHeader ? parseInt(totalPagesHeader, 10) : NaN;
    const arr = Array.isArray(products) ? products : [];
    const hasMore = Number.isFinite(totalPages) ? page < totalPages : arr.length === perPage;
    return { products: arr, hasMore, dataSource: 'real' };
  }

  private async fetchFixture(modifiedAfterIso: string, page: number, perPage: number): Promise<WooProductPage> {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    if (this.fixture === null) {
      const here = dirname(fileURLToPath(import.meta.url));
      const path =
        loadStreamWorkerConfig().WOOCOMMERCE_PRODUCTS_FIXTURE_PATH ??
        join(here, '..', '_fixtures', 'woocommerce', 'woocommerce-products.json');
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as { products?: WooProductShape[] };
        this.fixture = Array.isArray(parsed.products) ? parsed.products : [];
      } catch {
        this.fixture = [];
      }
    }
    const afterMs = Date.parse(modifiedAfterIso);
    const eligible = this.fixture
      .filter((p) => {
        const m = p.date_modified_gmt ?? p.date_created_gmt ?? null;
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
    const start = (page - 1) * perPage;
    const slice = eligible.slice(start, start + perPage);
    return { products: slice, hasMore: start + perPage < eligible.length, dataSource: 'synthetic' };
  }
}

export { parsePageCursor, buildPageCursor };
