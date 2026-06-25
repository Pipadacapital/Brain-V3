'use client';

import { InviteMemberDialog } from '@/components/members/invite-member-dialog';
import { MembersTable } from '@/components/members/members-table';
import { PendingInvitesSection } from '@/components/members/pending-invites-section';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { useMemberList } from '@/lib/hooks/use-members';
import { useCurrentUser } from '@/lib/hooks/use-auth';
import type { RoleCode } from '@/lib/api/types';

/**
 * Client component for the Members page.
 *
 * Role derivation strategy:
 *   1. Fetch current user id from /auth/me (useCurrentUser).
 *   2. Find this user in the members list by app_user_id → get their role_code.
 *   3. Pass role down to InviteMemberDialog, MembersTable, and PendingInvitesSection
 *      for hierarchy gating (D-6/D-7 UI side). Server is always authoritative — 403s
 *      from the server surface as toasts rather than silent failures.
 */
export function MembersPageClient() {
  const { data: meData } = useCurrentUser();
  const { data: membersData } = useMemberList();

  // Derive the current user's role from the members list.
  // app_user_id links the /auth/me user to their membership row.
  const currentUserId = meData?.user?.id ?? null;
  const selfMember = currentUserId
    ? (membersData?.data ?? []).find((m) => m.app_user_id === currentUserId)
    : undefined;
  const currentUserRole: RoleCode = (selfMember?.role_code as RoleCode) ?? 'analyst';
  const currentMemberId = selfMember?.id;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Team members"
        description="Manage who has access to your workspace and what they can do."
        actions={
          <InviteMemberDialog
            currentUserRole={currentUserRole}
            data-testid="invite-member-trigger"
          />
        }
      />

      <SectionCard
        title="Members"
        description="People with access to this workspace and their assigned roles."
        flush
      >
        <MembersTable
          currentUserRole={currentUserRole}
          currentMemberId={currentMemberId}
        />
      </SectionCard>

      {/* Pending invites section — visible to Owner and Brand Admin (D-4). */}
      {(currentUserRole === 'owner' || currentUserRole === 'brand_admin') && (
        <SectionCard
          title="Pending invitations"
          description="Invitations that have been sent but not yet accepted."
          flush
          data-testid="pending-invites-container"
        >
          <PendingInvitesSection currentUserRole={currentUserRole} />
        </SectionCard>
      )}
    </div>
  );
}
