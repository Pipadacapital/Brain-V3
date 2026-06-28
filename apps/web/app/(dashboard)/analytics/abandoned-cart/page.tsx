/**
 * /analytics/abandoned-cart — permanent redirect to /behaviour?tab=abandoned-cart.
 * Abandoned cart was consolidated into the Behaviour tab.
 */
import { redirect } from 'next/navigation';

export const metadata = { title: 'Abandoned Cart — Brain' };

export default function AbandonedCartPage() {
  redirect('/behaviour?tab=abandoned-cart');
}
