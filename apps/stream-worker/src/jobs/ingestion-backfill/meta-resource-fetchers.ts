/**
 * meta-resource-fetchers.ts — IResourcePageFetcher implementation for the Meta (Facebook/Instagram)
 * Ads connector onboarded onto the resumable backfill framework: the single `insights` resource
 * (daily ad spend + platform-attributed conversions, date-windowed).
 *
 * This is the ONLY connector-authored code the framework needs to gain a full resumable backfill of
 * Meta insights history: "given a cursor, return the next (older) date-window page of mapped records
 * + the next cursor". It knows NOTHING about checkpointing, resumption, dedup, retries, or DB state —
 * the generic `runResumableBackfill` driver owns all of that.
 *
 * PAGING (date_window): Meta insights are anchored by stat-date (click-date). One framework page ==
 * one bounded date window [since, until] (default 30 days), fetched across ALL hierarchy levels
 * (campaign/adset/ad) and fully cursor-paged within the window via the EXISTING MetaInsightsClient
 * (the async ad_report_run path is forced — historical month-wide pulls are large). The framework
 * cursor is the next (older) window's `until` edge (an ISO date string); a null nextCursor at the
 * floor ends the walk. We walk BACKWARD from the anchor (today) toward `floorAt`.
 *
 * MAPPING / MONEY / PII: every raw row is mapped by the FROZEN, currency-aware @brain/ad-spend-mapper
 * `mapMetaInsightToEvent` (the SAME mapper the live meta-spend-repull uses) — spend (major-unit
 * decimal) → BIGINT minor units paired with the account `currency_code` (I-S07, no float, never
 * blended); account currency comes from the account, not the row. Ad spend carries no contact PII
 * (ad-identifiers are operational refs — I-S02). We never re-map money/PII here.
 *
 * DEDUP (cross-lane byte-exact): each record carries a PRECOMPUTED `providerId` = the live lane's
 * `uuidV5FromSpendRow(brandId, 'meta', stat_date, level, level_id)` event_id — computed by CALLING the
 * mapper's own id fn (the exact one meta-spend-repull/run.ts emitPage uses), never re-implemented
 * inline. The manifest declares `dedupKeyStrategy: 'provider_id'`, so the shared passthrough deriver
 * (precomputedEventIdDeriver) returns that providerId verbatim as the Bronze event_id. Result: a
 * backfilled daily row and the same row from the 28-day live repull get the SAME event_id by
 * construction → Bronze MERGE dedups → no double-count (revenue-truth). This also makes resume/replay
 * within this backfill lane idempotent (same inputs → same id). The two lanes can never drift because
 * both go through the one frozen mapper fn.
 *
 * AUTH: a token-expiry / persistent-throttle surfaces as a THROWN error from the client
 * (META_AUTH_ERROR / META_RATE_LIMITED); the driver fails the run and PRESERVES the cursor for a later
 * resume (it never restarts). The access_token is NEVER logged (I-S09) — neither the client nor this
 * file logs it.
 */

import type { Pool } from 'pg';
import type {
  IResourcePageFetcher,
  ResourcePage,
  FetchedRecord,
  ResourceDescriptor,
  CanonicalEventDraft,
} from '@brain/connector-core';
import { mapMetaInsightToEvent, uuidV5FromSpendRow } from '@brain/ad-spend-mapper';
import {
  MetaInsightsClient,
  META_ACCESS_FORBIDDEN,
  type MetaApiCredentials,
  type MetaAccountMeta,
} from '../meta-spend-repull/meta-insights-client.js';
import { log } from '../../log.js';

/** Default date-window span (days) per framework page. Mirrors the bespoke meta backfill chunk. */
const WINDOW_DAYS = 30;

/** The hierarchy levels to pull (Meta Insights level param) — same set as the live re-pull. */
const META_LEVELS: ReadonlyArray<'campaign' | 'adset' | 'ad'> = ['campaign', 'adset', 'ad'];

/** Provider id — the dedup namespace + provenance source (matches CONNECTOR_CATALOG). */
const META_SOURCE = 'meta' as const;

// ── Date utils (UTC, date-only) ────────────────────────────────────────────────

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function parseIsoDate(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}
function addDays(d: Date, days: number): Date {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + days);
  return r;
}

// ── Insights fetcher (date_window, walked backward toward the floor) ────────────

/**
 * Pages Meta daily insights one date window at a time, newest→oldest, across all levels. Account
 * meta (currency + timezone) is fetched once and cached on the instance (the currency authority is
 * the account, not the row — I-S07). Stateless across framework calls otherwise: all resume state
 * lives in the cursor the driver passes back in.
 */
export class MetaInsightsFetcher implements IResourcePageFetcher {
  private readonly client: MetaInsightsClient;
  private accountMeta: MetaAccountMeta | null = null;

  constructor(
    secrets: MetaApiCredentials,
    private readonly brandId: string,
  ) {
    this.client = new MetaInsightsClient(secrets);
  }

