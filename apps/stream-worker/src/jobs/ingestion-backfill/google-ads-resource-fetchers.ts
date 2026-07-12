/**
 * google-ads-resource-fetchers.ts — IResourcePageFetcher implementation for the Google Ads
 * `spend` resource onboarded onto the generic resumable backfill framework (runResumableBackfill).
 *
 * The fetcher is the ONLY connector-authored code the framework needs to gain a full resumable
 * historical backfill: "given a cursor, return the next page of records + the next cursor". It owns
 * NOTHING about checkpointing, resumption, dedup, retries, or DB state — the generic driver owns all
 * of that. This file simply walks Google Ads spend one date-window chunk at a time, oldest-ward, and
 * maps each raw GAQL row → CanonicalEventDraft via the EXISTING pure ad-spend mapper.
 *
 * PAGING (date_window): the framework cursor encodes the NEXT chunk's newest edge (YYYY-MM-DD). On
 * the first call (cursor=null) the anchor is "today"; each fetchPage streams [chunkFrom, chunkTo] for
 * all three GAQL levels (campaign / ad_group / ad), then returns the next-older edge as the cursor —
 * or null once chunkFrom has reached floorAt (window exhausted → driver marks completed).
 *
 * DEDUP / MONEY / PII (reuse, never re-implement):
 *   - mapGoogleRowToEvent (@brain/ad-spend-mapper) does ALL money work: cost_micros → minor units +
 *     the sibling currency_code (I-S07, integer-only, no float). We do NOT touch money here.
 *   - The event_id is PRECOMPUTED here by calling the SAME id fn the live/repull lane uses —
 *     uuidV5FromSpendRow(brandId, 'google_ads', stat_date, level, level_id) (@brain/ad-spend-mapper)
 *     — and carried as FetchedRecord.providerId. The driver's passthrough (provider_id) deriver
 *     returns it verbatim as the Bronze event_id, so a backfilled spend row gets the BYTE-IDENTICAL
 *     event_id as the live trailing-window repull → Bronze MERGE dedups across lanes (no double-
 *     count). We CALL the mapper fn (never re-implement the seed inline) so the two lanes can't drift.
 *   - Spend rows carry no PII, so there is no hashing to do here.
 *
 * AUTH / RATE LIMITS: the SearchStream client THROWS on auth failure (GOOGLE_AUTH_ERROR), a disabled
 * account (GOOGLE_ACCOUNT_DISABLED), or quota exhaustion (GOOGLE_RESOURCE_EXHAUSTED / TEMPORARILY).
 * We let those propagate UNCAUGHT: the driver fails the run and PRESERVES the cursor so a later run
 * resumes from the same chunk (never restarts). Tokens/secrets are NEVER logged (I-S09).
 *
 * MT-1: brand_id is the connector row's (passed into the builder), stamped onto every draft's
 * provenance AND fed into the event_id seed — NEVER read from an API response.
 */

import type {
  IResourcePageFetcher,
  ResourcePage,
  FetchedRecord,
  ResourceDescriptor,
  CanonicalEventDraft,
} from '@brain/connector-core';
import { mapGoogleRowToEvent, uuidV5FromSpendRow, googleBreakdownKey } from '@brain/ad-spend-mapper';
import {
  GoogleAdsSearchStreamClient,
  type GoogleAdsCredentials,
} from '../google-ads-spend-repull/google-ads-searchstream-client.js';
import type { Pool } from 'pg';

/** GAQL levels pulled per chunk — campaign / ad_group(→adset) / ad (mirrors the live repull). */
const GOOGLE_LEVELS: ReadonlyArray<'campaign' | 'adset' | 'ad'> = ['campaign', 'adset', 'ad'];
/** Date-window chunk size (days). 30 keeps each chunk under Google's daily ops-quota footprint. */
const CHUNK_DAYS = 30;

/** FIREHOSE date-window views onboarded as their own backfill resources (each one GAQL view). */
const FIREHOSE_RESOURCES: ReadonlySet<string> = new Set([
  'spend_by_device', 'ad_schedule', 'keyword', 'search_term', 'geo',
  'age_range', 'gender', 'shopping_product', 'click', 'conversion_action',
]);

interface BuildGoogleAdsResourceFetcherArgs {
  pool: Pool;
  connectorInstanceId: string;
  resource: string;
  brandId: string;
  saltHex: string;
  secrets: GoogleAdsCredentials;
}

