/**
 * Order detail page — server component shell (Next 15: params is a Promise).
 * Renders the captured economic breakdown of one order (feat-shopify-order-depth).
 */
import { OrderDetailContent } from './order-detail-content';

export const metadata = { title: 'Order detail — Brain' };

export default async function OrderDetailPage({ params }: { params: Promise<{ order_id: string }> }) {
  const { order_id } = await params;
  return <OrderDetailContent orderId={decodeURIComponent(order_id)} />;
}
