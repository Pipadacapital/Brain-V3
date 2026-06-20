/**
 * Settlements Analytics page — server component shell (Razorpay Track C).
 * Surfaces net-of-fees realized revenue from Razorpay settlement reconciliation.
 */
import { SettlementsContent } from './settlements-content';

export const metadata = { title: 'Settlements — Brain' };

export default function SettlementsPage() {
  return <SettlementsContent />;
}
