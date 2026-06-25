/**
 * shopify-resource-fetchers.ts — IResourcePageFetcher implementations for the additional Shopify
 * resources onboarded onto the resumable backfill framework: products, customers, refunds,
 * fulfillments.
 *
 * Each fetcher is the ONLY connector-authored code the framework needs to gain a full resumable
 * backfill of a resource: "given a cursor, return the next page of raw records + the next cursor".
 * It knows NOTHING about checkpointing, resumption, dedup, retries, or DB state — the generic
 * `runResumableBackfill` driver owns all of that. The fetcher maps raw → CanonicalEventDraft via
 * the pure @brain/shopify-mapper resource mappers (PII hashed there) and returns the dedup identity
 * so the driver can stamp the deterministic event_id.
 *
 * PAGING: products/customers use since_id (id-ascending walk, the same stable pattern the order
 * backfill uses). Refunds + fulfillments are NESTED under orders in the Shopify REST API (there is
 * no top-level list endpoint), so those fetchers walk orders by since_id and FLATTEN the nested
 * refunds[]/fulfillments[] of each order into records — one framework page per order page.
 *
 * Auth: a 401 throws SHOPIFY_AUTH_ERROR; the driver fails the run and PRESERVES the cursor for a
 * later resume (never restarts). The access token is NEVER logged (I-S09).
 */

import { CircuitBreaker } from '@brain/observability';
import { loadStreamWorkerConfig } from '@brain/config';
import type {
  IResourcePageFetcher,
  ResourcePage,
  FetchedRecord,
  ResourceDescriptor,
} from '@brain/connector-core';
import {
  mapProductToDraft,
  mapCustomerToDraft,
  mapRefundToDraft,
  mapFulfillmentToDraft,
  type ShopifyProductShape,
  type ShopifyCustomerShape,
  type ShopifyRefundShape,
  type ShopifyFulfillmentShape,
} from '@brain/shopify-mapper';
import { log } from '../../log.js';

const DEFAULT_API_VERSION = '2025-07';
const REQUEST_TIMEOUT_MS = 20_000;
export const SHOPIFY_AUTH_ERROR = 'SHOPIFY_AUTH_ERROR';

/** Shared since_id REST reader for a Shopify Admin list endpoint. NEVER logs the token (I-S09). */
class ShopifyRestReader {
  private readonly base: string;
  private readonly breaker: CircuitBreaker;

  constructor(
    shopDomain: string,
    private readonly accessToken: string,
    apiVersion: string = loadStreamWorkerConfig().SHOPIFY_API_VERSION ?? DEFAULT_API_VERSION,
  ) {
    const host = shopDomain.replace(/^https?:\/\//, '');
    this.base = `https://${host}/admin/api/${apiVersion}`;
    this.breaker = new CircuitBreaker({ name: 'shopify-ingest', failureThreshold: 5, openMs: 30_000 });
  }

  /**
   * Fetch one page of a list resource by since_id. `resourcePath` is the endpoint stem (e.g.
   * 'orders', 'products', 'customers'); `listKey` is the array key in the JSON body.
   */
  async fetchPage<T extends { id: number | string }>(args: {
    resourcePath: string;
    listKey: string;
    sinceId: string | null;
    createdAtMin: string;
    limit: number;
    fields?: string;
  }): Promise<{ records: T[]; nextSinceId: string | null }> {
    const effectiveSinceId = args.sinceId ?? '0';
    const params = new URLSearchParams({
      status: 'any',
      limit: String(args.limit),
      created_at_min: args.createdAtMin,
      since_id: effectiveSinceId,
    });
    if (args.fields) params.set('fields', args.fields);
    // customers has no status filter; harmless extra param is ignored by Shopify.
    const url = `${this.base}/${args.resourcePath}.json?${params.toString()}`;

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
          const retryAfter = res.headers.get('Retry-After');
          const sleepMs = Math.max(1000, (retryAfter ? parseInt(retryAfter, 10) : 2) * 1000);
          log.info(`[shopify-ingest] 429 on ${args.resourcePath} — sleeping ${sleepMs}ms (attempt ${attempt + 1}/10)`);
          await sleep(sleepMs);
          continue;
        }
        if (res.status === 401) {
          throw new Error(`${SHOPIFY_AUTH_ERROR}: 401 Unauthorized on GET ${args.resourcePath}`);
        }
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`Shopify GET ${args.resourcePath} → HTTP ${res.status}: ${body.slice(0, 200)}`);
        }

        const body = (await res.json()) as Record<string, T[]>;
        const records = body[args.listKey] ?? [];
        const last = records[records.length - 1];
        const nextSinceId = records.length === args.limit && last ? String(last.id) : null;
        return { records, nextSinceId };
      }
      throw new Error(`[shopify-ingest] exceeded 429 retry budget on ${args.resourcePath}`);
    });
  }
}

// ── Products ───────────────────────────────────────────────────────────────────

export class ShopifyProductsFetcher implements IResourcePageFetcher {
  private readonly reader: ShopifyRestReader;
  constructor(shopDomain: string, accessToken: string, private readonly brandId: string) {
    this.reader = new ShopifyRestReader(shopDomain, accessToken);
  }

  async fetchPage(args: {
    resource: ResourceDescriptor;
    cursor: string | null;
    floorAt: Date;
  }): Promise<ResourcePage> {
    const { records, nextSinceId } = await this.reader.fetchPage<ShopifyProductShape>({
      resourcePath: 'products',
      listKey: 'products',
      sinceId: args.cursor,
      createdAtMin: args.floorAt.toISOString(),
      limit: args.resource.pageSize ?? 250,
      fields: 'id,title,handle,status,product_type,vendor,created_at,updated_at,variants,tags',
    });
    return buildPage(records.map((p) => toFetched(mapProductToDraft(p, this.brandId))), nextSinceId);
  }
}

