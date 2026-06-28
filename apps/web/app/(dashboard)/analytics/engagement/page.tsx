/**
 * /analytics/engagement — permanent redirect to /behaviour?tab=engagement.
 * Engagement was consolidated into the Behaviour tab.
 */
import { redirect } from 'next/navigation';

export const metadata = { title: 'Engagement — Brain' };

export default function EngagementPage() {
  redirect('/behaviour?tab=engagement');
}
