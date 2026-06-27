// gen-ga4-golden.ts — ADR-0006 P4: capture {raw GA4 row -> expected canonical} golden vectors by
// running the REAL @brain/ga4-mapper TS, so test_ga4-golden.py can assert the PySpark ports reproduce
// them byte-for-byte. Mirrors gen-shopify-golden.ts.
//
// event_id: there is no live ga4-repull yet, so we fix the canonical convention the connector record
// WILL use — uuidV5FromGa4Row(brand, propertyId, date, source, medium, campaign, channel, device,
// country), each dimension value defaulted null/absent -> '' (the documented seed contract). The
// PySpark event_id_ga4_session port reproduces this exact seed.
//
// Run:  pnpm tsx db/iceberg/spark/silver/_p4_golden/gen-ga4-golden.ts > db/iceberg/spark/silver/_p4_golden/ga4-rows-golden.json
import { mapGa4RowToEvent, uuidV5FromGa4Row } from '@brain/ga4-mapper';

const BRAND = '444a25f2-57d4-4e04-9f70-98a6480e1fc4';
const PROPERTY = '123456789';

// Representative raw GA4 runReport rows + the connector-record currency + (optional) sampling metadata.
const cases: { row: any; currency: string; sampling?: { samplesReadCount?: string | null; samplingSpaceSize?: string | null } | null }[] = [
  // Organic, full dimensions, 2-dp revenue, no sampling.
  { row: { date: '2026-06-15', sessionSource: 'google', sessionMedium: 'organic', sessionCampaignName: '(not set)', sessionDefaultChannelGroup: 'Organic Search', deviceCategory: 'desktop', country: 'US', sessions: '1200', engagedSessions: '850', bounces: '320', totalUsers: '1000', newUsers: '420', screenPageViews: '4500', eventCount: '9800', conversions: '55', totalRevenue: '1234.56' }, currency: 'USD' },
  // Paid search, lowercase currency (upcased), .00 revenue, sampled report.
  { row: { date: '2026-06-15', sessionSource: 'google', sessionMedium: 'cpc', sessionCampaignName: 'Brand_Summer_2026', sessionDefaultChannelGroup: 'Paid Search', deviceCategory: 'mobile', country: 'IN', sessions: '300', engagedSessions: '200', bounces: '90', totalUsers: '280', newUsers: '150', screenPageViews: '900', eventCount: '2100', conversions: '18', totalRevenue: '456.00' }, currency: 'inr', sampling: { samplesReadCount: '50000', samplingSpaceSize: '1000000' } },
  // Sparse row: only date + sessions; bounces from bounceRate*sessions; >2-dp revenue (truncates), missing dims -> null/''.
  { row: { date: '2026-06-01', sessions: '1000', bounceRate: '0.35', totalRevenue: '12.349' }, currency: 'AED' },
  // Zero-revenue direct/none traffic, three-decimal-rate edge, country only.
  { row: { date: '2026-06-02', sessionSource: '(direct)', sessionMedium: '(none)', sessionDefaultChannelGroup: 'Direct', deviceCategory: 'tablet', country: 'AE', sessions: '7', engagedSessions: '3', totalUsers: '7', newUsers: '5', screenPageViews: '21', eventCount: '40', conversions: '0', totalRevenue: '0' }, currency: 'AED' },
];

const vectors = cases.map(({ row, currency, sampling }) => {
  const ev = mapGa4RowToEvent(row, PROPERTY, currency, sampling ?? null);
  const date = String(row.date ?? '').trim();
  const s = (x: unknown) => (x == null ? '' : String(x));
  const event_id = uuidV5FromGa4Row(
    BRAND, PROPERTY, date,
    s(row.sessionSource), s(row.sessionMedium), s(row.sessionCampaignName),
    s(row.sessionDefaultChannelGroup), s(row.deviceCategory), s(row.country),
  );
  const p: any = ev.properties;
  return {
    raw_row: row,
    brand_id: BRAND,
    property_id: PROPERTY,
    currency_input: currency,
    samples_read_count: sampling?.samplesReadCount ?? null,
    sampling_space_size: sampling?.samplingSpaceSize ?? null,
    expected: {
      event_id,
      occurred_at: ev.occurred_at,
      revenue_minor: p.revenue_minor,
      currency_code: p.currency_code,
      sessions: p.sessions,
      engaged_sessions: p.engaged_sessions,
      bounces: p.bounces,
      total_users: p.total_users,
      new_users: p.new_users,
      screen_page_views: p.screen_page_views,
      event_count: p.event_count,
      conversions: p.conversions,
      is_sampled: p.is_sampled,
      samples_read_count: p.samples_read_count,
      sampling_space_size: p.sampling_space_size,
    },
  };
});

console.log(JSON.stringify(vectors, null, 2));
