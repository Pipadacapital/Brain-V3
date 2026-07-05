/**
 * shiprocket-resource-fetchers.ts — IResourcePageFetcher for Shiprocket onboarded onto the resumable
 * backfill framework: the single 'shipment.lifecycle' resource (date-windowed enumeration).
 *
 * This is the ONLY connector-authored code the generic `runResumableBackfill` driver needs to gain a
 * full resumable historical backfill of Shiprocket shipment lifecycle: "given a cursor, return the
 * next page of records + the next cursor". It knows NOTHING about checkpointing, resumption, dedup,
 * retries, or DB state — the driver owns all of that. The fetcher REUSES the existing live re-pull
 * client (ShiprocketShipmentClient) for HTTP/paging and the FROZEN @brain/shiprocket-mapper
 * (mapShiprocketShipment) for raw → CanonicalEventDraft (AWB + phone/email hashed at the mapper
 * boundary; order_id passthrough; data_source stamped). No money/PII is re-mapped here.
 *
 * PAGING (cursorStrategy 'date_window'): the driver walks from the anchor (now) BACK toward the
 * historical floor (floorAt, ≤ 2 years). Each framework page is one (windowEnd, skip) slice. The
 * cursor encodes "${windowEndTs}:${skip}":
 *   - within a date window we page by `skip` (the client's PAGE_SIZE-based offset) until the window
 *     is exhausted (page.hasMore === false),
 *   - then we step to the next OLDER window (windowEnd := windowStart - 1s, skip := 0),
 *   - until a window starts at/under the floor → nextCursor = null (walk complete).
 *
 * DEDUP (provider_id passthrough, per the manifest): each raw row is a status TRANSITION. To stay
 * BYTE-IDENTICAL with the live/repull lane, the fetcher computes the event_id itself by calling the
 * connector's OWN live id fn — uuidV5FromShipment(brandId, RAW awb, RAW status, status_changed_at),
 * the EXACT call shiprocket-shipment-repull/run.ts makes — and carries it as FetchedRecord.providerId.
 * The driver's passthrough deriver (precomputedEventIdDeriver) returns it verbatim as the Bronze
 * event_id, so a backfilled transition derives the SAME id as live → Bronze dedups → no double-count.
 *
 * Auth: a 401/403 makes the client throw SHIPROCKET_AUTH_ERROR; we let it propagate so the driver
 * FAILS the run and PRESERVES the cursor for a later resume (never restarts). The login token /
 * credentials are NEVER logged (I-S09); raw AWB / phone / email are hashed inside the pure mapper
 * (raw DROPPED there) — none of them are logged here.
 *
 * brand_id is ALWAYS the connector row's (passed in by the caller — MT-1), NEVER read from an API
 * response.
 */

import type { Pool } from 'pg';
import type {
  IResourcePageFetcher,
  ResourcePage,
  FetchedRecord,
  CanonicalEventDraft,
  ResourceDescriptor,
} from '@brain/connector-core';
import {
  mapShiprocketShipment,
  uuidV5FromShipment,
  type ShiprocketShipmentRecord,
} from '@brain/shiprocket-mapper';
import {
  ShiprocketShipmentClient,
  SHIPROCKET_SHIPMENT_PAGE_SIZE,
} from '../shiprocket-shipment-repull/shiprocket-client.js';
import type { ShiprocketApiCredentials } from '../shiprocket-shipment-repull/shiprocket-token-provider.js';

/** Resource key — DURABLE; matches SHIPROCKET_SHIPMENT_LIFECYCLE_RESOURCE.name in the manifest. */
const SHIPMENT_LIFECYCLE_RESOURCE = 'shipment.lifecycle' as const;

/** Width of one backfill date window, in seconds. 30 days — bounds each enumeration slice so the
 *  cursor advances in resumable chunks across a 2-year walk. */
const WINDOW_SECONDS = 30 * 24 * 60 * 60;

/** Decode the framework cursor "${windowEndTs}:${skip}". Null cursor ⇒ first page anchored at `nowTs`. */
function parseCursor(cursor: string | null, nowTs: number): { windowEndTs: number; skip: number } {
  if (!cursor) return { windowEndTs: nowTs, skip: 0 };
  const sep = cursor.indexOf(':');
  if (sep === -1) {
    const end = parseInt(cursor, 10);
    return { windowEndTs: Number.isFinite(end) ? end : nowTs, skip: 0 };
  }
  const end = parseInt(cursor.slice(0, sep), 10);
  const skip = parseInt(cursor.slice(sep + 1), 10);
  return {
    windowEndTs: Number.isFinite(end) ? end : nowTs,
    skip: Number.isFinite(skip) && skip > 0 ? skip : 0,
  };
}

function buildCursor(windowEndTs: number, skip: number): string {
  return `${windowEndTs}:${skip}`;
}

/**
 * ShipmentLifecycleFetcher — pages the Shiprocket shipment list date-window by date-window, mapping
 * each row through the frozen mapper. Stateless across calls (all state is in the cursor the driver
 * passes back in).
 */
class ShiprocketShipmentLifecycleFetcher implements IResourcePageFetcher {
  private readonly client: ShiprocketShipmentClient;
  /** Anchor (seconds) for the first window's upper bound; captured once so resume is stable. */
  private readonly anchorTs = Math.floor(Date.now() / 1000);

