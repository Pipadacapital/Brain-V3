/**
 * ga4-resource-fetchers.ts — IResourcePageFetcher for the GA4 `ga4.sessions` resource onboarded onto
 * the resumable backfill framework.
 *
 * This is the ONLY connector-authored code the framework needs to gain a full resumable historical
 * backfill of GA4 sessions: "given a cursor, return the next page of records + the next cursor". It
 * knows NOTHING about checkpointing, resume, dedup, retries, or DB state — the generic
 * `runResumableBackfill` driver owns all of that. It maps each GA4 runReport row → CanonicalEventDraft
 * via the PURE @brain/ga4-mapper (`mapGa4RowToEvent`) — money is converted to BIGINT-as-string minor
 * units + currency THERE (I-S07), and the field allowlist drops anything non-canonical (I-S02). We do
 * NOT re-map money/PII here.
 *
 * PAGING (date_window): GA4 has no record cursor. We walk one bounded DATE WINDOW at a time, newest →
 * oldest, and the framework cursor is the next (older) window's inclusive END date (YYYY-MM-DD). On the
 * first call (cursor=null) the first window ends "today". When a window's start reaches the historical
 * floor (driver-supplied `floorAt`, clamped to the manifest's 24-month window) the fetcher returns
 * nextCursor=null → the driver marks the resource completed. Because the cursor is a calendar date,
 * resume after a pause/crash is exact and deterministic.
 *
 * DEDUP (precomputed id — cross-lane parity): a GA4 session report row has no single upstream id, but
 * its identity IS the dimension tuple. To guarantee a backfilled session and the SAME session pulled by
 * the live ga4-repull lane derive a BYTE-IDENTICAL event_id (so Bronze dedups instead of double-counting
 * history against live revenue), the fetcher computes the id with the connector's OWN live id fn —
 * `uuidV5FromGa4Row` from @brain/ga4-mapper, called with the EXACT same args ga4-repull/run.ts uses —
 * and carries it verbatim on `FetchedRecord.providerId`. The driver's shared precomputedEventIdDeriver
 * stamps it through unchanged. We do NOT re-derive identity from a composite tuple here.
 *
 * INVARIANTS:
 *   - MT-1: brand_id is the connector row's (passed into the builder), NEVER from the GA4 API response.
 *   - I-S07: money via the existing mapper (minor units + currency_code) — never a float/blend here.
 *   - I-S09: the OAuth refresh token / access token is NEVER logged. On auth (or quota) failure the
 *     client THROWS; this fetcher lets it propagate so the driver fails the run and PRESERVES the
 *     cursor for a later resume (it never restarts from scratch).
 */

import type { Pool } from 'pg';
import type {
  IResourcePageFetcher,
  ResourcePage,
  FetchedRecord,
  ResourceDescriptor,
  CanonicalEventDraft,
} from '@brain/connector-core';
import { mapGa4RowToEvent, uuidV5FromGa4Row } from '@brain/ga4-mapper';
import { Ga4DataClient, type Ga4Credentials } from '../ga4-repull/ga4-data-client.js';

/** The single backfillable GA4 resource (matches GA4_INGESTION_MANIFEST). */
const GA4_SESSIONS_RESOURCE = 'ga4.sessions';

/** Default per-window day count when the manifest descriptor omits pageSize (mirrors the live repull). */
const DEFAULT_WINDOW_DAYS = 28;

/**
 * Last-resort GA4 reporting currency for LEGACY bundles connected before the credential connect
 * captured `currency_code`. New connects carry the property currency on the resolved credentials
 * (creds.currencyCode) — that always wins; USD is only the fallback for old bundles.
 */
const DEFAULT_CURRENCY = 'USD';

/**
 * Build the GA4 page-fetcher. Mirrors the shopify/woo getFetcher shape:
 *   { pool, connectorInstanceId, resource, brandId, saltHex, secrets }.
 * `secrets` is the resolved typed credential bundle from ga4-repull's resolveGa4Credentials. GA4 needs
 * neither the pool, connectorInstanceId, nor the salt (no DB read, no PII to hash — runReport rows
 * carry no contact PII), but the full arg shape is accepted to match the dispatcher contract.
 *
 * Throws on an unknown resource name (fail-loud), like the shopify/woo switch defaults.
 */
export function buildGa4ResourceFetcher(args: {
  pool: Pool;
  connectorInstanceId: string;
  resource: string;
  brandId: string;
  saltHex: string;
  secrets: Ga4Credentials;
}): IResourcePageFetcher {
  if (args.resource !== GA4_SESSIONS_RESOURCE) {
    throw new Error(
      `[ga4-backfill] resource "${args.resource}" has no fetcher here (only ${GA4_SESSIONS_RESOURCE})`,
    );
  }
  return new Ga4SessionsFetcher(args.secrets, args.brandId);
}

/**
 * Walks GA4 sessions one date window at a time, newest → oldest, until the window start reaches the
 * driver-supplied historical floor. Stateless across the framework boundary — the only mutable state
 * is the in-memory access token, cached so we authenticate once per fetcher instance.
 */
