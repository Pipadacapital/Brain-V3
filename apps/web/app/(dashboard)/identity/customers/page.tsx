/**
 * /identity/customers — permanent redirect to /customers.
 * The customer browse list moved out of Identity into its own top-level Customers tab
 * (see app/(dashboard)/customers/customers-content.tsx).
 */
import { redirect } from 'next/navigation';

export const metadata = { title: 'Customers — Brain' };

export default function CustomersRedirectPage() {
  redirect('/customers');
}
