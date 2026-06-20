/**
 * Order-status mix page — server component shell (Silver tier, Track 3).
 *
 * The FIRST stakeholder-visible surface powered by the new Silver analytics tier
 * (dbt → StarRocks silver.order_state). It reads counts + share by order lifecycle
 * state over a date range, via the BFF → metric-engine Silver seam (I-ST01 — the UI
 * NEVER queries StarRocks directly). order-status-mix is a NON-additive aggregation
 * computed in the metric-engine, not dbt (ADR-004).
 */
import { OrderStatusContent } from './order-status-content';

export const metadata = { title: 'Order Status — Brain' };

export default function OrderStatusPage() {
  return <OrderStatusContent />;
}
