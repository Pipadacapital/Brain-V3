/**
 * Data — connector records browser (server shell).
 *
 * Newest-first, paginated (20/page) tables of the canonical records each connector produces:
 * orders (mv_silver_order_state), shipments (mv_silver_shipment), ad spend (mv_silver_marketing_spend),
 * with a date-range filter + free-text search. All reads are brand-scoped through the metric-engine seam.
 */
import { DataContent } from './data-content';

export const metadata = { title: 'Data — Brain' };

export default function DataPage() {
  return <DataContent />;
}
