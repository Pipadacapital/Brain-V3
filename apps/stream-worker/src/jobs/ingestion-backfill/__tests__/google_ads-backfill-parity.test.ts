/**
 * google_ads-backfill-parity.test.ts — REVENUE-TRUTH guard: a Google Ads spend row pulled through
 * the GENERIC ingestion-backfill fetcher must mint the BYTE-IDENTICAL Bronze event_id as the live /
 * trailing-window repull lane (google-ads-spend-repull/run.ts emitRows).
 *
 * Why this matters: both lanes can land the SAME (brand, platform, stat_date, level, level_id) spend
 * row. If the backfill derived a different event_id than the live repull, Bronze could NOT dedup the
 * two → backfilled history would DOUBLE-COUNT against live spend (CAC/ROAS corruption). The fix is
 * that the fetcher PRECOMPUTES the id by calling the live lane's own uuidV5FromSpendRow and carries
 * it as FetchedRecord.providerId (the driver's passthrough deriver emits it verbatim).
 *
 * This test mirrors the live emitRows id call EXACTLY:
 *   uuidV5FromSpendRow(brandId, 'google_ads', props.stat_date, props.level, props.level_id)
 * and asserts the fetcher's FetchedRecord.providerId equals it for a representative raw GAQL row.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { uuidV5FromSpendRow, mapGoogleRowToEvent } from '@brain/ad-spend-mapper';

// Mock the SearchStream client so the fetcher walks our representative raw row without any network /
// auth. Only the 'campaign' level returns a row; the other levels return empty (one record total).
// vi.hoisted: the factory below is hoisted above this file's top-level consts, so the mock fn must be
// created in a hoisted block to be referenceable inside the factory.
const { streamLevelMock } = vi.hoisted(() => ({ streamLevelMock: vi.fn() }));
vi.mock('../../google-ads-spend-repull/google-ads-searchstream-client.js', () => ({
  GoogleAdsSearchStreamClient: class {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(_secrets: any) {}
    async authenticate(): Promise<void> {
      /* no-op (no network in test) */
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async streamLevel(level: string, _from: string, _to: string): Promise<any[]> {
      return streamLevelMock(level);
    }
  },
}));

// Imported AFTER vi.mock so the fetcher binds the mocked client.
const { buildGoogleAdsResourceFetcher } = await import('../google-ads-resource-fetchers.js');

const BRAND_ID = '11111111-1111-1111-1111-111111111111';
const CAMPAIGN_ID = '987654321';
const STAT_DATE = '2026-05-15';

/** A representative raw GAQL campaign-level spend row, as GoogleAdsSearchStreamClient yields. */
function rawCampaignRow(): Record<string, unknown> {
  return {
    level: 'campaign',
    campaign_id: CAMPAIGN_ID,
    campaign_name: 'Spring Sale',
    segments_date: STAT_DATE,
    cost_micros: '12340000', // 1234 minor units
    impressions: '1000',
    clicks: '50',
    conversions: '3',
    all_conversions: '4',
    conversions_value: '99.5',
    currency_code: 'INR',
  };
}

describe('google_ads backfill ⇄ live event_id parity (revenue-truth)', () => {
  beforeEach(() => {
    streamLevelMock.mockReset();
    // Only campaign level returns the row; adset/ad return empty → exactly one FetchedRecord.
    streamLevelMock.mockImplementation((level: string) =>
      level === 'campaign' ? [rawCampaignRow()] : [],
    );
  });

  it('fetcher stamps providerId == uuidV5FromSpendRow(...) with the EXACT live-lane args', async () => {
    const fetcher = buildGoogleAdsResourceFetcher({
      // pool is unused by the spend fetcher; a stub satisfies the shape.
      pool: {} as never,
      connectorInstanceId: 'ci-google-1',
      resource: 'spend',
      brandId: BRAND_ID,
      saltHex: 'deadbeef',
      secrets: {} as never,
    });

    const page = await fetcher.fetchPage({
      resource: { name: 'spend' } as never,
      cursor: STAT_DATE, // anchor this chunk's newest edge at our row's date (deterministic)
      floorAt: new Date(`${STAT_DATE}T00:00:00Z`),
    });

    expect(page.records).toHaveLength(1);
    const record = page.records[0]!;

    // The live lane (google-ads-spend-repull/run.ts emitRows) maps the SAME raw row and seeds the id
    // from the mapped props — reproduce that here to prove byte-exact parity by construction.
    const mapped = mapGoogleRowToEvent(rawCampaignRow(), 'INR', null);
    const expectedLiveId = uuidV5FromSpendRow(
      BRAND_ID,
      'google_ads',
      mapped.properties.stat_date,
      mapped.properties.level,
      mapped.properties.level_id!,
    );

    expect(record.providerId).toBe(expectedLiveId);
    // Identity is carried as a precomputed providerId — NOT a composite tuple (passthrough deriver).
    expect(record.compositeValues).toBeUndefined();
    // Sanity: the id is seeded from the canonical spend grain (campaign level → campaign_id).
    expect(record.providerId).toBe(
      uuidV5FromSpendRow(BRAND_ID, 'google_ads', STAT_DATE, 'campaign', CAMPAIGN_ID),
    );
  });
});
