/**
 * Metrics Catalog — "What does Brain mean by each number, and can I prove it?" (server shell;
 * client work in MetricsContent). Surfaces the Wave-D semantic metric catalog + the Wave-C
 * "prove this number" lineage.
 */
import { MetricsContent } from './metrics-content';

export const metadata = { title: 'Metrics Catalog — Brain' };

export default function MetricsPage() {
  return <MetricsContent />;
}
