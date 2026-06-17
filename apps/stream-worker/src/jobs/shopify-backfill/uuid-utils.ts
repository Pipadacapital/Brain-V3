/**
 * uuid-utils.ts — Re-exports from @brain/shopify-mapper (A0 move, D-12).
 *
 * uuidV5FromOrderBackfill has been MOVED to packages/shopify-mapper to be shared
 * with core (webhook receiver) and the re-pull job. This file re-exports for
 * backward compatibility.
 */

export { uuidV5FromOrderBackfill, uuidV5FromOrderLive } from '@brain/shopify-mapper';
