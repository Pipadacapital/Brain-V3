/**
 * meta.manifest.ts — the Meta (Facebook/Instagram) Ads IngestionManifest (ingestion-framework
 * onboarding).
 *
 * Meta is one of Brain's two ad-spend sources of truth. Its live lane (apps/stream-worker
 * meta-spend-repull) re-reads a 28-day trailing window every tick and RESTATES daily ad-insight
 * rows idempotently. This manifest DECLARES the SAME single resource as a HISTORICAL backfill
 * surface so the generic `runResumableBackfill` driver can walk Meta's daily insights history,
 * resumably + deduped, with the matching page-fetcher in apps/stream-worker
 * (apps/stream-worker/.../ingestion-backfill/meta-resource-fetchers.ts).
 *
 * WHY this manifest lives in @brain/connector-core (not @brain/ad-spend-mapper):
 *   connector-core is a leaf the mapper depends on (ad-spend-mapper imports hashToUuidShaped from
 *   here). Importing the mapper back into this package would create a cycle, so the canonical
 *   event_name string is INLINED below (kept in sync with
 *   @brain/ad-spend-mapper.SPEND_LIVE_V1_EVENT_NAME).
 *
 * RESOURCE / CURSOR / DEDUP design:
 *   - name = 'insights' — DURABLE; it is the `resource` key on jobs.resource_backfill_state. It is
 *     already provider-scoped (the framework namespaces it under provider 'meta'), so the short key
 *     follows the shopify/woo convention ('products', 'orders') and lines up logically with the live
 *     re-pull's `meta.insights` cursor stream.
 *   - cursorStrategy = 'date_window' — ad spend is anchored by stat-date (click-date) and queried one
 *     bounded date range at a time (Meta `time_range={since,until}`), walked from the anchor back
 *     toward the floor. The cursor is the next (older) window edge.
 *   - dedupKeyStrategy = 'composite' over (stat_date, level, level_id): a Meta "record" is one daily
 *     insight row at a hierarchy level (campaign/adset/ad), NOT an immutable object with a single id.
 *     The (stat_date, level, level_id) tuple is exactly the dedup grain of the live ad-spend lane
 *     (uuidV5FromSpendRow's seed), so a re-read of the same daily row derives the SAME deterministic
 *     event_id → Bronze drops the replay (resume/replay-safe within this lane; see the cross-lane
 *     deviation note in the fetcher header).
 *   - maxBackfillWindowMs = THIRTY_SEVEN_MONTHS_MS — Meta retains ad insights for ~37 months
 *     (the provider maximum, audit-cited); declaring the true platform cap lets a requested
 *     deep-history backfill reach the full retention window instead of being clamped to 24
 *     months (resolveBackfillFloor takes min(requested, platform cap) — the DEFAULT target
 *     stays whatever the caller requests).
 */

import {
  type IngestionManifest,
  type ResourceDescriptor,
} from '../contracts/IngestionManifest.js';

/** Provider id — matches CONNECTOR_CATALOG + IConnector.provider + the ConnectorFactory key. */
export const META_PROVIDER = 'meta' as const;

/**
 * Canonical event_name this resource emits. INLINED to keep connector-core a leaf (no cycle into
 * @brain/ad-spend-mapper). MUST stay equal to @brain/ad-spend-mapper.SPEND_LIVE_V1_EVENT_NAME.
 */
const SPEND_LIVE_V1_EVENT_NAME = 'spend.live.v1' as const;

/**
 * Meta's ad-insights retention: 37 months (the provider maximum). Expressed in the repo's
 * TWO_YEARS_MS style ((37/12) × 365 days). This is the PLATFORM cap the driver clamps against
 * — declaring it at the true retention lets a deep-history backfill reach all ~37 months.
 */
export const THIRTY_SEVEN_MONTHS_MS = Math.round((37 / 12) * 365) * 24 * 60 * 60 * 1000;

/**
 * Meta daily ad insights — the single Meta REST resource. Date-windowed enumeration; each raw row is
 * one daily insight at a hierarchy level (composite dedup identity). Platform depth: 37 months
 * (Meta's retention maximum — the driver clamps a requested window to it).
 */
export const META_INSIGHTS_RESOURCE: ResourceDescriptor = {
  name: 'insights',
  kind: 'rest',
  emits: [SPEND_LIVE_V1_EVENT_NAME],
  backfillSupported: true,
  // Meta retains ad insights for ~37 months — the provider max (audit-cited). Was TWO_YEARS_MS,
  // which silently clamped a requested deep-history backfill 13 months short of what Meta serves.
  maxBackfillWindowMs: THIRTY_SEVEN_MONTHS_MS,
  cursorStrategy: 'date_window',
  // CROSS-LANE ID PARITY: the fetcher PRECOMPUTES each record's event_id by calling the live lane's
  // own id fn — uuidV5FromSpendRow(brandId, 'meta', stat_date, level, level_id) (@brain/ad-spend-mapper)
  // — and carries it as FetchedRecord.providerId. With 'provider_id' the shared passthrough deriver
  // returns that id verbatim as the Bronze event_id, so a backfilled daily row is byte-identical to the
  // 28-day live repull's id → Bronze MERGE dedups (no double-count). (Was 'composite' over
  // (stat_date, level, level_id) — that framework namespace differed from the live seed and let an
  // overlapping day double-count; CALLING the mapper fn makes the lanes converge by construction.)
  dedupKeyStrategy: 'provider_id',
  pageSize: 500,
  description: 'Meta Ads daily insights (date-windowed, campaign/adset/ad levels) — ad-spend + platform-attributed conversions.',
};

/**
 * The complete Meta ingestion manifest. Declared once; consumed by the generic backfill driver +
 * the dedup layer. Validate with assertManifestValid() at startup.
 */
export const META_INGESTION_MANIFEST: IngestionManifest = {
  provider: META_PROVIDER,
  resources: [META_INSIGHTS_RESOURCE],
};
