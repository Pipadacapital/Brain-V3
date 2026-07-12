/**
 * ga4.manifest.ts — the GA4 (Google Analytics 4) IngestionManifest.
 *
 * Declares the single resumable, historical-backfillable resource GA4 exposes to Brain:
 *   ga4.sessions — the GA4 Data API runReport session-grain report (date × traffic/device/geo
 *   dimensions), pulled one bounded DATE WINDOW at a time. The pure @brain/ga4-mapper projects each
 *   report row → a canonical `ga4.session.v1` event (money in minor units + currency; no contact PII).
 *
 * BACKFILL DEPTH (audit correction, 2026-07-12):
 *   The GA4 property "Data retention" setting (max 14 months) governs USER/EVENT-LEVEL data —
 *   Explorations and user-scoped queries — NOT the pre-aggregated standard reporting tables the
 *   Data API runReport serves. Standard aggregate reports remain queryable for the property's full
 *   lifetime, so the previous 420-day cap under-claimed real depth. `maxBackfillWindowMs` is now
 *   Brain's 24-month default (TWO_YEARS_MS); GA4 simply returns empty rows for dates that predate
 *   the property, which the date_window walk handles (empty windows still advance to the floor).
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
import { TWO_YEARS_MS } from '../contracts/IngestionManifest.js';

export const GA4_INGESTION_MANIFEST: IngestionManifest = {
  provider: 'ga4',
  resources: [
    {
      name: 'ga4.sessions',
      kind: 'rest',
      emits: ['ga4.session.v1'],
      backfillSupported: true,
      // 24 months (Brain default). The 14-month "Data retention" property setting binds
      // user/event-level Explorations only — runReport standard aggregates are NOT bound by it.
      maxBackfillWindowMs: TWO_YEARS_MS,
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
        'up to Brain\'s 24-month backfill default (standard aggregates are not retention-capped).',
    },
  ],
};
