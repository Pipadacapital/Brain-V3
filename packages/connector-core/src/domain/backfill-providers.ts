/**
 * backfill-providers — the SINGLE source of truth for which providers support the historical
 * "Import history" backfill (the `jobs.backfill_job` queue).
 *
 * The UI "Import history" / backfill control enqueues a `jobs.backfill_job` row via
 * RequestConnectorBackfillCommand. A row only ever does anything if a worker CLAIMS it. The backfill
 * claimer (apps/stream-worker/src/main.ts) drains the queue per provider via one of TWO runners:
 *
 *   1. BACKFILL_QUEUE_PROVIDERS — the BESPOKE shopify paged-backfill runner (jobs/shopify-backfill).
 *      Shopify only. This is the legacy hand-coded order-history runner; leave it untouched.
 *
 *   2. INGESTION_BACKFILL_PROVIDERS — the GENERIC resumable ingestion framework
 *      (jobs/ingestion-backfill + @brain/connector-core runResumableBackfill). The claimer claims the
 *      backfill_job, then drives EVERY backfill-supported resource declared in the provider's
 *      <UPPER>_INGESTION_MANIFEST through the shared driver (resumable/chunked/dedup/no-loss), and
 *      finalizes the job. Adding a provider here = a manifest + a page-fetcher, not new lifecycle code.
 *
 * A provider in NEITHER set has NO queue runner, so an enqueued row would sit `queued` forever (an
 * orphan job + a UI that looks broken). Therefore these sets must stay in lock-step with what the
 * claimer can actually run:
 *   - The claimer drains shopify via the bespoke runner and the ingestion-backfill providers via the
 *     generic runner, branching on supportsBackfillQueue / supportsIngestionBackfill.
 *   - RequestConnectorBackfillCommand rejects a backfill request for any provider that is in NEITHER
 *     set (BACKFILL_NOT_SUPPORTED) instead of enqueuing an orphan row — i.e. it accepts iff
 *     supportsHistoricalBackfill(provider).
 *   - The marketplace UI only renders the backfill control for supportsHistoricalBackfill providers
 *     (web mirror: apps/web/components/connectors/storefront-exclusivity.ts).
 *
 * NOTE — WooCommerce is in the INGESTION set for the uniform "Pull historical data" UX, but its
 * queue runner drives ONLY the NON-ORDER resources (products/customers/coupons/refunds): orders flow
 * on the live lane via woocommerce-orders-repull (uuidV5FromOrderLive event ids, full manifest-window
 * depth), and driving them through the framework too would mint DIFFERENT deterministic ids and
 * double-count them in Bronze. The queue lane shares jobs.resource_backfill_state cursors with the
 * scheduled per-tick lane, so the two never duplicate work.
 * GoKwik is webhook-first (no REST backfill surface) and is intentionally excluded.
 */

/** Providers with the BESPOKE `jobs.backfill_job` queue runner (jobs/shopify-backfill). */
export const BACKFILL_QUEUE_PROVIDERS = ['shopify'] as const;
export type BackfillQueueProvider = (typeof BACKFILL_QUEUE_PROVIDERS)[number];

/** True iff the provider has the bespoke shopify backfill-queue runner. */
export function supportsBackfillQueue(provider: string): provider is BackfillQueueProvider {
  return (BACKFILL_QUEUE_PROVIDERS as readonly string[]).includes(provider);
}

/**
 * Providers whose "Import history" backfill is drained by the GENERIC ingestion framework
 * (jobs/ingestion-backfill → runResumableBackfill over the provider's <UPPER>_INGESTION_MANIFEST).
 * GoKwik is excluded (webhook-first, no REST backfill surface).
 * woocommerce: NON-ORDER resources only (orders stay on the sync/live lane — see header NOTE).
 */
export const INGESTION_BACKFILL_PROVIDERS = [
  'meta',
  'google_ads',
  'razorpay',
  'shiprocket',
  'ga4',
  'woocommerce',
] as const;
export type IngestionBackfillProvider = (typeof INGESTION_BACKFILL_PROVIDERS)[number];

/** True iff the provider's backfill is drained by the generic ingestion framework. */
export function supportsIngestionBackfill(provider: string): provider is IngestionBackfillProvider {
  return (INGESTION_BACKFILL_PROVIDERS as readonly string[]).includes(provider);
}

/**
 * True iff the provider supports the "Import history" backfill at all — via EITHER the bespoke
 * shopify queue runner OR the generic ingestion framework. This is the single predicate the server
 * reject-guard (RequestConnectorBackfillCommand) and the UI control (web mirror) gate on.
 */
export function supportsHistoricalBackfill(provider: string): boolean {
  return supportsBackfillQueue(provider) || supportsIngestionBackfill(provider);
}
