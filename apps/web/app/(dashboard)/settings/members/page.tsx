import { MembersPageClient } from '@/components/members/members-page-client';

export const metadata = { title: 'Members — Brain' };

/**
 * Members settings page — static shell (Server Component for metadata).
 * Role derivation and data fetching happen in the client component.
 */
export default function MembersPage() {
  return <MembersPageClient />;
}
