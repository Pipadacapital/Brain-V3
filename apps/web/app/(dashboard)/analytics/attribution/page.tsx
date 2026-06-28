/**
 * /analytics/attribution — permanent redirect to /marketing.
 * Attribution was folded into the Marketing tab (default sub-section).
 */
import { redirect } from 'next/navigation';

export const metadata = { title: 'Attribution — Brain' };

export default function AttributionPage() {
  redirect('/marketing');
}
