/**
 * google_ads.manifest.ts — the IngestionManifest for the Google Ads connector.
 *
 * Declares EVERY resource the Google Ads connector can historically backfill onto the generic
 * resumable framework (runResumableBackfill). Today that is one resource: `spend` — daily
 * campaign/ad_group/ad spend + the surviving insight set (cost/impressions/clicks/conversions/
 * conversion-value/…), pulled via GoogleAdsService.SearchStream (GAQL, ADR-AD-3 / ADR-AD-8).
 *
 * RESOURCE NAME: 'spend' (the provider already namespaces it as google_ads/spend). This is the
 * durable key on jobs.resource_backfill_state — renaming it orphans cursors.
 *
 * CURSOR: 'date_window' — spend is queried one bounded date-range chunk at a time (GAQL
 * `segments.date BETWEEN`), the cursor being the next (older) window edge. The fetcher
 * (apps/stream-worker/.../google_ads-resource-fetchers.ts) walks backward in 30-day chunks from
 * the anchor toward the platform floor.
 *
 * DEPTH: TWO_YEARS_MS. Google Ads retains query-able stats well beyond two years for most account
 * tiers, so Brain's 24-month default target is the binding limit here (we never claim more depth
 * than the framework drives) — declared as the platform cap so resolveBackfillFloor clamps to it.
 *
 * DEDUP: 'provider_id' — the fetcher PRECOMPUTES the Bronze event_id by calling the live lane's own
 * uuidV5FromSpendRow(brandId, 'google_ads', stat_date, level, level_id) (@brain/ad-spend-mapper) and
 * carries it as FetchedRecord.providerId; the driver's passthrough deriver emits it verbatim. This
 * makes a backfilled spend row's event_id BYTE-IDENTICAL to the live trailing-window repull's id, so
 * the Bronze MERGE dedups ACROSS lanes (zero double-count of backfilled history against live) — not
 * just within the backfill lane. The seed still resolves to the canonical spend grain
 * (brand_id, platform, stat_date, level, level_id) of silver_marketing_spend. brand_id leads the
 * namespace (multi-tenancy), supplied from the connector row by the fetcher — never from an API
 * response (MT-1).
 */

import type { IngestionManifest } from '../contracts/IngestionManifest.js';
import { TWO_YEARS_MS } from '../contracts/IngestionManifest.js';

/**
 * Google Ads ingestion manifest. Consumed by the generic ingestion-backfill job
 * (apps/stream-worker/src/jobs/ingestion-backfill/run.ts) via manifestFor('google_ads') +
 * backfillableResources(), and re-exported from the @brain/connector-core package index.
 */
export const GOOGLE_ADS_INGESTION_MANIFEST: IngestionManifest = {
  provider: 'google_ads',
  resources: [
    {
      name: 'spend',
      kind: 'rest',
      // The single canonical event a spend row maps to (mapGoogleRowToEvent → spend.live.v1).
      emits: ['spend.live.v1'],
      backfillSupported: true,
      // Brain's 24-month default target is the binding depth for Google Ads (retention exceeds it).
      // DELIBERATELY kept at TWO_YEARS_MS (unlike Meta, which was raised to its 37-month provider
      // max): Google's Reports/GAQL daily-stats guarantee is ~37 months, so 24 months leaves ~13
      // months of headroom under the platform limit — never at risk of requesting past retention.
      maxBackfillWindowMs: TWO_YEARS_MS,
      // GAQL segments.date BETWEEN windows — paged one date-range chunk at a time (oldest-ward).
      cursorStrategy: 'date_window',
      // Identity is a PRECOMPUTED id: the fetcher seeds the live uuidV5FromSpendRow over the spend
      // grain (brand_id, platform, stat_date, level, level_id) and carries it as providerId, so the
      // backfill event_id is byte-identical to the live repull id (cross-lane Bronze dedup).
      dedupKeyStrategy: 'provider_id',
      description:
        'Daily Google Ads spend + insight set (cost/impressions/clicks/conversions/value) per ' +
        'campaign / ad_group / ad, via GAQL SearchStream. Historical backfill in 30-day chunks.',
    },
  ],
};
