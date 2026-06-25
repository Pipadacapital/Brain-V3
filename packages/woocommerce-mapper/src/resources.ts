/**
 * @brain/woocommerce-mapper/resources — pure mappers for the ADDITIONAL WooCommerce resources
 * onboarded onto the ingestion framework (products).
 *
 * Mirrors @brain/shopify-mapper/resources: each mapper projects a raw wc/v3 record into the
 * framework's record shape (dedup identity + CanonicalEventDraft[] with NO event_id — the driver
 * stamps it). Money in minor units (I-S07); pure (no Kafka/pg/clock-randomness).
 */

import type { CanonicalEventDraft } from '@brain/connector-core';
import {
  tryDecimalToMinor,
  mapWooOrderToEvent,
  type WooOrderShape,
  type DataSource,
} from './index.js';

/** Canonical product event name — SHARED with @brain/shopify-mapper (one product.upsert.v1 grain).
 *  Sourced from the leaf ./event-names.ts (cycle-safe); imported for local use + re-exported. */
import { PRODUCT_UPSERT_V1_EVENT_NAME } from './event-names.js';
export { PRODUCT_UPSERT_V1_EVENT_NAME };

/** What the framework driver needs to emit one raw record: dedup identity + canonical draft(s). */
export interface MappedResourceRecord {
  readonly providerId: string;
  readonly events: readonly CanonicalEventDraft[];
  readonly occurredAt: Date;
}

function toUtcIso(value: string | null | undefined, fallbackIso: string): string {
  const raw = (value ?? '').trim() || fallbackIso;
  const hasTz = /[zZ]$/.test(raw) || /[+-]\d{2}:?\d{2}$/.test(raw);
  return new Date(hasTz ? raw : `${raw}Z`).toISOString();
}

function provenance(brandId: string): CanonicalEventDraft['provenance'] {
  return { brand_id: brandId, source: 'woocommerce' };
}

// ── Raw wc/v3 product shape (only the fields we read) ─────────────────────────

export interface WooProductVariation {
  id?: number | string | null;
  sku?: string | null;
  price?: string | number | null;
  stock_quantity?: number | null;
  [key: string]: unknown;
}

export interface WooProductShape {
  id: number | string;
  name?: string | null;
  slug?: string | null;
  status?: string | null; // publish | draft | pending | private
  type?: string | null; // simple | variable | grouped | external
  sku?: string | null;
  price?: string | number | null;
  regular_price?: string | number | null;
  stock_quantity?: number | null;
  date_created_gmt?: string | null;
  date_modified_gmt?: string | null;
  variations?: WooProductVariation[] | null;
  [key: string]: unknown;
}

export interface WooProductUpsertProperties {
  source: 'woocommerce';
  woocommerce_product_id: string;
  product_id: string;
  title: string | null;
  handle: string | null;
  status: string | null;
  type: string | null;
  sku: string | null;
  price_minor: string | null;
  stock_quantity: number | null;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s.length === 0 ? null : s;
}

/**
 * Map a raw WooCommerce product → product.upsert.v1. Identity is product id; date_modified folded
 * into the dedup identity so distinct catalogue states are distinct Bronze rows (provider_id+kind
 * per the manifest). Note: the wc/v3 /products list endpoint returns variation IDs only (not full
 * variation objects), so per-variation pricing is followed up separately — the top-level price is
 * carried here; the followups note the variation depth.
 */
export function mapWooProductToDraft(
  product: WooProductShape,
  brandId: string,
): MappedResourceRecord {
  const productId = String(product.id);
  const occurredAt = new Date(
    toUtcIso(product.date_modified_gmt ?? product.date_created_gmt, new Date(0).toISOString()),
  );

  const rawPrice = product.price ?? product.regular_price;
  const priceMinor = rawPrice != null ? (tryDecimalToMinor(rawPrice)?.toString() ?? null) : null;

  const properties: WooProductUpsertProperties = {
    source: 'woocommerce',
    woocommerce_product_id: productId,
    product_id: productId,
    title: str(product.name),
    handle: str(product.slug),
    status: str(product.status),
    type: str(product.type),
    sku: str(product.sku),
    price_minor: priceMinor,
    stock_quantity: typeof product.stock_quantity === 'number' ? product.stock_quantity : null,
  };

  const stateMs = occurredAt.getTime();
  return {
    providerId: `${productId}:${stateMs}`,
    occurredAt,
    events: [
      {
        event_name: PRODUCT_UPSERT_V1_EVENT_NAME,
        occurred_at: occurredAt.toISOString(),
        properties: properties as unknown as Record<string, unknown>,
        provenance: provenance(brandId),
      },
    ],
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Orders — framework-record adapter over the FROZEN mapWooOrderToEvent
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Adapt the FROZEN `mapWooOrderToEvent` into the framework's `MappedResourceRecord` so WooCommerce
 * orders flow through the generic resumable backfill driver. The dedup identity folds date_modified
 * (the order's occurred_at ms) into the providerId so each order STATE is a distinct Bronze row —
 * byte-for-byte equivalent to the live lane's uuidV5FromOrderLive(brand, order, updatedAtMs) under
 * the manifest's provider_id+kind strategy.
 */
export function mapWooOrderToDraft(
  order: WooOrderShape,
  brandId: string,
  saltHex: string,
  regionCode: string,
  dataSource: DataSource = 'real',
): MappedResourceRecord {
  const mapped = mapWooOrderToEvent(order, brandId, saltHex, regionCode, dataSource);
  const orderId = String(order.id ?? '').trim();
  const occurredAt = new Date(mapped.occurred_at);
  const stateMs = occurredAt.getTime();

  return {
    providerId: `${orderId}:${stateMs}`,
    occurredAt,
    events: [
      {
        event_name: mapped.event_name,
        occurred_at: mapped.occurred_at,
        properties: mapped.properties as unknown as Record<string, unknown>,
        provenance: provenance(brandId),
      },
    ],
  };
}
