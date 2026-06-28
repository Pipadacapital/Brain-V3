/**
 * Identity — "Are profiles clean/merged correctly?" (server shell).
 * Top-level tab #8. Consolidates identity/merge-review + identity/pii-vault + graph health.
 * Honors ?tab= (merge-review | pii-vault | graph-health).
 *
 * NOTE: customer browse (/customers) and the per-customer profile (/customers/[id]) moved OUT
 * of the old Identity section into their own tabs (#2/#3). identity/customers and
 * identity/customer-360 now redirect there.
 */
import { IdentityContent } from './identity-content';

export const metadata = { title: 'Identity — Brain' };

export default async function IdentityPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  return <IdentityContent initialTab={typeof tab === 'string' ? tab : undefined} />;
}
