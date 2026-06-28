/**
 * /identity/customers — permanent redirect to /customers.
 * The customer browse list moved out of Identity into its own top-level Customers tab.
 * (customers-content.tsx alongside this file is the source the Customers slice re-homes.)
 */
import { redirect } from 'next/navigation';

export const metadata = { title: 'Customers — Brain' };

export default function CustomersRedirectPage() {
  redirect('/customers');
}
