/**
 * razorpay-resource-fetchers.ts — IResourcePageFetcher implementation for the Razorpay settlement
 * resources onboarded onto the resumable backfill framework: settlements.payments,
 * settlements.reserves, settlements.adjustments.
 *
 * This is the ONLY connector-authored code the framework needs to gain a full resumable historical
 * backfill of Razorpay settlements: "given a cursor, return the next page of records + the next
 * cursor". It knows NOTHING about checkpointing, resumption, dedup, retries, or DB state — the
 * generic `runResumableBackfill` driver owns all of that. The fetcher REUSES the existing
 * RazorpaySettlementsClient (Basic auth, 429 back-off, circuit breaker) for transport and the FROZEN
 * @brain/razorpay-mapper `mapSettlementItemToEvent` for record→event mapping (field allowlist, C1
 * boundary hashing of payment_id/UTR, I-S07 integer-paisa money) — it does NOT re-map money or PII.
 *
 * PAGING (cursorStrategy = 'date_window'): recon/combined is queried from/to (Unix seconds). The
 * framework cursor is the Unix-seconds UPPER edge (toTs) of the NEXT window to fetch. Each fetchPage
 * fetches ONE bounded window [fromTs, toTs] (paging ALL skip-offsets inside it via
 * fetchAllReconItems), walking from the anchor (now, on the first call) BACKWARD toward floorAt.
 * Adjacent windows are non-overlapping ([fromTs, toTs] then [.., fromTs-1]); a null nextCursor means
 * the floor was reached (window exhausted).
 *
 * RESOURCE PARTITION (no double-count): recon/combined returns ALL entity types in one response. The
 * three resources PARTITION that space — payments = {payment, refund}, reserves = {reserve_deduction},
 * adjustments = {adjustment} — and this fetcher filters each window to its partition. Because the
 * driver folds resource.name into the dedup namespace, emitting the SAME settlement fact under two
 * resource names would mint two distinct event_ids and double-count in Bronze; the partition prevents
 * that with no loss (every entity type belongs to exactly one resource).
 *
 * DEDUP (precomputed live-parity event_id — manifest dedupKeyStrategy='provider_id'): the fetcher
 * computes each record's event_id by calling the SAME mapper id fn the live re-pull lane uses
 * (uuidV5FromSettlementItem for per-payment grain / uuidV5FromSettlementSummary for brand-level
 * reserve/adjustment grain), with the SAME RAW arg values (raw settlement_id + raw payment_id, NOT the
 * hashed id). It carries that id as FetchedRecord.providerId; the shared precomputedEventIdDeriver
 * passes it through verbatim. This makes a backfilled record's event_id BYTE-IDENTICAL to its live
 * counterpart so Bronze deduplicates the two (no double-count) — the revenue-truth invariant. The seed
 * strings live ONLY in @brain/razorpay-mapper so the two lanes can never drift. brand_id is the
 * connector row's, passed in by the caller — NEVER from an API response (MT-1).
 *
 * AUTH: the client throws `RAZORPAY_AUTH_ERROR` on a 401; the error PROPAGATES so the driver fails the
 * run and PRESERVES the cursor for a later resume (never restarts). key_id/key_secret are NEVER logged
 * (I-S09) — they live only inside the client's Basic-auth header.
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
  mapSettlementItemToEvent,
  uuidV5FromSettlementItem,
  uuidV5FromSettlementSummary,
  type RazorpaySettlementItem,
  type SettlementEntityType,
} from '@brain/razorpay-mapper';
import {
  RazorpaySettlementsClient,
  type RazorpayApiCredentials,
  type RazorpayReconItem,
} from '../razorpay-settlement-repull/razorpay-settlements-client.js';

const SECONDS_PER_DAY = 24 * 60 * 60;

/**
 * Backfill date-window size, in days. This is the per-page CHUNK granularity of the date_window walk
 * (the driver's per-run chunk budget bounds how many windows run per tick; the resumable cursor
 * carries the rest forward). 30 days balances chunk count over a 2-year walk against the in-memory
 * page size of one window's recon items.
 */
const WINDOW_DAYS = 30;
const WINDOW_SEC = WINDOW_DAYS * SECONDS_PER_DAY;

/**
 * The recon/combined entity_type → resource partition. Each entity type belongs to EXACTLY one
 * resource so the same settlement fact is never emitted under two resource names (which would mint two
 * distinct event_ids and double-count). Union covers all four entity types — no loss.
 */
const RESOURCE_ENTITY_TYPES: Readonly<Record<string, ReadonlySet<SettlementEntityType>>> = {
  'settlements.payments': new Set<SettlementEntityType>(['payment', 'refund']),
  'settlements.reserves': new Set<SettlementEntityType>(['reserve_deduction']),
  'settlements.adjustments': new Set<SettlementEntityType>(['adjustment']),
};

/**
 * A date-windowed settlement fetcher scoped to one entity_type partition. One instance backs one
 * resource (payments | reserves | adjustments); they share the recon/combined endpoint and differ
 * only by the entity_type set they keep.
 */
class RazorpaySettlementsFetcher implements IResourcePageFetcher {
  private readonly client: RazorpaySettlementsClient;

  constructor(
    credentials: RazorpayApiCredentials,
    private readonly brandId: string,
    private readonly saltHex: string,
    /** The entity_type partition this resource keeps (others are skipped — owned by a sibling resource). */
    private readonly entityTypes: ReadonlySet<SettlementEntityType>,
  ) {
    // The client consumes key_id/key_secret into an in-memory Basic-auth header and drops them; the
    // raw credentials never escape this scope and are NEVER logged (I-S09).
    this.client = new RazorpaySettlementsClient(credentials);
  }

