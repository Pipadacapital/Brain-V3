/**
 * Insights & Copilot page — server component shell (Next.js App Router).
 * Client data-fetching is delegated to InsightsContent (use client).
 */
import { InsightsContent } from './insights-content';

export const metadata = { title: 'Insights & Copilot — Brain' };

export default function InsightsPage() {
  return <InsightsContent />;
}
