/**
 * Billing page — server-component shell (realized-GMV meter, P1 slice 1).
 * BFF-only (I-ST01): every figure is read via /api/v1/billing/periods.
 */
import { BillingContent } from './billing-content';

export const metadata = { title: 'Billing — Brain' };

export default function BillingPage() {
  return <BillingContent />;
}