/**
 * buildGoogleAdsResourceFetcher — the NAMING-CONTRACT entrypoint the generic ingestion-backfill job
 * calls (mirrors the shopify/woo getFetcher shape). Returns an IResourcePageFetcher for the named
 * resource; throws on an unknown resource (fail-loud, like the shopify/woo switch defaults).
 */
export function buildGoogleAdsResourceFetcher(
  args: BuildGoogleAdsResourceFetcherArgs,
): IResourcePageFetcher {
  if (args.resource === 'spend') {
    return new GoogleAdsSpendFetcher(args.secrets, args.brandId);
  }
  if (FIREHOSE_RESOURCES.has(args.resource)) {
    return new GoogleAdsFirehoseFetcher(args.secrets, args.brandId, args.resource);
  }
  throw new Error(
    `[ingestion-backfill] google_ads resource "${args.resource}" has no fetcher here`,
  );
}

/**
 * GoogleAdsSpendFetcher — date-window backfill of daily spend via GAQL SearchStream. One framework
 * page == one date-window chunk (all three GAQL levels), walked from the anchor back toward floorAt.
 */
class GoogleAdsSpendFetcher implements IResourcePageFetcher {
  private readonly client: GoogleAdsSearchStreamClient;
  private authed = false;

  constructor(
    secrets: GoogleAdsCredentials,
    private readonly brandId: string,
  ) {
    // secrets (refresh_token / developer_token / client_secret) live in memory only — NEVER logged.
    this.client = new GoogleAdsSearchStreamClient(secrets);
  }

  async fetchPage(args: {
    resource: ResourceDescriptor;
    cursor: string | null;
    floorAt: Date;
  }): Promise<ResourcePage> {
    // Authenticate once per run (the driver reuses this fetcher across pages). A revoked/invalid
    // refresh token THROWS here → the driver fails the run + preserves the cursor (I-S09: no token logged).
    if (!this.authed) {
      await this.client.authenticate();
      this.authed = true;
    }

    const floorDate = isoDate(args.floorAt);
    // cursor encodes the newest edge of the chunk to fetch (YYYY-MM-DD); null ⇒ first page (today).
    const chunkTo = args.cursor ?? isoDate(new Date());

    // Already past the floor (defensive — the driver should not call us, but stop cleanly if it does).
    if (chunkTo < floorDate) {
      return { records: [], nextCursor: null };
    }

    const chunkFrom = maxDate(isoDate(addDays(parseIsoDate(chunkTo), -(CHUNK_DAYS - 1))), floorDate);

    const records: FetchedRecord[] = [];
    let oldest: Date | undefined;

    for (const level of GOOGLE_LEVELS) {
      // streamLevel THROWS on auth / account-disabled / quota exhaustion — let it propagate so the
      // driver fails the run and preserves the cursor (resume from this same chunk next run).
      const rows = await this.client.streamLevel(level, chunkFrom, chunkTo);
      for (const raw of rows) {
        // Currency authority is the row's own customer.currency_code; the mapper handles the fallback.
        const accountCurrency = raw.currency_code ?? 'USD';
        const mapped = mapGoogleRowToEvent(raw, accountCurrency, null);
        const props = mapped.properties;
        // A spend row with no stat_date / level_id cannot form the composite dedup identity — skip it
        // (it would otherwise mint a malformed event_id). Mirrors the live emitRows guard.
        const statDate = props.stat_date;
        const levelId = props.level_id;
        if (!statDate || !levelId) continue;

        const draft: CanonicalEventDraft = {
          event_name: mapped.event_name,
          occurred_at: mapped.occurred_at,
          provenance: { brand_id: this.brandId, source: 'google_ads' }, // MT-1 — never from the API
          properties: props as unknown as Record<string, unknown>,
        };

        records.push({
          // BYTE-EXACT cross-lane id parity: call the SAME id fn the live repull uses
          // (google-ads-spend-repull/run.ts emitRows) with the SAME args — brandId, the
          // 'google_ads' platform literal, stat_date, level, level_id + breakdownKey. Base spend rows
          // carry no segment dims → googleBreakdownKey === '' → byte-identical to the live base id.
          providerId: uuidV5FromSpendRow(
            this.brandId, 'google_ads', statDate, props.level, levelId, googleBreakdownKey(props),
          ),
          events: [draft],
        });

        const occ = new Date(mapped.occurred_at);
        if (!Number.isNaN(occ.getTime()) && (!oldest || occ < oldest)) oldest = occ;
      }
    }

    // Reached the floor on this chunk → no more pages (driver marks the resource completed).
    const reachedFloor = chunkFrom <= floorDate;
    const nextCursor = reachedFloor ? null : isoDate(addDays(parseIsoDate(chunkFrom), -1));
    // Floor the reachedAt to the chunk's oldest date so the driver's floor check advances even when a
    // chunk returns no rows (an empty spend day must still move the cursor older).
    const oldestOccurredAt = oldest ?? parseIsoDate(chunkFrom);

    return { records, nextCursor, oldestOccurredAt };
  }
}

