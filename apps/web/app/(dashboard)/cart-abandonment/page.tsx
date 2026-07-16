/**
 * /cart-abandonment — cart-recovery surface (P2).
 * Reuses the useAbandonedCart hook (now backed by the Gold mart via the
 * mv_gold_abandoned_cart serving view) — recovery-rate KPI, outcome table, and a
 * disabled honest "Send reminder" stub.
 */
import { CartAbandonmentContent } from './cart-abandonment-content';

export const metadata = { title: 'Cart Abandonment — Brain' };

export default function CartAbandonmentPage() {
  return <CartAbandonmentContent />;
}
