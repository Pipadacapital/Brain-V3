/**
 * /identity/merge-review — permanent redirect to /identity?tab=merge-review.
 * Merge review became a sub-tab of the consolidated Identity tab.
 */
import { redirect } from 'next/navigation';

export const metadata = { title: 'Merge Review — Brain Identity' };

export default function MergeReviewPage() {
  redirect('/identity?tab=merge-review');
}
