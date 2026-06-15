import { InviteMemberDialog } from '@/components/members/invite-member-dialog';
import { MembersTable } from '@/components/members/members-table';

export const metadata = { title: 'Members — Brain' };

export default function MembersPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Team members</h1>
          <p className="text-muted-foreground mt-1">
            Manage who has access to your workspace.
          </p>
        </div>
        <InviteMemberDialog />
      </div>
      <MembersTable />
    </div>
  );
}
