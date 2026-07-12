/**
 * woocommerce-resource-fetchers.ts — IResourcePageFetcher implementations for WooCommerce onboarded
 * onto the resumable backfill framework: orders + products + customers + coupons + refunds.
 *
 * WooCommerce pages its list endpoints by page_number (classic offset paging, ordered by modified
 * asc). The framework cursor is therefore the next page number (as a string); a null nextCursor ends
 * the walk. Each fetcher maps raw wc/v3 records → CanonicalEventDraft via the pure
 * @brain/woocommerce-mapper resource mappers (orders reuse the FROZEN order mapper via
 * mapWooOrderToDraft; products/customers/coupons via their per-resource mappers; refunds are fanned
 * out of each order's nested refunds[] via mapWooOrderRefundsToDrafts) and returns the dedup identity
 * for the driver to stamp the deterministic event_id.
 *
 * MONEY (I-S07): every money-bearing mapper is CURRENCY-AWARE — the store currency (resolved once per
 * connector from wc/v3 settings/general, or the dev fixture's order currency) is passed in. There is
 * NO hardcoded x100 and NO INR default; a fixed coupon / customer LTV / product price with no
 * resolvable currency degrades to a null minor amount rather than a blended one.
 *
 * Two source modes mirror the existing woocommerce-orders-repull client: LIVE (real wc/v3 HTTP) and
 * DEV (labelled synthetic fixture). A 401/403 throws WOOCOMMERCE_AUTH_ERROR so the driver fails the
 * run and preserves the cursor. consumer_key/secret are NEVER logged (I-S09); raw PII is hashed
 * inside the pure mappers (D-10).
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
  mapWooCustomerToDraft,
  mapWooCouponToDraft,
  mapWooOrderRefundsToDrafts,
  type WooOrderShape,
  type WooProductShape,
  type WooCustomerShape,
  type WooCouponShape,
  type DataSource,
} from '@brain/woocommerce-mapper';
import {
  WooCommerceClient,
  type WooCommerceApiCredentials,
} from '../woocommerce-orders-repull/woocommerce-client.js';
import { loadStreamWorkerConfig } from '@brain/config';
import { log } from '../../log.js';

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
  private readonly client: WooCommerceListClient<WooProductShape>;
  constructor(
    creds: WooCommerceApiCredentials,
    private readonly brandId: string,
    /** Store currency (ISO-4217) — drives price scaling + the currency_code sibling (MONEY FIX). */
    private readonly currencyCode: string,
  ) {
    this.client = new WooCommerceListClient<WooProductShape>(creds, {
      resourcePath: 'products',
      fixturePath: productsFixturePath(),
    });
  }

  async fetchPage(args: {
    resource: ResourceDescriptor;
    cursor: string | null;
    floorAt: Date;
  }): Promise<ResourcePage> {
    const { page, modifiedAfterIso } = parsePageCursor(args.cursor, args.floorAt);
    const result = await this.client.fetchListPage(modifiedAfterIso, page, args.resource.pageSize ?? 100);

    const records: FetchedRecord[] = [];
    let oldest: Date | undefined;
    for (const raw of result.records) {
      if (raw.id == null) continue;
      const mapped = mapWooProductToDraft(raw, this.brandId, this.currencyCode);
      records.push({ providerId: mapped.providerId, events: mapped.events });
      if (!oldest || mapped.occurredAt < oldest) oldest = mapped.occurredAt;
    }

    const nextCursor = result.hasMore ? buildPageCursor(page + 1, modifiedAfterIso) : null;
    return { records, nextCursor, ...(oldest ? { oldestOccurredAt: oldest } : {}) };
  }
}

// ── Customers ───────────────────────────────────────────────────────────────────

/**
 * Customer DIRECTORY backfill — wc/v3 /customers. Closes the gap where the only "customers" were the
 * order-identity projection (buyers only); customers who never ordered were invisible. Raw email/phone
 * are hashed + dropped inside mapWooCustomerToDraft (D-10 / I-S02); only salted hashes leave.
 */