  async fetchPage(args: {
    resource: ResourceDescriptor;
    cursor: string | null;
    floorAt: Date;
  }): Promise<ResourcePage> {
    const nowTs = Math.floor(Date.now() / 1000);
    const floorTs = Math.floor(args.floorAt.getTime() / 1000);

    // The cursor is the Unix-seconds UPPER edge of the next (older) window. On the first call (null)
    // we anchor at "now" and walk backward.
    const toTs = args.cursor ? parseInt(args.cursor, 10) : nowTs;
    // Defensive: a cursor already at/below the floor means the walk is exhausted.
    if (!Number.isFinite(toTs) || toTs < floorTs) {
      return { records: [], nextCursor: null };
    }

    // Non-overlapping window: [fromTs, toTs]; the next window will be [.., fromTs-1]. Clamp the
    // lower edge to the floor on the final window.
    let fromTs = toTs - WINDOW_SEC + 1;
    let reachedFloor = false;
    if (fromTs <= floorTs) {
      fromTs = floorTs;
      reachedFloor = true;
    }

    // Fetch the FULL window (all skip-offset pages). A 401 throws RAZORPAY_AUTH_ERROR which PROPAGATES
    // so the driver fails the run and preserves the cursor for resume. The token is never logged.
    const items: RazorpayReconItem[] = await this.client.fetchAllReconItems(fromTs, toTs);

    const records: FetchedRecord[] = [];
    let oldest: Date | undefined;
    for (const item of items) {
      // REUSE the frozen mapper: field allowlist + C1 boundary hashing + I-S07 integer-paisa money.
      // brand_id is the connector row's (MT-1) — never from the API item.
      const mapped = mapSettlementItemToEvent(item as RazorpaySettlementItem, this.brandId, this.saltHex);
      const entityType = mapped.properties.entity_type;
      // Partition filter: this fact belongs to a sibling resource — skip it here (no double-count).
      if (!this.entityTypes.has(entityType)) continue;

      // ── CROSS-LANE ID PARITY (revenue-truth invariant) ──────────────────────
      // Compute event_id by calling the SAME mapper id fn the live re-pull lane uses
      // (razorpay-settlement-repull/run.ts), with the SAME RAW arg values — so a record
      // backfilled here derives a BYTE-IDENTICAL event_id to its live counterpart and Bronze
      // deduplicates the two (no double-count). The seeds live ONLY in @brain/razorpay-mapper
      // (uuidV5FromSettlementItem / uuidV5FromSettlementSummary) so the two lanes can never drift.
      //
      // NB: the id-fn args are the RAW recon-item values (raw settlement_id, raw payment_id —
      // NOT the hashed payment_id_hash). The seed string itself is never logged/persisted; only the
      // resulting uuid-shaped id survives this boundary (C1 / I-S09).
      const settlementId = item.settlement_id ? String(item.settlement_id) : '';
      const rawPaymentId = item.payment_id ? String(item.payment_id) : null;
      const isBrandLevel = mapped.properties.reconciliation_type === 'brand_level';

      const eventId =
        isBrandLevel || !rawPaymentId
          ? // brand-level path (reserve/adjustment, or any item with no payment_id) — :summary: token
            uuidV5FromSettlementSummary(this.brandId, settlementId)
          : // per-payment path — entityType discriminator
            uuidV5FromSettlementItem(this.brandId, settlementId, rawPaymentId, entityType);

      const draft: CanonicalEventDraft = {
        event_name: mapped.event_name,
        occurred_at: mapped.occurred_at,
        // Provenance WITHOUT event_id — the driver stamps the precomputed id (providerId) below.
        provenance: { brand_id: this.brandId, source: 'razorpay' },
        properties: mapped.properties as unknown as Record<string, unknown>,
      };

      records.push({
        // Carry the precomputed live-parity event_id verbatim; the manifest's 'provider_id' dedup
        // strategy + the shared precomputedEventIdDeriver pass it through unchanged as the event_id.
        providerId: eventId,
        events: [draft],
      });

      const occurredAt = new Date(mapped.occurred_at);
      if (!Number.isNaN(occurredAt.getTime()) && (!oldest || occurredAt < oldest)) {
        oldest = occurredAt;
      }
    }

    // null nextCursor ⇒ window exhausted (floor reached). Otherwise the next window's upper edge.
    const nextCursor = reachedFloor ? null : String(fromTs - 1);
    return { records, nextCursor, ...(oldest ? { oldestOccurredAt: oldest } : {}) };
  }
}

/**
 * buildRazorpayResourceFetcher — the NAMING-CONTRACT factory the generic ingestion-backfill job calls
 * to obtain a Razorpay IResourcePageFetcher. The args mirror the shopify/woo getFetcher shape; `pool`
 * + `connectorInstanceId` are unused for Razorpay (the resolved `secrets` are self-sufficient) but are
 * accepted to keep one uniform builder signature across connectors. Throws on an unknown resource name
 * (fail-loud, like the shopify/woo switch defaults).
 */
export function buildRazorpayResourceFetcher(args: {
  pool: Pool;
  connectorInstanceId: string;
  resource: string;
  brandId: string;
  saltHex: string;
  secrets: RazorpayApiCredentials;
}): IResourcePageFetcher {
  const entityTypes = RESOURCE_ENTITY_TYPES[args.resource];
  if (!entityTypes) {
    throw new Error(
      `[razorpay-resource-fetchers] resource "${args.resource}" has no fetcher here ` +
        `(known: ${Object.keys(RESOURCE_ENTITY_TYPES).join(', ')})`,
    );
  }
  return new RazorpaySettlementsFetcher(args.secrets, args.brandId, args.saltHex, entityTypes);
}
