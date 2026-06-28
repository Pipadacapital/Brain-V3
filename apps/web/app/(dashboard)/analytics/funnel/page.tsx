/**
 * /analytics/funnel — permanent redirect to /behaviour?tab=funnel.
 * The checkout funnel was consolidated into the Behaviour tab.
 */
import { redirect } from 'next/navigation';

export const metadata = { title: 'Funnel — Brain' };

export default function FunnelPage() {
  redirect('/behaviour?tab=funnel');
}
