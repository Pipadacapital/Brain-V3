/**
 * /analytics/order-status — permanent redirect to /analytics/orders?tab=status.
 *
 * The Order Status view was consolidated into the Orders page as its "Status" tab.
 * Old bookmarks and sidebar links automatically land on the correct tab.
 */
import { redirect } from 'next/navigation';

export const metadata = { title: 'Order Status — Brain' };

export default function OrderStatusPage() {
  redirect('/analytics/orders?tab=status');
}
