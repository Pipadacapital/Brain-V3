/**
 * Customers page — server-component shell for the identity control-plane browse surface.
 * BFF-only (I-ST01): every row is read via /api/v1/identity/customers.
 */
import { CustomersContent } from './customers-content';

export const metadata = { title: 'Customers — Brain Identity' };

export default function CustomersPage() {
  return <CustomersContent />;
}