export class WooCustomersFetcher implements IResourcePageFetcher {
  private readonly client: WooCommerceListClient<WooCustomerShape>;
  constructor(
    creds: WooCommerceApiCredentials,
    private readonly brandId: string,
    private readonly saltHex: string,
    private readonly regionCode: string,
    /** Store currency — the sibling for total_spent_minor (MONEY FIX); may be '' → null LTV. */
    private readonly currencyCode: string,
  ) {
    this.client = new WooCommerceListClient<WooCustomerShape>(creds, {
      resourcePath: 'customers',
      fixturePath: resourceFixturePath('customers'),
      // FIX (the historically-FAILED customers lane): wc/v3 /customers does NOT support the
      // modified-window query params the other list endpoints do — its `orderby` enum is
      // id|include|name|registered_date (no 'modified') and the controller has no date filters
      // (no modified_after / dates_are_gmt). The shared '?orderby=modified&modified_after=…' URL
      // therefore 400'd (rest_invalid_param) on EVERY live poll → customers=FAILED each tick.
      // Walk the full directory ordered by registered_date instead (see windowing:'none' in the
      // client) — the framework's deterministic dedup makes the re-walk idempotent.
      windowing: 'none',
    });
  }

  async fetchPage(args: {
    resource: ResourceDescriptor;
    cursor: string | null;
    floorAt: Date;
  }): Promise<ResourcePage> {
    const { page, modifiedAfterIso } = parsePageCursor(args.cursor, args.floorAt);
    const result = await this.client.fetchListPage(modifiedAfterIso, page, args.resource.pageSize ?? 100);

    const records: FetchedRecord[] = [];
    let oldest: Date | undefined;
    for (const raw of result.records) {
      if (raw.id == null) continue;
      const mapped = mapWooCustomerToDraft(raw, this.brandId, this.saltHex, this.regionCode, this.currencyCode);
      records.push({ providerId: mapped.providerId, events: mapped.events });
      if (!oldest || mapped.occurredAt < oldest) oldest = mapped.occurredAt;
    }

    const nextCursor = result.hasMore ? buildPageCursor(page + 1, modifiedAfterIso) : null;
    return { records, nextCursor, ...(oldest ? { oldestOccurredAt: oldest } : {}) };
  }
}

// ── Coupons ───────────────────────────────────────────────────────────────────

/**
 * Coupon backfill — wc/v3 /coupons (NEW canonical grain coupon.upsert.v1). Coupons previously
 * survived only as order-nested discount_codes[]; this gives them a first-class resource. A PERCENT
 * coupon's `amount` is a percentage (never scaled to money); a FIXED coupon's `amount` → minor units,
 * currency-aware — both handled in mapWooCouponToDraft.
 */
export class WooCouponsFetcher implements IResourcePageFetcher {
  private readonly client: WooCommerceListClient<WooCouponShape>;
  constructor(
    creds: WooCommerceApiCredentials,
    private readonly brandId: string,
    /** Store currency — the sibling for a FIXED coupon's amount_minor (MONEY FIX). */
    private readonly currencyCode: string,
  ) {
    this.client = new WooCommerceListClient<WooCouponShape>(creds, {
      resourcePath: 'coupons',
      fixturePath: resourceFixturePath('coupons'),
    });
  }

  async fetchPage(args: {
    resource: ResourceDescriptor;
    cursor: string | null;
    floorAt: Date;
  }): Promise<ResourcePage> {
    const { page, modifiedAfterIso } = parsePageCursor(args.cursor, args.floorAt);
    const result = await this.client.fetchListPage(modifiedAfterIso, page, args.resource.pageSize ?? 100);

    const records: FetchedRecord[] = [];
    let oldest: Date | undefined;
    for (const raw of result.records) {
      if (raw.id == null) continue;
      const mapped = mapWooCouponToDraft(raw, this.brandId, this.currencyCode);
      records.push({ providerId: mapped.providerId, events: mapped.events });
      if (!oldest || mapped.occurredAt < oldest) oldest = mapped.occurredAt;
    }

    const nextCursor = result.hasMore ? buildPageCursor(page + 1, modifiedAfterIso) : null;
    return { records, nextCursor, ...(oldest ? { oldestOccurredAt: oldest } : {}) };
  }
}

// ── Refunds (nested under orders — wc/v3 has no top-level refunds list) ───────────