/**
 * GoogleAdsFirehoseFetcher — date-window backfill of a single FIREHOSE view (device/keyword/search-
 * term/geo/demo/shopping/click/conversion-action) via GAQL SearchStream. One framework page == one
 * date-window chunk of that one view. Identical resumable/checkpoint contract to the base spend
 * fetcher; the ONLY difference is it streams `streamResource(view)` and folds the view's segment dims
 * into the breakdownKey seed → a distinct, collision-free Bronze event_id per breakdown row.
 */
class GoogleAdsFirehoseFetcher implements IResourcePageFetcher {
  private readonly client: GoogleAdsSearchStreamClient;
  private authed = false;

  constructor(
    secrets: GoogleAdsCredentials,
    private readonly brandId: string,
    private readonly viewResource: string,
  ) {
    this.client = new GoogleAdsSearchStreamClient(secrets);
  }

  async fetchPage(args: {
    resource: ResourceDescriptor;
    cursor: string | null;
    floorAt: Date;
  }): Promise<ResourcePage> {
    if (!this.authed) {
      await this.client.authenticate();
      this.authed = true;
    }

    const floorDate = isoDate(args.floorAt);
    const chunkTo = args.cursor ?? isoDate(new Date());
    if (chunkTo < floorDate) {
      return { records: [], nextCursor: null };
    }
    const chunkFrom = maxDate(isoDate(addDays(parseIsoDate(chunkTo), -(CHUNK_DAYS - 1))), floorDate);

    const records: FetchedRecord[] = [];
    let oldest: Date | undefined;

    // streamResource THROWS on auth / account-disabled / quota exhaustion — let it propagate so the
    // driver fails the run and preserves the cursor (resume from this same chunk next run).
    const rows = await this.client.streamResource(this.viewResource, chunkFrom, chunkTo);
    for (const raw of rows) {
      const accountCurrency = raw.currency_code ?? 'USD';
      const mapped = mapGoogleRowToEvent(raw, accountCurrency, null);
      const props = mapped.properties;
      const statDate = props.stat_date;
      const levelId = props.level_id;
      if (!statDate || !levelId) continue;

      const draft: CanonicalEventDraft = {
        event_name: mapped.event_name,
        occurred_at: mapped.occurred_at,
        provenance: { brand_id: this.brandId, source: 'google_ads' }, // MT-1 — never from the API
        properties: props as unknown as Record<string, unknown>,
      };

      records.push({
        // The breakdownKey folds this view's segment dims → a distinct id from base spend + every
        // other breakdown row. SAME id fn as live → backfill↔live parity within the view.
        providerId: uuidV5FromSpendRow(
          this.brandId, 'google_ads', statDate, props.level, levelId, googleBreakdownKey(props),
        ),
        events: [draft],
      });

      const occ = new Date(mapped.occurred_at);
      if (!Number.isNaN(occ.getTime()) && (!oldest || occ < oldest)) oldest = occ;
    }

    const reachedFloor = chunkFrom <= floorDate;
    const nextCursor = reachedFloor ? null : isoDate(addDays(parseIsoDate(chunkFrom), -1));
    const oldestOccurredAt = oldest ?? parseIsoDate(chunkFrom);

    return { records, nextCursor, oldestOccurredAt };
  }
}

// ── date helpers (UTC, YYYY-MM-DD) ───────────────────────────────────────────────

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function parseIsoDate(ymd: string): Date {
  return new Date(`${ymd}T00:00:00Z`);
}
function addDays(d: Date, days: number): Date {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + days);
  return r;
}
function maxDate(a: string, b: string): string {
  return a >= b ? a : b;
}