  constructor(
    secrets: ShiprocketApiCredentials,
    private readonly brandId: string,
    private readonly saltHex: string,
  ) {
    // Reuse the live re-pull client (dev fixture / prod HTTP posture, token caching, circuit breaker).
    this.client = new ShiprocketShipmentClient(secrets);
  }

  async fetchPage(args: {
    resource: ResourceDescriptor;
    cursor: string | null;
    floorAt: Date;
  }): Promise<ResourcePage> {
    const floorTs = Math.floor(args.floorAt.getTime() / 1000);
    const { windowEndTs, skip } = parseCursor(args.cursor, this.anchorTs);
    const windowStartTs = Math.max(windowEndTs - WINDOW_SECONDS, floorTs);

    // Throws SHIPROCKET_AUTH_ERROR on 401/403 → driver fails the run + PRESERVES the cursor.
    const page = await this.client.fetchShipmentPage(windowStartTs, windowEndTs, skip);

    const records: FetchedRecord[] = [];
    let oldest: Date | undefined;
    for (const raw of page.items) {
      const record = raw as ShiprocketShipmentRecord;
      const orderId = record.order_id ? String(record.order_id) : '';
      const rawAwb = record.awb ? String(record.awb) : '';
      const rawStatus = record.status ? String(record.status) : '';
      // Mirror the live lane: a row missing the ledger spine key or status is skipped (the mapper
      // would otherwise throw on a missing order_id).
      if (!orderId || !rawStatus) continue;

      const mapped = mapShiprocketShipment(record, this.brandId, this.saltHex, page.dataSource);
      const p = mapped.properties;
      const statusChangedAt = p.status_changed_at;

      // ID-PARITY (revenue-truth): compute the event_id by calling the SAME live/repull id fn with
      // the EXACT same args the live lane uses (shiprocket-shipment-repull/run.ts) —
      // uuidV5FromShipment(brandId, RAW awb, RAW status, status_changed_at). The raw AWB (not the
      // salted hash) is the live id seed, so the backfilled transition derives a BYTE-IDENTICAL
      // event_id to the live lane → Bronze dedups → no double-count. We carry it on providerId and
      // the driver's passthrough deriver (precomputedEventIdDeriver) stamps it verbatim.
      const eventId = uuidV5FromShipment(this.brandId, rawAwb, rawStatus, statusChangedAt);

      const draft: CanonicalEventDraft = {
        event_name: mapped.event_name,
        occurred_at: mapped.occurred_at,
        properties: {
          ...(p as unknown as Record<string, unknown>),
          // DEV-HONESTY: carry the synthetic flag onto Bronze (parity with the live re-pull lane).
          processing_flags: { _synthetic: page.dataSource === 'synthetic' },
        },
        // event_id is intentionally absent on the draft — the driver stamps it from providerId
        // below. brand_id is the connector row's (MT-1), never from the API payload.
        provenance: { brand_id: this.brandId, source: 'shiprocket' },
      };

      records.push({
        // The precomputed live event_id (uuidV5FromShipment) — carried verbatim so the passthrough
        // deriver returns it as the Bronze event_id, making backfill ids == live ids by construction.
        providerId: eventId,
        events: [draft],
      });

      const occ = new Date(mapped.occurred_at);
      if (!Number.isNaN(occ.getTime()) && (!oldest || occ < oldest)) oldest = occ;
    }

    // Advance the cursor: page within this window until exhausted, then step to the next older
    // window; null nextCursor when an exhausted window already reaches the floor (walk complete).
    let nextCursor: string | null;
    if (page.hasMore) {
      nextCursor = buildCursor(windowEndTs, skip + SHIPROCKET_SHIPMENT_PAGE_SIZE);
    } else if (windowStartTs <= floorTs) {
      nextCursor = null;
    } else {
      nextCursor = buildCursor(windowStartTs - 1, 0);
    }

    return { records, nextCursor, ...(oldest ? { oldestOccurredAt: oldest } : {}) };
  }
}

/**
 * buildShiprocketResourceFetcher — the NAMING-CONTRACT entrypoint imported by ingestion-backfill/run.ts.
 * Returns an IResourcePageFetcher for the requested Shiprocket resource. Throws on an unknown
 * resource (fail-loud, like the shopify/woo switch defaults).
 *
 * `secrets` is the typed credential bundle resolved by the connector's EXISTING repull resolver
 * (resolveShiprocketCredentials) — NEVER logged (I-S09). `pool` / `connectorInstanceId` are part of
 * the shared builder signature but unused for this connector (the client resolves everything from
 * the credential bundle + typed config).
 */
export function buildShiprocketResourceFetcher(args: {
  pool: Pool;
  connectorInstanceId: string;
  resource: string;
  brandId: string;
  saltHex: string;
  secrets: ShiprocketApiCredentials;
}): IResourcePageFetcher {
  const { resource, brandId, saltHex, secrets } = args;
  switch (resource) {
    case SHIPMENT_LIFECYCLE_RESOURCE:
      return new ShiprocketShipmentLifecycleFetcher(secrets, brandId, saltHex);
    default:
      throw new Error(`[ingestion-backfill] shiprocket resource "${resource}" has no fetcher here`);
  }
}