/**
 * Refund backfill. WooCommerce has no top-level /refunds list endpoint; refunds are nested under each
 * order (`refunds[]`). So this fetcher WALKS orders (reusing the orders client) and FANS each order's
 * refunds[] into standalone refund.recorded.v1 records via mapWooOrderRefundsToDrafts — one framework
 * page == one order page. Currency + order_id come from the order itself (no store-currency arg
 * needed). Mirrors the Shopify ShopifyRefundsFetcher pattern exactly.
 */
export class WooRefundsFetcher implements IResourcePageFetcher {
  private readonly client: WooCommerceClient;
  constructor(creds: WooCommerceApiCredentials, private readonly brandId: string) {
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
      for (const mapped of mapWooOrderRefundsToDrafts(order, this.brandId)) {
        records.push({ providerId: mapped.providerId, events: mapped.events });
        if (!oldest || mapped.occurredAt < oldest) oldest = mapped.occurredAt;
      }
    }

    const nextCursor = result.hasMore ? buildPageCursor(page + 1, modifiedAfterIso) : null;
    return { records, nextCursor, ...(oldest ? { oldestOccurredAt: oldest } : {}) };
  }
}

// ── Generic wc/v3 list client (live + synthetic-fixture parity with orders) ──────

interface WooListPage<T> {
  records: T[];
  hasMore: boolean;
  dataSource: DataSource;
}

interface WooListRecord {
  id?: number | string | null;
  date_modified_gmt?: string | null;
  date_created_gmt?: string | null;
  [key: string]: unknown;
}

const WOOCOMMERCE_AUTH_ERROR = 'WOOCOMMERCE_AUTH_ERROR';

/** Default _fixtures path for a wc/v3 resource (overridable via WOOCOMMERCE_<RES>_FIXTURE_PATH). */
function defaultFixturePath(resourcePath: string): string {
  // Lazy node:path/url resolution kept inside the class read; this returns the bare default name and
  // the class join()s it against the module dir when reading.
  return `woocommerce-${resourcePath}.json`;
}

/** Products fixture path — honours the typed config key (parity with the legacy WooProductsFetcher). */
function productsFixturePath(): string {
  return loadStreamWorkerConfig().WOOCOMMERCE_PRODUCTS_FIXTURE_PATH ?? defaultFixturePath('products');
}

/**
 * customers/coupons fixture path override. These resources have no typed config key (the framework
 * onboarded them after the schema was frozen), so the override is read from process.env directly
 * (intentional raw — a non-secret dev-only file path) and falls back to the default _fixtures name.
 */
function resourceFixturePath(resourcePath: string): string {
  const envKey = `WOOCOMMERCE_${resourcePath.toUpperCase()}_FIXTURE_PATH`;
  // intentional raw: optional dev-only fixture override; not in the typed config schema.
  return process.env[envKey] ?? defaultFixturePath(resourcePath);
}

/**
 * A minimal generic wc/v3 list reader for products / customers / coupons. LIVE in production /
 * WOOCOMMERCE_LIVE=1 (real HTTP, Basic auth, X-WP-TotalPages paging, modified_after window); DEV reads
 * the labelled synthetic fixture. Mirrors WooCommerceClient's dev/prod posture so every framework
 * resource has the SAME parity orders already have. consumer_key/secret are NEVER logged (I-S09).
 */
class WooCommerceListClient<T extends WooListRecord> {
  private readonly live: boolean;
  private readonly authHeader: string;
  private readonly baseUrl: string;
  private readonly resourcePath: string;
  private readonly fixturePath: string;
  /**
   * How the endpoint is windowed/ordered:
   *   'modified' (default) — ?orderby=modified&modified_after=<floor> (products/coupons; the same
   *                           incremental window orders use).
   *   'none'               — the endpoint supports NEITHER (wc/v3 /customers: orderby enum is
   *                           id|include|name|registered_date, no date filters at all — sending the
   *                           'modified' params 400s rest_invalid_param). Walk the full list ordered
   *                           by registered_date asc; dedup makes the re-walk idempotent.
   */
  private readonly windowing: 'modified' | 'none';
  private fixture: T[] | null = null;