  async fetchPage(args: {
    resource: ResourceDescriptor;
    cursor: string | null;
    floorAt: Date;
  }): Promise<ResourcePage> {
    const floorIso = isoDate(args.floorAt);
    // The cursor is the next window's `until` edge; absent (first page) → anchor at today.
    const untilIso = args.cursor ?? isoDate(new Date());

    // Already at/below the floor → nothing left to walk (driver marks completed on null cursor).
    if (untilIso < floorIso) {
      return { records: [], nextCursor: null };
    }

    // Compute this window [sinceIso, untilIso], clamped so it never crosses the floor.
    const candidateSince = isoDate(addDays(parseIsoDate(untilIso), -(WINDOW_DAYS - 1)));
    const sinceIso = candidateSince < floorIso ? floorIso : candidateSince;

    // Resolve account currency + timezone ONCE (currency authority = account, not row). A token
    // failure here THROWS (META_AUTH_ERROR) → the driver preserves the cursor for a later resume.
    if (!this.accountMeta) {
      this.accountMeta = await this.client.fetchAccountMeta();
    }
    const { currencyCode, timezoneName } = this.accountMeta;

    const records: FetchedRecord[] = [];

    try {
      for (const level of META_LEVELS) {
        // Fetch the WHOLE window for this level. The client uses the SYNC insights GET (cursor-paged)
        // and ADAPTIVELY halves the window on Meta code 2637 ("reduce the amount of data"). A throttle /
        // auth error still THROWS and is propagated (the driver preserves the cursor for resume).
        const rawRows = await this.client.fetchInsightsForWindow(level, sinceIso, untilIso);
        for (const raw of rawRows) {
          const mapped = mapMetaInsightToEvent(raw, currencyCode, timezoneName);
          const props = mapped.properties;
          // Skip rows missing the dedup grain (stat_date / level_id) — same guard as the live lane.
          if (!props.stat_date || !props.level_id) continue;

          const draft: CanonicalEventDraft = {
            event_name: mapped.event_name,
            occurred_at: mapped.occurred_at,
            provenance: { brand_id: this.brandId, source: META_SOURCE }, // brand_id from connector row (MT-1)
            properties: props as unknown as Record<string, unknown>,
          };
          // CROSS-LANE ID PARITY: compute the event_id by calling the SAME mapper id fn the live
          // meta-spend-repull lane uses — uuidV5FromSpendRow(brandId, 'meta', stat_date, level, level_id)
          // (meta-spend-repull/run.ts emitPage). Carry it as providerId so the passthrough deriver
          // (precomputedEventIdDeriver) returns it verbatim as the Bronze event_id → backfilled rows
          // share the live id byte-for-byte → Bronze MERGE dedups, no double-count. We CALL the mapper
          // fn (never re-implement the seed) so the two lanes can never drift.
          const providerId = uuidV5FromSpendRow(
            this.brandId, META_SOURCE, props.stat_date, props.level, props.level_id,
          );
          records.push({ providerId, events: [draft] });
        }
      }
    } catch (err) {
      // Meta 403 while walking OLDER windows = the accessible-history boundary (the live lane reads
      // recent data fine, so it is NOT a token problem). Stop the walk GRACEFULLY at the achieved depth:
      // return whatever this window yielded before the 403 with a null cursor so the resumable driver
      // marks the resource COMPLETED (not FAILED). Every other error propagates (cursor-preserving resume).
      if (String(err).includes(META_ACCESS_FORBIDDEN)) {
        log.info(
          `[meta-backfill] Meta 403 at window ${sinceIso}..${untilIso} — accessible-history boundary; ` +
          `completing backfill at achieved depth (${records.length} record(s) this window)`,
        );
        return { records, nextCursor: null, oldestOccurredAt: parseIsoDate(sinceIso) };
      }
      throw err;
    }

    // Next (older) window's `until` edge is the day before this window's `since` (no overlap, no gap).
    // When this window already reaches the floor, end the walk (null cursor → driver completes).
    const nextCursor = sinceIso <= floorIso ? null : isoDate(addDays(parseIsoDate(sinceIso), -1));

    // reachedAt = the floor of the window we just SCANNED (covers sparse windows with no rows, so the
    // driver's reachedAt advances monotonically toward floorAt regardless of data density).
    return { records, nextCursor, oldestOccurredAt: parseIsoDate(sinceIso) };
  }
}

/**
 * buildMetaResourceFetcher — the NAMING-CONTRACT factory the generic ingestion-backfill dispatcher
 * (ingestion-backfill/run.ts) calls. Mirrors the shopify/woo getFetcher shape:
 * { pool, connectorInstanceId, resource, brandId, saltHex, secrets }. `secrets` is the resolved typed
 * MetaApiCredentials from the connector's EXISTING repull resolver (resolveMetaCredentials) — the
 * access_token is held in memory only, NEVER logged (I-S09). Throws on an unknown resource (fail loud,
 * like the shopify/woo switch defaults). pool/connectorInstanceId/saltHex are part of the shared
 * builder contract; the Meta insights resource needs none of them (no PII salt — ad spend has no
 * contact PII, I-S02 — and no extra DB read beyond the connector row the dispatcher already loaded).
 */
export function buildMetaResourceFetcher(args: {
  pool: Pool;
  connectorInstanceId: string;
  resource: string;
  brandId: string;
  saltHex: string;
  secrets: MetaApiCredentials;
}): IResourcePageFetcher {
  switch (args.resource) {
    case 'insights':
      return new MetaInsightsFetcher(args.secrets, args.brandId);
    default:
      throw new Error(`[ingestion-backfill] meta resource "${args.resource}" has no fetcher here`);
  }
}
