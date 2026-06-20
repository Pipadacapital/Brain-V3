/**
 * Customer 360 page — server-component shell (identity control-plane, P0-C slice 1).
 * BFF-only (I-ST01): every figure is read via /api/v1/identity/customer.
 *
 * Accepts an optional ?brain_id= so the Customers browse list can deep-link straight into a
 * resolved profile (the row "Open" action) with the lookup prefilled and auto-run.
 */
import { Customer360Content } from './customer-360-content';

export const metadata = { title: 'Customer 360 — Brain Identity' };

export default async function Customer360Page({
  searchParams,
}: {
  searchParams: Promise<{ brain_id?: string }>;
}) {
  const { brain_id } = await searchParams;
  return <Customer360Content initialBrainId={typeof brain_id === 'string' ? brain_id : ''} />;
}
