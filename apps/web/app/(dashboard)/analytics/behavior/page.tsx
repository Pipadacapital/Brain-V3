/**
 * Behavior page — server component shell (Silver tier).
 *
 * Stakeholder-visible storefront-behavior surface powered by the Silver tier
 * (dbt → StarRocks silver_touchpoint). Reads page-type mix + top viewed products + top searches via
 * the BFF → metric-engine storefront-behavior seam (I-ST01 — the UI NEVER queries StarRocks directly).
 * Non-additive aggregation lives in the metric-engine (ADR-004), not dbt.
 */
import { BehaviorContent } from './behavior-content';

export const metadata = { title: 'Behavior — Brain' };

export default function BehaviorPage() {
  return <BehaviorContent />;
}
