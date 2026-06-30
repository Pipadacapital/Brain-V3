/**
 * UTM Sources — "Where do my customers come from?" (server shell).
 *
 * A first-touch acquisition matrix under Marketing (P3): one row per (utm_source, utm_medium)
 * with visitors · conversions · attributed revenue · avg LTV · repeat-purchase rate, read from
 * gold_utm_source via the BFF /api/v1/analytics/utm-source endpoint (useUtmSource). Clicking a row
 * drills into the customers acquired from that source — the same identity browse list filtered by
 * acquisition_source (useCustomers({ acquisitionSource })).
 *
 * BFF-only (I-ST01): money is bigint minor units + sibling currency_code (never blended, never a
 * float). Honest-empty everywhere — no acquisition rows → EmptyState, never a fabricated matrix.
 */
import { UtmContent } from './utm-content';

export const metadata = { title: 'UTM Sources — Brain' };

export default function UtmPage() {
  return <UtmContent />;
}
