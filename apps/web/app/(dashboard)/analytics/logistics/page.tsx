/**
 * Logistics page — server component shell (Silver tier, Slice 2).
 *
 * Stakeholder-visible shipment-outcomes surface powered by the Silver tier
 * (dbt → StarRocks silver_shipment). Reads delivery-vs-RTO outcomes + courier/pincode
 * RTO% via the BFF → metric-engine shipment-outcomes seam (I-ST01 — the UI NEVER queries
 * StarRocks directly). Multi-source (GoKwik AWB + Shiprocket). Non-additive aggregation lives
 * in the metric-engine (ADR-004), not dbt.
 */
import { LogisticsContent } from './logistics-content';

export const metadata = { title: 'Logistics — Brain' };

export default function LogisticsPage() {
  return <LogisticsContent />;
}
