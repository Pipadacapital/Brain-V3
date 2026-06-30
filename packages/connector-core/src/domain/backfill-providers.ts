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
 * NOTE — WooCommerce's history re-pull runs through the SYNC lane (RequestConnectorSyncCommand → the
 * woocommerce-orders-repull job, which also drives its non-order resources onto the SAME generic
 * driver), NOT through the `jobs.backfill_job` queue, so it is intentionally absent from both sets.
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
 */
export const INGESTION_BACKFILL_PROVIDERS = [
  'meta',
  'google_ads',
  'razorpay',
  'shiprocket',
  'ga4',
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