  constructor(
    creds: WooCommerceApiCredentials,
    opts: { resourcePath: string; fixturePath: string; windowing?: 'modified' | 'none' },
  ) {
    this.live = process.env['NODE_ENV'] === 'production' || process.env['WOOCOMMERCE_LIVE'] === '1';
    this.authHeader =
      'Basic ' + Buffer.from(`${creds.consumer_key}:${creds.consumer_secret}`).toString('base64');
    this.baseUrl = (creds.site_url ?? '').replace(/\/+$/, '');
    this.resourcePath = opts.resourcePath;
    this.fixturePath = opts.fixturePath;
    this.windowing = opts.windowing ?? 'modified';
  }

  async fetchListPage(modifiedAfterIso: string, page: number, perPage: number): Promise<WooListPage<T>> {
    return this.live
      ? this.fetchLive(modifiedAfterIso, page, perPage)
      : this.fetchFixture(modifiedAfterIso, page, perPage);
  }

  private async fetchLive(modifiedAfterIso: string, page: number, perPage: number): Promise<WooListPage<T>> {
    if (!this.baseUrl) {
      throw new Error(`${WOOCOMMERCE_AUTH_ERROR}: site_url missing for WooCommerce ${this.resourcePath} read`);
    }
    const url =
      this.windowing === 'modified'
        ? `${this.baseUrl}/wp-json/wc/v3/${this.resourcePath}` +
          `?per_page=${perPage}&page=${page}&orderby=modified&order=asc&dates_are_gmt=true` +
          `&modified_after=${encodeURIComponent(modifiedAfterIso)}`
        : // windowing 'none' (customers): registered_date is the only stable chronological orderby
          // the endpoint accepts; NO date-window params exist — full-directory walk.
          `${this.baseUrl}/wp-json/wc/v3/${this.resourcePath}` +
          `?per_page=${perPage}&page=${page}&orderby=registered_date&order=asc`;
    let res: Response;
    try {
      res = await fetch(url, { method: 'GET', headers: { Authorization: this.authHeader, Accept: 'application/json' } });
    } catch (err) {
      throw new Error(`${WOOCOMMERCE_AUTH_ERROR}: ${this.resourcePath} request failed: ${String(err)}`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(`${WOOCOMMERCE_AUTH_ERROR}: ${this.resourcePath} rejected (${res.status})`);
    }
    if (!res.ok) {
      throw new Error(`woocommerce ${this.resourcePath} fetch failed (${res.status})`);
    }
    const body = (await res.json()) as T[];
    const arr = Array.isArray(body) ? body : [];
    const totalPagesHeader = res.headers.get('x-wp-totalpages');
    const totalPages = totalPagesHeader ? parseInt(totalPagesHeader, 10) : NaN;
    const hasMore = Number.isFinite(totalPages) ? page < totalPages : arr.length === perPage;
    return { records: arr, hasMore, dataSource: 'real' };
  }

  private async fetchFixture(modifiedAfterIso: string, page: number, perPage: number): Promise<WooListPage<T>> {
    if (this.fixture === null) {
      this.fixture = await this.loadFixture();
    }
    const afterMs = Date.parse(modifiedAfterIso);
    const eligible = this.fixture
      .filter((r) => {
        const m = r.date_modified_gmt ?? r.date_created_gmt ?? null;
        if (!m) return false;
        // windowing 'none' (customers): the live endpoint has no date window — fixture parity means
        // every dated record is eligible (full-directory walk), never filtered by the floor.
        if (this.windowing === 'none') return true;
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
    return { records: slice, hasMore: start + perPage < eligible.length, dataSource: 'synthetic' };
  }

  private async loadFixture(): Promise<T[]> {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join, isAbsolute } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const path = isAbsolute(this.fixturePath)
      ? this.fixturePath
      : join(here, '..', '_fixtures', 'woocommerce', this.fixturePath);
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, T[]>;
      // Accept either { <resource>: [...] } or { records: [...] } or a bare array file.
      return (parsed[this.resourcePath] ?? parsed['records'] ?? (Array.isArray(parsed) ? (parsed as unknown as T[]) : [])) as T[];
    } catch (err) {
      log.warn(`[woocommerce-fetchers] no ${this.resourcePath} fixture at ${path} — empty source: ${String(err)}`);
      return [];
    }
  }
}

export { parsePageCursor, buildPageCursor };
