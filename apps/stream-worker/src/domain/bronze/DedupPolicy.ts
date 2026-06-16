/**
 * DedupPolicy — dedup key construction and TTL constants.
 *
 * Two-layer dedup (D-3 + §5):
 *  Layer 1: Redis SET NX EX 604800 (7 days, matches Redpanda topic retention).
 *           Fast first-line; keyed by brand_id:event_id (tenant-prefixed).
 *  Layer 2: Postgres PK (brand_id, event_id) unique constraint — durable
 *           backstop. A duplicate INSERT raises a unique violation which the
 *           stream-worker treats as a dedup-hit (commit offset, skip write).
 *
 * Tenant prefix (I-S01): Redis key always starts with brand_id so a cross-brand
 * collision on event_id is impossible (a brand_id can be recycled — it cannot
 * collide another brand's event_id dedup state).
 */

/** Redpanda topic retention = 7 days in seconds. Dedup TTL matches this. */
export const DEDUP_TTL_SECONDS = 7 * 24 * 60 * 60; // 604800

/**
 * Build the Redis dedup key: dedup:{brand_id}:{event_id}
 * Tenant-prefixed to prevent cross-brand collision (I-S01).
 */
export function buildDedupKey(brandId: string, eventId: string): string {
  return `dedup:${brandId}:${eventId}`;
}
