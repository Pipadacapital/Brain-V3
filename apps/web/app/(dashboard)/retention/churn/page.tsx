/**
 * Churn risk — "Who is about to leave, and what do I do?" (server shell).
 *
 * Sub-route of Retention. Surfaces the customer list filtered to the at-risk / churned
 * RFM band (identity/customers + ml/customer-score) with churn risk, lifetime value and
 * last-active, plus a "Create win-back" affordance that pre-fills a saved segment.
 */
import { ChurnContent } from './churn-content';

export const metadata = { title: 'Churn risk — Brain' };

export default function ChurnPage() {
  return <ChurnContent />;
}
