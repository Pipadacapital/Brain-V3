/**
 * Customer 360 page — server-component shell (identity control-plane, P0-C slice 1).
 * BFF-only (I-ST01): every figure is read via /api/v1/identity/customer.
 */
import { Customer360Content } from './customer-360-content';

export const metadata = { title: 'Customer 360 — Brain Identity' };

export default function Customer360Page() {
  return <Customer360Content />;
}
