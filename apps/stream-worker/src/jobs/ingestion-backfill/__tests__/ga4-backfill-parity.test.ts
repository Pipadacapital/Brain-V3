/**
 * ga4-backfill-parity.test.ts — CROSS-LANE event_id PARITY for the GA4 backfill fetcher.
 *
 * THE INVARIANT (revenue-truth / no-double-count): a GA4 session pulled by the resumable BACKFILL
 * fetcher must derive the SAME Bronze event_id as the SAME session pulled by the LIVE ga4-repull
 * lane (apps/stream-worker/src/jobs/ga4-repull/run.ts → emitRows). If the two lanes minted different
 * ids, Bronze could not dedup and backfilled history would DOUBLE-COUNT against live revenue.
 *
 * This proves the property by construction: the fetcher computes the id with GA4's OWN live id fn
 * (uuidV5FromGa4Row) and carries it verbatim on FetchedRecord.providerId. The test runs a
 * representative raw runReport row through the real fetcher (Ga4DataClient mocked — NO network) and
 * asserts the resulting providerId EQUALS uuidV5FromGa4Row(...) called with EXACTLY the args the live
 * lane passes (brandId, creds.propertyId, props.date, source/medium/campaign/channel/device/country).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Pool } from 'pg';
import {
  mapGa4RowToEvent,
  uuidV5FromGa4Row,
  type Ga4ReportRow,
} from '@brain/ga4-mapper';
import { buildGa4ResourceFetcher } from '../ga4-resource-fetchers.js';
import {
  Ga4DataClient,
  type Ga4OAuthCredentials,
  type Ga4RunReportResult,
} from '../../ga4-repull/ga4-data-client.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const BRAND_ID = '11111111-1111-1111-1111-111111111111';
const PROPERTY_ID = '987654321';
const CURRENCY = 'USD'; // both lanes hardcode USD today (same TODO)

const CREDS: Ga4OAuthCredentials = {
  kind: 'oauth',
  refreshToken: 'mock-refresh-token',
  clientId: 'mock-client-id',
  clientSecret: 'mock-client-secret',
  propertyId: PROPERTY_ID,
};

/** A representative GA4 runReport row covering every dedup dimension. */
const RAW_ROW: Ga4ReportRow = {
  date: '2026-06-15',
  sessionSource: 'google',
  sessionMedium: 'cpc',
  sessionCampaignName: 'spring_sale',
  sessionDefaultChannelGroup: 'Paid Search',
  deviceCategory: 'mobile',
  country: 'US',
  sessions: '120',
  totalRevenue: '12.34',
};

/** A row with absent dimensions — proves the empty-string normalization matches live exactly. */
const SPARSE_ROW: Ga4ReportRow = {
  date: '2026-06-10',
  sessions: '5',
  totalRevenue: '0',
};

function mockRunReport(rows: Ga4ReportRow[]): void {
  const result: Ga4RunReportResult = { rows, sampling: null, rowCount: rows.length };
  vi.spyOn(Ga4DataClient.prototype, 'authenticate').mockResolvedValue(undefined);
  vi.spyOn(Ga4DataClient.prototype, 'runReport').mockResolvedValue(result);
}

/**
 * Compute the id EXACTLY as the LIVE lane (ga4-repull/run.ts emitRows) does: map the raw row, then
 * call uuidV5FromGa4Row(brandId, creds.propertyId, props.date, props.session_* ?? '', ...).
 */
function liveLaneEventId(raw: Ga4ReportRow): string {
  const props = mapGa4RowToEvent(raw, CREDS.propertyId, CURRENCY, null).properties;
  return uuidV5FromGa4Row(
    BRAND_ID,
    CREDS.propertyId,
    props.date,
    props.session_source ?? '',
    props.session_medium ?? '',
    props.session_campaign_name ?? '',
    props.session_default_channel_group ?? '',
    props.device_category ?? '',
    props.country ?? '',
  );
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('GA4 backfill ↔ live event_id parity', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function buildFetcher() {
    return buildGa4ResourceFetcher({
      pool: {} as unknown as Pool, // GA4 fetcher never touches the pool
      connectorInstanceId: 'ci-ga4-1',
      resource: 'ga4.sessions',
      brandId: BRAND_ID,
      saltHex: 'deadbeef',
      secrets: CREDS,
    });
  }

  it('stamps providerId == the live ga4-repull event_id for a fully-populated row', async () => {
    mockRunReport([RAW_ROW]);
    const fetcher = buildFetcher();

    const page = await fetcher.fetchPage({
      resource: { name: 'ga4.sessions', pageSize: 28 } as never,
      cursor: '2026-06-20',
      floorAt: new Date('2026-06-01T00:00:00.000Z'),
    });

    expect(page.records).toHaveLength(1);
    expect(page.records[0]!.providerId).toBe(liveLaneEventId(RAW_ROW));
    // The composite tuple is no longer the identity carrier — only the precomputed id is.
    expect(page.records[0]!.compositeValues).toBeUndefined();
  });

  it('stamps providerId == the live event_id for a sparse row (absent dims → empty strings)', async () => {
    mockRunReport([SPARSE_ROW]);
    const fetcher = buildFetcher();

    const page = await fetcher.fetchPage({
      resource: { name: 'ga4.sessions', pageSize: 28 } as never,
      cursor: '2026-06-20',
      floorAt: new Date('2026-06-01T00:00:00.000Z'),
    });

    expect(page.records).toHaveLength(1);
    expect(page.records[0]!.providerId).toBe(liveLaneEventId(SPARSE_ROW));
  });

  it('the precomputed id is a non-empty deterministic uuid-shaped string', async () => {
    mockRunReport([RAW_ROW]);
    const fetcher = buildFetcher();
    const page = await fetcher.fetchPage({
      resource: { name: 'ga4.sessions', pageSize: 28 } as never,
      cursor: '2026-06-20',
      floorAt: new Date('2026-06-01T00:00:00.000Z'),
    });
    const id = page.records[0]!.providerId!;
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
