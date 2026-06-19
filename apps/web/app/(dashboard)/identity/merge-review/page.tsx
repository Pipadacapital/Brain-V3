/**
 * Merge Review page — server-component shell (identity control-plane, P0-C).
 * BFF-only (I-ST01): reads /api/v1/identity/merge-reviews; acts via /resolve.
 */
import { MergeReviewContent } from './merge-review-content';

export const metadata = { title: 'Merge Review — Brain Identity' };

export default function MergeReviewPage() {
  return <MergeReviewContent />;
}
