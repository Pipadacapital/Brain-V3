/**
 * Customers — "Who are my customers?" (server shell; client work in CustomersContent).
 * Top-level tab #2. /identity/customers redirects here. Rows link → /customers/[id].
 */
import { CustomersContent } from './customers-content';

export const metadata = { title: 'Customers — Brain' };

export default function CustomersPage() {
  return <CustomersContent />;
}
