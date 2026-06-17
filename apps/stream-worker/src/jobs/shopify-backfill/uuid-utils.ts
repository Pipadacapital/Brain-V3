/**
 * uuid-utils.ts — Deterministic event_id derivation for backfill events (ADR-BF-2 / D-5).
 *
 * The Bronze pipeline requires event_id to be a valid UUID (CollectorEventV1Schema.event_id is .uuid()).
 * D-5 requires a deterministic, stable-across-re-runs event_id so re-runs dedup correctly.
 *
 * Solution: take sha256(brand_id + ':' + shopify_order_id + ':' + 'order.backfill.v1'),
 * then format the 32-byte hash as a RFC-4122 UUIDv5-shaped string:
 *   - Bytes 6 nibble[0]: version = 5 (0b0101...)
 *   - Bytes 8 nibble[0]: variant bits = 0b10.. (RFC-4122 variant)
 * Then hyphenate as 8-4-4-4-12.
 *
 * This is NOT a real UUIDv5 (which uses a namespace + SHA-1) — it is a
 * "UUIDv5-shaped" deterministic identifier using SHA-256 of a well-defined input.
 * The output is a valid UUID string (passes .uuid() validation) and is stable.
 *
 * Stability invariant: sha256("brand_id:shopify_order_id:order.backfill.v1") is
 * pure crypto — same input always produces the same output. Re-running the backfill
 * on the same connector produces identical event_ids → Redis NX dedup + PG PK
 * ON CONFLICT DO NOTHING guarantee exactly-once Bronze write (I-ST04).
 */

import { createHash } from 'node:crypto';

/**
 * Compute a deterministic, UUID-shaped event_id for a backfilled Shopify order.
 *
 * @param brandId         Brand UUID (string)
 * @param shopifyOrderId  Shopify numeric order ID (string)
 * @returns               A valid UUID string, stable across re-runs (D-5 / ADR-BF-2)
 */
export function uuidV5FromOrderBackfill(brandId: string, shopifyOrderId: string): string {
  const input = `${brandId}:${shopifyOrderId}:order.backfill.v1`;
  const hash = createHash('sha256').update(input, 'utf8').digest();

  // Format bytes 0..15 as a UUID string (use first 16 bytes of SHA-256 output)
  // Version nibble: set byte[6] high nibble to 0x5 (version 5)
  // Variant bits: set byte[8] high bits to 0b10xx xxxx (RFC 4122 variant)
  const bytes = Buffer.alloc(16);
  hash.copy(bytes, 0, 0, 16);

  // Set version = 5
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  // Set variant bits = RFC 4122 (10xx xxxx)
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  // Hyphenate as 8-4-4-4-12
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}
