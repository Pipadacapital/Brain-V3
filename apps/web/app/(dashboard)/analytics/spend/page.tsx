/**
 * /analytics/spend — permanent redirect to /marketing?tab=spend.
 * Ad spend / ROAS was folded into the Marketing tab.
 */
import { redirect } from 'next/navigation';

export const metadata = { title: 'Ad Spend & ROAS — Brain' };

export default function SpendPage() {
  redirect('/marketing?tab=spend');
}
