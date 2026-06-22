/**
 * Funnel page — server component shell (Silver tier).
 *
 * Stakeholder-visible storefront conversion-funnel surface powered by the Silver tier
 * (dbt → StarRocks silver_touchpoint). Reads sessions → product views → cart adds → purchases via
 * the BFF → metric-engine storefront-funnel seam (I-ST01 — the UI NEVER queries StarRocks directly).
 * Non-additive aggregation lives in the metric-engine (ADR-004), not dbt. Part of Phase H (Universal Pixel).
 */
import { FunnelContent } from './funnel-content';

export const metadata = { title: 'Funnel — Brain' };

export default function FunnelPage() {
  return <FunnelContent />;
}