// ── Customers ───────────────────────────────────────────────────────────────────

export class ShopifyCustomersFetcher implements IResourcePageFetcher {
  private readonly reader: ShopifyRestReader;
  constructor(
    shopDomain: string,
    accessToken: string,
    private readonly brandId: string,
    private readonly saltHex: string,
    private readonly regionCode: string,
  ) {
    this.reader = new ShopifyRestReader(shopDomain, accessToken);
  }

  async fetchPage(args: {
    resource: ResourceDescriptor;
    cursor: string | null;
    floorAt: Date;
  }): Promise<ResourcePage> {
    const { records, nextSinceId } = await this.reader.fetchPage<ShopifyCustomerShape>({
      resourcePath: 'customers',
      listKey: 'customers',
      sinceId: args.cursor,
      createdAtMin: args.floorAt.toISOString(),
      limit: args.resource.pageSize ?? 250,
    });
    return buildPage(
      records.map((c) => toFetched(mapCustomerToDraft(c, this.brandId, this.saltHex, this.regionCode))),
      nextSinceId,
    );
  }
}

// ── Refunds + Fulfillments (nested under orders) ─────────────────────────────────

interface ShopifyOrderWithNested {
  id: number | string;
  currency?: string | null;
  refunds?: ShopifyRefundShape[] | null;
  fulfillments?: ShopifyFulfillmentShape[] | null;
}

/**
 * Walk orders by since_id and flatten each order's nested refunds[] into refund.recorded.v1
 * records. One framework page == one order page (so the cursor is the order since_id; an order with
 * no refunds simply contributes no records). The order's currency is carried into each refund.
 */
export class ShopifyRefundsFetcher implements IResourcePageFetcher {
  private readonly reader: ShopifyRestReader;
  constructor(shopDomain: string, accessToken: string, private readonly brandId: string) {
    this.reader = new ShopifyRestReader(shopDomain, accessToken);
  }

  async fetchPage(args: {
    resource: ResourceDescriptor;
    cursor: string | null;
    floorAt: Date;
  }): Promise<ResourcePage> {
    const { records: orders, nextSinceId } = await this.reader.fetchPage<ShopifyOrderWithNested>({
      resourcePath: 'orders',
      listKey: 'orders',
      sinceId: args.cursor,
      createdAtMin: args.floorAt.toISOString(),
      limit: args.resource.pageSize ?? 250,
      fields: 'id,currency,refunds',
    });
    const records: FetchedRecord[] = [];
    for (const order of orders) {
      for (const refund of order.refunds ?? []) {
        if (refund.id == null) continue;
        records.push(
          toFetched(mapRefundToDraft(refund, this.brandId, order.currency ?? null)),
        );
      }
    }
    return buildPage(records, nextSinceId);
  }
}

/** Walk orders by since_id and flatten each order's fulfillments[] into fulfillment.recorded.v1. */
export class ShopifyFulfillmentsFetcher implements IResourcePageFetcher {
  private readonly reader: ShopifyRestReader;
  constructor(shopDomain: string, accessToken: string, private readonly brandId: string) {
    this.reader = new ShopifyRestReader(shopDomain, accessToken);
  }

  async fetchPage(args: {
    resource: ResourceDescriptor;
    cursor: string | null;
    floorAt: Date;
  }): Promise<ResourcePage> {
    const { records: orders, nextSinceId } = await this.reader.fetchPage<ShopifyOrderWithNested>({
      resourcePath: 'orders',
      listKey: 'orders',
      sinceId: args.cursor,
      createdAtMin: args.floorAt.toISOString(),
      limit: args.resource.pageSize ?? 250,
      fields: 'id,fulfillments',
    });
    const records: FetchedRecord[] = [];
    for (const order of orders) {
      for (const fulfillment of order.fulfillments ?? []) {
        if (fulfillment.id == null) continue;
        records.push(toFetched(mapFulfillmentToDraft(fulfillment, this.brandId)));
      }
    }
    return buildPage(records, nextSinceId);
  }
}

// ── Shared record/page helpers ──────────────────────────────────────────────────

interface MappedLike {
  providerId: string;
  occurredAt: Date;
  events: FetchedRecord['events'];
}

function toFetched(m: MappedLike): FetchedRecord & { occurredAt: Date } {
  return { providerId: m.providerId, events: m.events, occurredAt: m.occurredAt };
}

/**
 * Assemble a ResourcePage: the records and the next cursor, plus the OLDEST occurred_at on the page
 * (drives the driver's reachedAt checkpoint + floor check). Since since_id walks id-ascending (which
 * is roughly time-ascending for Shopify ids), the oldest record is typically first; we compute the
 * true min defensively.
 */
function buildPage(
  records: Array<FetchedRecord & { occurredAt?: Date }>,
  nextSinceId: string | null,
): ResourcePage {
  let oldest: Date | undefined;
  for (const r of records) {
    if (r.occurredAt && (!oldest || r.occurredAt < oldest)) oldest = r.occurredAt;
  }
  // Strip the helper occurredAt off the FetchedRecord (the framework type does not carry it).
  const clean: FetchedRecord[] = records.map((r) => ({ providerId: r.providerId, compositeValues: r.compositeValues, events: r.events }));
  return { records: clean, nextCursor: nextSinceId, ...(oldest ? { oldestOccurredAt: oldest } : {}) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
