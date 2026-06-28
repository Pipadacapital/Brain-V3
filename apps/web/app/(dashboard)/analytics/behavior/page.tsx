/**
 * /analytics/behavior — permanent redirect to /behaviour (Overview).
 * Behavior was consolidated into the Behaviour tab.
 */
import { redirect } from 'next/navigation';

export const metadata = { title: 'Behaviour — Brain' };

export default function BehaviorPage() {
  redirect('/behaviour');
}
