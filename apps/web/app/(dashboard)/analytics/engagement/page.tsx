/**
 * Engagement page — server component shell (Silver tier).
 *
 * Stakeholder-visible storefront-engagement surface powered by the Silver tier (StarRocks
 * silver_touchpoint). Reads engaged (multi-touch) vs bounce sessions + avg touches via the BFF →
 * metric-engine storefront-engagement seam (I-ST01 — the UI NEVER queries StarRocks directly). Part of
 * Phase H (Universal Pixel).
 */
import { EngagementContent } from './engagement-content';

export const metadata = { title: 'Engagement — Brain' };

export default function EngagementPage() {
  return <EngagementContent />;
}
