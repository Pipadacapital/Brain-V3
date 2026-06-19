/**
 * Recommendations page — server-component shell (decision engine, doc 09).
 * BFF-only (I-ST01): every recommendation is read via /api/v1/recommendations.
 */
import { RecommendationsContent } from './recommendations-content';

export const metadata = { title: 'Recommendations — Brain' };

export default function RecommendationsPage() {
  return <RecommendationsContent />;
}
