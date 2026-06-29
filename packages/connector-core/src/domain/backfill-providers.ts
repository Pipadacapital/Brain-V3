/**
 * backfill-providers — the SINGLE source of truth for which providers support the historical
 * `jobs.backfill_job` queue (the "Import history" button).
 *
 * The UI "Import history" / backfill control enqueues a `jobs.backfill_job` row via
 * RequestConnectorBackfillCommand. A row only ever does anything if a worker CLAIMS it. Today the
 * backfill claimer (apps/stream-worker/src/main.ts) drains the queue for the storefront providers
 * listed here ONLY — it runs the resumable shopify paged-backfill runner. A provider NOT in this
 * set (meta/google_ads ads, gokwik/razorpay payments, shiprocket logistics) has NO queue runner, so
 * an enqueued row for it would sit `queued` forever (an orphan job + a UI that looks broken).
 *
 * Therefore this set must stay in lock-step with what the claimer can actually run:
 *   - The claimer filters the connected connectors by `supportsBackfillQueue(provider)`.
 *   - RequestConnectorBackfillCommand rejects a backfill request for any provider NOT in this set
 *     (BACKFILL_NOT_SUPPORTED) instead of enqueuing an orphan row.
 *   - The marketplace UI only renders the backfill control for these providers (web mirror).
 *
 * NOTE — this is narrower than the storefront category (STOREFRONT_PROVIDERS = shopify + woocommerce).
 * WooCommerce's history re-pull runs through the SYNC lane (RequestConnectorSyncCommand → the
 * woocommerce-orders-repull job), NOT through the `jobs.backfill_job` queue, so it is intentionally
 * absent here. Adding a provider to this set REQUIRES adding a queue runner for it in the claimer.
 */

/** Providers with an actual `jobs.backfill_job` queue runner (claimer-drained). */
export const BACKFILL_QUEUE_PROVIDERS = ['shopify'] as const;
export type BackfillQueueProvider = (typeof BACKFILL_QUEUE_PROVIDERS)[number];

/** True iff the provider has a backfill-queue runner that can claim & drain its `jobs.backfill_job`. */
export function supportsBackfillQueue(provider: string): provider is BackfillQueueProvider {
  return (BACKFILL_QUEUE_PROVIDERS as readonly string[]).includes(provider);
}
