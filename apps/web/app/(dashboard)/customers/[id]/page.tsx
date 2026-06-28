/**
 * Customer Profile — per-customer DETAIL view (tab #3), reached by clicking a row in
 * Customers. NOT a top-level nav item. The brain_id comes from the [id] route param
 * (replacing the old /identity/customer-360 lookup form).
 */
import { CustomerProfileContent } from './customer-profile-content';

export const metadata = { title: 'Customer Profile — Brain' };

export default async function CustomerProfilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <CustomerProfileContent brainId={id} />;
}