class Ga4SessionsFetcher implements IResourcePageFetcher {
  private readonly client: Ga4DataClient;
  private authenticated = false;

  constructor(
    private readonly creds: Ga4Credentials,
    /** Tenant key — from the connector row, NEVER from the GA4 API response (MT-1). */
    private readonly brandId: string,
  ) {
    this.client = new Ga4DataClient(creds);
  }

  async fetchPage(args: {
    resource: ResourceDescriptor;
    cursor: string | null;
    floorAt: Date;
  }): Promise<ResourcePage> {
    const { resource, cursor, floorAt } = args;
    const windowDays = resource.pageSize && resource.pageSize > 0 ? resource.pageSize : DEFAULT_WINDOW_DAYS;
    const floorDate = isoDate(floorAt);

    // The date_window cursor is the inclusive END date of the next window to fetch (newest→oldest).
    // Null on the first call → anchor the first window at "today".
    const windowEnd = cursor ?? isoDate(new Date());

    // Defensive: a cursor already past the floor means the walk is exhausted (no-op completion).
    if (windowEnd < floorDate) {
      return { records: [], nextCursor: null };
    }

    // windowStart = windowEnd - (windowDays - 1), clamped to the floor. Reaching the floor marks the
    // final (oldest) window → nextCursor becomes null after this page.
    let windowStart = isoDate(addDays(parseIsoDate(windowEnd), -(windowDays - 1)));
    let reachedFloor = false;
    if (windowStart <= floorDate) {
      windowStart = floorDate;
      reachedFloor = true;
    }

    // Authenticate once (token cached in-memory; NEVER logged — I-S09). An auth failure THROWS, which
    // the driver catches by failing the run and PRESERVING the cursor for a later resume.
    if (!this.authenticated) {
      await this.client.authenticate();
      this.authenticated = true;
    }

    // runReport throws GA4_AUTH_ERROR / GA4_QUOTA_EXHAUSTED — let it propagate so the cursor is
    // preserved (the driver fails the run; the next claimer tick resumes from this same window).
    const result = await this.client.runReport(windowStart, windowEnd);

    const records: FetchedRecord[] = [];
    let oldest: Date | undefined;
    for (const raw of result.rows) {
      // REUSE the pure GA4 mapper: revenue → minor units + currency (I-S07); field allowlist (I-S02).
      // Currency = the property reporting currency captured at connect (creds), USD only for
      // legacy bundles — SAME precedence as the live ga4-repull lane (cross-lane parity).
      const mapped = mapGa4RowToEvent(
        raw,
        this.creds.propertyId,
        this.creds.currencyCode ?? DEFAULT_CURRENCY,
        result.sampling,
      );
      const props = mapped.properties;
      if (!props.date) continue; // dedup grain is undefined without a date — skip (mirrors live repull)

      const draft: CanonicalEventDraft = {
        event_name: mapped.event_name,
        occurred_at: mapped.occurred_at,
        properties: props as unknown as Record<string, unknown>,
        // brand_id from the connector row (MT-1); the driver stamps the precomputed event_id.
        provenance: { brand_id: this.brandId, source: 'ga4' },
      };

      // ID PARITY (revenue-truth): compute the event_id with the connector's OWN live id fn
      // (uuidV5FromGa4Row), called with the EXACT same args the live ga4-repull lane uses
      // (ga4-repull/run.ts emitRows). Carried verbatim on FetchedRecord.providerId, the shared
      // precomputedEventIdDeriver stamps it through unchanged → a backfilled GA4 session gets the
      // byte-identical event_id as live, so Bronze dedups instead of double-counting. brand_id and
      // property_id are from the connector row/creds (MT-1), NEVER from the GA4 API response.
      const eventId = uuidV5FromGa4Row(
        this.brandId,             // MT-1 — never from API response
        this.creds.propertyId,    // same value the live lane passes (creds.propertyId)
        props.date,
        props.session_source ?? '',
        props.session_medium ?? '',
        props.session_campaign_name ?? '',
        props.session_default_channel_group ?? '',
        props.device_category ?? '',
        props.country ?? '',
      );

      records.push({
        // Precomputed live/repull id carried verbatim — the passthrough deriver uses providerId.
        providerId: eventId,
        events: [draft],
      });

      const occ = new Date(mapped.occurred_at);
      if (!oldest || occ < oldest) oldest = occ;
    }

    const nextCursor = reachedFloor ? null : isoDate(addDays(parseIsoDate(windowStart), -1));
    // oldestOccurredAt drives the driver's reachedAt checkpoint + floor check. With rows, use the
    // oldest row's time; otherwise fall back to the window-start midnight so reachedAt still advances
    // toward the floor across empty (zero-session) windows.
    const oldestOccurredAt = oldest ?? parseIsoDate(windowStart);
    return { records, nextCursor, oldestOccurredAt };
  }
}

// ── Date utils (UTC, calendar-day granular — matches GA4's date dimension) ────────

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function parseIsoDate(isoYmd: string): Date {
  return new Date(`${isoYmd}T00:00:00.000Z`);
}

function addDays(d: Date, days: number): Date {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + days);
  return r;
}
