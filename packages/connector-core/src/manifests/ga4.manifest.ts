/**
 * ga4.manifest.ts — the GA4 (Google Analytics 4) IngestionManifest.
 *
 * Declares the single resumable, historical-backfillable resource GA4 exposes to Brain:
 *   ga4.sessions — the GA4 Data API runReport session-grain report (date × traffic/device/geo
 *   dimensions), pulled one bounded DATE WINDOW at a time. The pure @brain/ga4-mapper projects each
 *   report row → a canonical `ga4.session.v1` event (money in minor units + currency; no contact PII).
 *
 * BACKFILL DEPTH (platform cap, never over-claimed):
 *   GA4 standard properties retain event-level data for at most 14 MONTHS (the maximum selectable
 *   "Data retention" setting; older data is permanently aggregated/expired). So `maxBackfillWindowMs`
 *   declares ~14 months — NOT Brain's 24-month (TWO_YEARS_MS) default — so the framework never asks
 *   GA4 for depth it cannot serve. We use a conservative 420-day floor (< the true ~426-day 14-month
 *   span) so a window edge never lands beyond retention.
 *
 * PAGING (date_window): there is no record cursor — the resource is fetched one date-range chunk at a
 * time, newest→oldest, and the framework cursor is the next (older) window edge. The fetcher (see
 * apps/stream-worker/.../ga4-resource-fetchers.ts) returns nextCursor=null once the window start
 * reaches the historical floor.
 *
 * DEDUP (provider_id — precomputed live id): a GA4 session report row has no single upstream id, but its
 * natural identity is the dimension tuple (property + date + source/medium/campaign/channel + device +
 * country). Rather than re-deriving that tuple in the generic framework (which would mint an id that
 * DIFFERS byte-for-byte from the live ga4-repull id → Bronze double-counts), the fetcher computes the
 * event_id with GA4's OWN live id fn (uuidV5FromGa4Row) over exactly that tuple and carries it on
 * FetchedRecord.providerId. So dedup is 'provider_id' and the passthrough precomputedEventIdDeriver
 * stamps the precomputed id through unchanged → backfill ids == live ids BY CONSTRUCTION. brand_id is
 * ALWAYS supplied by the connector row, NEVER from the GA4 API response (MT-1).
 */

import type { IngestionManifest } from '../contracts/IngestionManifest.js';

/**
 * GA4 standard-property data retention cap, in milliseconds. The maximum selectable GA4 "Data
 * retention" is 14 months; 420 days (= 14 × 30) is a deliberately conservative under-approximation of
 * that ~426-day span so a backfill window never reaches past what the API can return.
 */
const GA4_RETENTION_WINDOW_MS = 420 * 24 * 60 * 60 * 1000;

export const GA4_INGESTION_MANIFEST: IngestionManifest = {
  provider: 'ga4',
  resources: [
    {
      name: 'ga4.sessions',
      kind: 'rest',
      emits: ['ga4.session.v1'],
      backfillSupported: true,
      // ~14 months — GA4's real platform retention cap (NOT the 24-month default).
      maxBackfillWindowMs: GA4_RETENTION_WINDOW_MS,
      // Pulled one bounded date-range chunk at a time; the cursor is the next older window edge.
      cursorStrategy: 'date_window',
      // CROSS-LANE ID PARITY: the fetcher precomputes the event_id with GA4's OWN live id fn
      // (uuidV5FromGa4Row, the exact one ga4-repull/run.ts uses) and carries it verbatim on
      // FetchedRecord.providerId, so the passthrough precomputedEventIdDeriver stamps it through
      // unchanged. A backfilled GA4 session therefore gets the SAME event_id as the live lane →
      // Bronze dedups instead of double-counting. (We no longer re-derive a composite tuple here.)
      dedupKeyStrategy: 'provider_id',
      // For a date_window resource `pageSize` encodes the per-window DAY count the fetcher walks
      // (one runReport call per window). 28 days mirrors the live ga4-repull trailing window.
      pageSize: 28,
      description:
        'GA4 Data API runReport session-grain report (date × traffic/device/geo), date-windowed; ' +
        'up to GA4\'s ~14-month retention cap.',
    },
  ],
};
