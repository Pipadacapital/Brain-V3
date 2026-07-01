/**
 * meta-backfill-parity.test.ts — REVENUE-TRUTH guard: the generic ingestion-backfill fetcher must
 * mint the SAME Bronze event_id as the live meta-spend-repull lane for the same daily insight row.
 *
 * THE BUG this locks down: the generic backfill used to derive event_id from a composite tuple
 * (stat_date, level, level_id) under the framework's OWN namespace, which is NOT byte-identical to the
 * live lane's `uuidV5FromSpendRow(brandId, 'meta', stat_date, level, level_id)` seed. Same record →
 * two ids → Bronze can't dedup → backfilled history DOUBLE-COUNTS against live data.
 *
 * THE FIX (proven here): the fetcher now PRECOMPUTES providerId by CALLING uuidV5FromSpendRow — the
 * exact id fn the live lane uses (meta-spend-repull/run.ts emitPage). This test builds a representative
 * raw Meta insight row, runs it through MetaInsightsFetcher.fetchPage (with a stubbed MetaInsightsClient
 * so no network is touched), and asserts the resulting FetchedRecord.providerId EQUALS the id the LIVE
 * lane would compute for that same row — i.e. a backfilled row gets the SAME event_id as live.
 */
import { describe, it, expect } from 'vitest';
import { mapMetaInsightToEvent, uuidV5FromSpendRow } from '@brain/ad-spend-mapper';
import { MetaInsightsFetcher } from '../meta-resource-fetchers.js';
import { META_ACCESS_FORBIDDEN, type MetaApiCredentials } from '../../meta-spend-repull/meta-insights-client.js';

const BRAND_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_CURRENCY = 'INR';
const ACCOUNT_TZ = 'Asia/Kolkata';

/** A representative raw Meta Insights row (campaign level) — the shape mapMetaInsightToEvent consumes. */
const RAW_ROW: Record<string, unknown> = {
  level: 'campaign',
  campaign_id: '1200001',
  campaign_name: 'Diwali Prospecting',
  date_start: '2026-06-01',
  date_stop: '2026-06-01',
  spend: '12345.67',
  impressions: '98765',
  clicks: '4321',
};

/**
 * Stub the MetaInsightsClient: return account meta once, and the whole-window fetch yields RAW_ROW for
 * the 'campaign' level and EMPTY for the other levels. No network. We override the fetcher's private
 * client field after construction.
 */
function stubClientOnto(fetcher: MetaInsightsFetcher): void {
  const fakeClient = {
    async fetchAccountMeta() {
      return { currencyCode: ACCOUNT_CURRENCY, timezoneName: ACCOUNT_TZ };
    },
    async fetchInsightsForWindow(level: 'campaign' | 'adset' | 'ad') {
      return level === 'campaign' ? [RAW_ROW] : [];
    },
  };
  // The fetcher holds the client on a private field; replace it for the test (no network).
  (fetcher as unknown as { client: typeof fakeClient }).client = fakeClient;
}

describe('meta backfill → live event_id parity (revenue-truth dedup)', () => {
  it('fetcher providerId == uuidV5FromSpendRow(...) with the live lane args', async () => {
    const creds: MetaApiCredentials = { accessToken: 'unused-in-test', adAccountId: 'act_1' };
    const fetcher = new MetaInsightsFetcher(creds, BRAND_ID);
    stubClientOnto(fetcher);

    const page = await fetcher.fetchPage({
      resource: { name: 'insights' } as never,
      cursor: '2026-06-15',                       // window until-edge
      floorAt: new Date('2026-05-20T00:00:00Z'),  // floor well below the row's date
    });

    expect(page.records.length).toBe(1);
    const record = page.records[0]!;

    // EXPECTED = exactly what the live meta-spend-repull lane computes (emitPage):
    //   uuidV5FromSpendRow(brandId, 'meta', props.stat_date, props.level, props.level_id)
    // where props come from the SAME frozen mapper.
    const props = mapMetaInsightToEvent(RAW_ROW, ACCOUNT_CURRENCY, ACCOUNT_TZ).properties;
    const expectedLiveId = uuidV5FromSpendRow(
      BRAND_ID, 'meta', props.stat_date, props.level, props.level_id,
    );

    // PARITY: the backfilled record carries the live id verbatim as providerId (the passthrough
    // deriver emits it as the Bronze event_id) → Bronze MERGE dedups → no double-count.
    expect(record.providerId).toBe(expectedLiveId);
    // And it no longer relies on the framework composite tuple for identity.
    expect(record.compositeValues).toBeUndefined();
  });

  it('a Meta 403 (accessible-history boundary) completes GRACEFULLY — null cursor, no throw', async () => {
    const creds: MetaApiCredentials = { accessToken: 'unused', adAccountId: 'act_1' };
    const fetcher = new MetaInsightsFetcher(creds, BRAND_ID);
    // Client resolves account meta, then 403s on the (older) insights window — the boundary signal.
    const forbiddenClient = {
      async fetchAccountMeta() {
        return { currencyCode: ACCOUNT_CURRENCY, timezoneName: ACCOUNT_TZ };
      },
      async fetchInsightsForWindow() {
        throw new Error(`${META_ACCESS_FORBIDDEN}: 403 Forbidden from Meta Insights`);
      },
    };
    (fetcher as unknown as { client: typeof forbiddenClient }).client = forbiddenClient;

    const page = await fetcher.fetchPage({
      resource: { name: 'insights' } as never,
      cursor: '2025-09-04',
      floorAt: new Date('2024-06-30T00:00:00Z'),
    });

    // GRACEFUL boundary: no throw, no records this window, and a null cursor so the resumable driver
    // marks the resource COMPLETED at the achieved depth (not RESOURCE_BACKFILL_FAILED).
    expect(page.nextCursor).toBeNull();
    expect(page.records).toHaveLength(0);
  });
});
