/**
 * Checkout Analytics page — server component shell (Shopflo Track C).
 *
 * Surfaces the checkout-step conversion signal:
 *   - Checkout-step funnel (Shopflo checkout_abandoned webhook — REAL self-serve)
 *   - Abandonment reasons       — honest-empty (no mart yet)
 *   - Device / browser breakdown — honest-empty (no mart yet)
 *
 * The funnel reuses the existing checkout-funnel hook/component (single sole-read path
 * via the BFF metric-engine — NO ad-hoc aggregation in the client). The two breakdown
 * panels render an honest EmptyState until their Gold marts exist — never a fabricated
 * zero.
 */
import { CheckoutContent } from './checkout-content';

export const metadata = { title: 'Checkout — Brain' };

export default function CheckoutPage() {
  return <CheckoutContent />;
}
