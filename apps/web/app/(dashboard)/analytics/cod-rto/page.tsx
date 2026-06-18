/**
 * CoD / RTO Analytics page — server component shell (GoKwik + Shopflo Track C).
 *
 * Surfaces the India-D2C unit-economics signal Razorpay/Shopify don't carry:
 *   - RTO% by pincode cohort (GoKwik AWB terminal states)
 *   - CoD-vs-prepaid mix + CoD CM2 (ledger cod_* events — net of RTO clawback)
 *   - Shopflo abandoned-checkout funnel (REAL self-serve webhook)
 *
 * DEV-HONESTY: GoKwik AWB/RTO panels carry a "Synthetic (dev)" badge until a real
 * partner sandbox exists; Shopflo checkout data is REAL (no badge).
 */
import { CodRtoContent } from './cod-rto-content';

export const metadata = { title: 'CoD / RTO — Brain Analytics' };

export default function CodRtoPage() {
  return <CodRtoContent />;
}
