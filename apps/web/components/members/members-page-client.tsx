'use client';

import { InviteMemberDialog } from '@/components/members/invite-member-dialog';
import { MembersTable } from '@/components/members/members-table';
import { PendingInvitesSection } from '@/components/members/pending-invites-section';
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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Team members</h1>
          <p className="text-muted-foreground mt-1">
            Manage who has access to your workspace.
          </p>
        </div>
        <InviteMemberDialog
          currentUserRole={currentUserRole}
          data-testid="invite-member-trigger"
        />
      </div>

      <MembersTable
        currentUserRole={currentUserRole}
        currentMemberId={currentMemberId}
      />

      {/* Pending invites section — visible to Owner and Brand Admin (D-4). */}
      {(currentUserRole === 'owner' || currentUserRole === 'brand_admin') && (
        <div className="space-y-3" data-testid="pending-invites-container">
          <h2 className="text-lg font-semibold text-foreground">Pending invitations</h2>
          <p className="text-sm text-muted-foreground">
            Invitations waiting to be accepted.
          </p>
          <PendingInvitesSection currentUserRole={currentUserRole} />
        </div>
      )}
    </div>
  );
}
