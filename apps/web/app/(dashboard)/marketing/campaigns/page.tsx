/**
 * Campaigns — "Which CAMPAIGNS work?" (server shell).
 *
 * A deep, per-campaign drill-down under Marketing (P2). Where the Marketing tab answers the
 * channel-level question, this page answers the campaign-level one: a campaign performance table
 * (attributed revenue · spend · ROAS under the selected attribution model), an attributed-revenue
 * over-time chart, a 2-campaign compare mode, and honest-empty creatives + demographic breakdowns
 * (no mart yet — we never fabricate rows).
 *
 * All reads go through the BFF /api/v1/analytics/attribution/* endpoints (campaign-attribution +
 * campaign-timeseries) — brand from the session, money as bigint minor + currency_code.
 */
import { CampaignsContent } from './campaigns-content';

export const metadata = { title: 'Campaigns — Brain' };

export default function CampaignsPage() {
  return <CampaignsContent />;
}
