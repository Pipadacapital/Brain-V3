/**
 * Journey / first-touch page — server component shell (Silver tier, Phase 4, Track 3).
 *
 * The SECOND stakeholder-visible surface powered by the Silver analytics tier
 * (dbt → StarRocks silver.touchpoint). It reads the first-touch channel mix, the
 * deterministic cart-stitch hit-rate, and a per-order touchpoint timeline — via the
 * BFF → metric-engine journey seam (I-ST01 — the UI NEVER queries StarRocks directly).
 * Every figure is a NON-additive aggregation / read projection computed in the
 * metric-engine (ADR-004), not dbt. There is no money on a touchpoint.
 */
import { JourneyContent } from './journey-content';

export const metadata = { title: 'Journey — Brain' };

export default function JourneyPage() {
  return <JourneyContent />;
}
