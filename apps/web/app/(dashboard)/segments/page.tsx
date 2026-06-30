/**
 * Segments — "Who do I want to target?" (server shell; client work in SegmentsContent).
 *
 * Top-level tab: a visual customer-segment builder (recency / frequency / monetary / lifecycle /
 * affinity / churn-risk conditions) with a LIVE debounced preview count, plus the brand's saved
 * segments (create / delete) and a client-side CSV export of the saved list. Sub-tool of Customers.
 */
import { SegmentsContent } from './segments-content';

export const metadata = { title: 'Segments — Brain' };

export default function SegmentsPage() {
  return <SegmentsContent />;
}
