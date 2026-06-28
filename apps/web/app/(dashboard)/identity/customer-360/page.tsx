/**
 * /identity/customer-360 — permanent redirect to the new Customer Profile route.
 *
 * The brain_id LOOKUP form was replaced by clicking a row in Customers. We preserve the
 * old deep-link contract: /identity/customer-360?brain_id=X → /customers/X. With no
 * brain_id we land on the Customers list so the user can pick one.
 */
import { redirect } from 'next/navigation';

export const metadata = { title: 'Customer Profile — Brain' };

export default async function Customer360RedirectPage({
  searchParams,
}: {
  searchParams: Promise<{ brain_id?: string }>;
}) {
  const { brain_id } = await searchParams;
  if (typeof brain_id === 'string' && brain_id.length > 0) {
    redirect(`/customers/${encodeURIComponent(brain_id)}`);
  }
  redirect('/customers');
}
