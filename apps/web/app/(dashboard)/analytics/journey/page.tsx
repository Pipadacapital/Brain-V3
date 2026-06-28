/**
 * /analytics/journey — permanent redirect to /journeys.
 * The journey surface was re-homed as the Journeys tab.
 */
import { redirect } from 'next/navigation';

export const metadata = { title: 'Journeys — Brain' };

export default function JourneyPage() {
  redirect('/journeys');
}
