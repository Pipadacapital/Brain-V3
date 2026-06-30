/**
 * shiprocket.manifest.ts — the Shiprocket IngestionManifest (ingestion-framework onboarding).
 *
 * Shiprocket is Brain's logistics source of truth. Its live lane (apps/stream-worker
 * shiprocket-shipment-repull) re-reads a 45-day trailing window every tick and RESTATES terminal
 * shipment states idempotently. This manifest DECLARES the SAME single resource as a HISTORICAL
 * backfill surface so the generic `runResumableBackfill` driver can walk up to 2 years of shipment
 * lifecycle history, resumably + deduped, with the matching page-fetcher in apps/stream-worker
 * (apps/stream-worker/.../ingestion-backfill/shiprocket-resource-fetchers.ts).
 *
 * WHY this manifest lives in @brain/connector-core (not @brain/shiprocket-mapper):
 *   connector-core is a leaf the mapper depends on (shiprocket-mapper imports hashToUuidShaped from
 *   here). Importing the mapper back into this package would create a cycle, so the canonical
 *   event_name string is INLINED below (kept in sync with
 *   @brain/shiprocket-mapper.SHIPROCKET_SHIPMENT_STATUS_V1_EVENT_NAME).
 *
 * RESOURCE / CURSOR / DEDUP design:
 *   - name = 'shipment.lifecycle' — DURABLE; it is the `resource` key on connector_cursor AND
 *     jobs.resource_backfill_state, and it lines up with the live re-pull's SHIPMENT_CURSOR_RESOURCE
 *     so the two lanes describe the same logical stream.
 *   - cursorStrategy = 'date_window' — shipments are enumerated one bounded date range at a time
 *     (the platform list endpoint is queried from/to), walked from the anchor back toward the floor.
 *   - dedupKeyStrategy = 'provider_id' (carrying a PRECOMPUTED live event_id): a Shiprocket "record"
 *     is a single status TRANSITION, not an immutable object — the same AWB emits many rows over its
 *     life (Dispatched → In Transit → Delivered/RTO). The fetcher computes the transition's event_id
 *     by calling the connector's OWN live id fn (uuidV5FromShipment(brandId, RAW awb, status,
 *     status_changed_at) — the EXACT call the live shiprocket-shipment-repull lane makes) and carries
 *     it as FetchedRecord.providerId; the driver's passthrough deriver returns it verbatim. A re-read
 *     of the same transition therefore derives the SAME event_id as live → Bronze drops the replay →
 *     backfilled history never double-counts against live data (revenue-truth invariant).
 *   - maxBackfillWindowMs = TWO_YEARS_MS — Brain's default historical target; the driver clamps a
 *     requested window to this.
 */

import {
  TWO_YEARS_MS,
  type IngestionManifest,
  type ResourceDescriptor,
} from '../contracts/IngestionManifest.js';

/** Provider id — matches CONNECTOR_CATALOG + IConnector.provider + the ConnectorFactory key. */
export const SHIPROCKET_PROVIDER = 'shiprocket' as const;

/**
 * Canonical event_name this resource emits. INLINED to keep connector-core a leaf (no cycle into
 * @brain/shiprocket-mapper). MUST stay equal to
 * @brain/shiprocket-mapper.SHIPROCKET_SHIPMENT_STATUS_V1_EVENT_NAME.
 */
const SHIPROCKET_SHIPMENT_STATUS_V1_EVENT_NAME = 'shiprocket.shipment_status.v1' as const;

/**
 * Shipment lifecycle — the single Shiprocket REST resource. Date-windowed enumeration; each raw row
 * is one status transition (composite dedup identity). 24-month historical backfill target.
 */
export const SHIPROCKET_SHIPMENT_LIFECYCLE_RESOURCE: ResourceDescriptor = {
  name: 'shipment.lifecycle',
  kind: 'rest',
  emits: [SHIPROCKET_SHIPMENT_STATUS_V1_EVENT_NAME],
  backfillSupported: true,
  // Shiprocket exposes shipment history via its date-windowed list endpoint; Brain targets 2 years
  // (the driver clamps a requested window to this).
  maxBackfillWindowMs: TWO_YEARS_MS,
  cursorStrategy: 'date_window',
  // ID-PARITY (revenue-truth): the fetcher PRECOMPUTES the live event_id by calling the connector's
  // own id fn (uuidV5FromShipment(brandId, RAW awb, status, status_changed_at) — the exact call the
  // live shiprocket-shipment-repull lane makes) and carries it as FetchedRecord.providerId. The
  // driver's passthrough deriver returns it verbatim, so a re-read transition derives the SAME
  // event_id as live → Bronze drops the replay → backfilled history never double-counts. We use
  // 'provider_id' (carrying a precomputed id) rather than a composite namespace the framework would
  // hash itself (which would DIVERGE from the live id, byte-for-byte).
  dedupKeyStrategy: 'provider_id',
  pageSize: 200,
  description: 'Shiprocket shipment lifecycle (date-windowed list) — logistics terminal-state truth (RTO/Delivered).',
};

/**
 * The complete Shiprocket ingestion manifest. Declared once; consumed by the generic backfill
 * driver + the dedup layer. Validate with assertManifestValid() at startup.
 */
export const SHIPROCKET_INGESTION_MANIFEST: IngestionManifest = {
  provider: SHIPROCKET_PROVIDER,
  resources: [SHIPROCKET_SHIPMENT_LIFECYCLE_RESOURCE],
};
