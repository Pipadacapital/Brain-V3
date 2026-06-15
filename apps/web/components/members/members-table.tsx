'use client';

import { useState } from 'react';
import { Loader2, MoreHorizontal, Trash2, Shield } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { EmptyState } from '@/components/ui/empty-state';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useMemberList, useUpdateMemberRole, useRemoveMember } from '@/lib/hooks/use-members';
import { ROLE_LABELS, type RoleCode, type MemberResponse } from '@/lib/api/types';
import { toast } from '@/components/ui/toaster';

const ROLE_BADGE_VARIANTS: Record<RoleCode, 'default' | 'secondary' | 'outline'> = {
  owner: 'default',
  brand_admin: 'secondary',
  manager: 'secondary',
  analyst: 'outline',
};

export function MembersTable() {
  const { data, isLoading, error, refetch } = useMemberList();
  const { mutate: updateRole, isPending: isUpdatingRole } = useUpdateMemberRole();
  const { mutate: removeMember, isPending: isRemoving } = useRemoveMember();

  const [roleDialogMember, setRoleDialogMember] = useState<MemberResponse | null>(null);
  const [removeDialogMember, setRemoveDialogMember] = useState<MemberResponse | null>(null);
  const [selectedRole, setSelectedRole] = useState<RoleCode>('analyst');

  if (isLoading) {
    return (
      <div className="space-y-3" aria-busy="true" aria-label="Loading members…">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </div>
    );
  }

  if (error) {
    return <ErrorCard error={error} retry={refetch} />;
  }

  const members = data?.data ?? [];

  if (members.length === 0) {
    return (
      <EmptyState
        title="No members yet"
        description="Invite team members to collaborate on this workspace."
      />
    );
  }

  function handleUpdateRole() {
    if (!roleDialogMember) return;
    updateRole(
      { memberId: roleDialogMember.id, role_code: selectedRole },
      {
        onSuccess: () => {
          toast({ title: 'Role updated', description: `${roleDialogMember.user_full_name} is now ${ROLE_LABELS[selectedRole]}.` });
          setRoleDialogMember(null);
        },
      },
    );
  }

  function handleRemove() {
    if (!removeDialogMember) return;
    removeMember(removeDialogMember.id, {
      onSuccess: () => {
        toast({ title: 'Member removed', description: `${removeDialogMember.user_full_name} has been removed.` });
        setRemoveDialogMember(null);
      },
    });
  }

  return (
    <>
      {/* Members list */}
      <div className="rounded-md border" role="table" aria-label="Team members">
        <div
          className="grid grid-cols-[1fr_auto_auto] gap-4 px-4 py-3 border-b bg-muted/50 text-xs font-medium text-muted-foreground uppercase tracking-wide"
          role="row"
        >
          <span role="columnheader">Member</span>
          <span role="columnheader">Role</span>
          <span role="columnheader">
            <span className="sr-only">Actions</span>
          </span>
        </div>
        {members.map((member) => (
          <div
            key={member.id}
            className="grid grid-cols-[1fr_auto_auto] gap-4 items-center px-4 py-3 border-b last:border-0"
            role="row"
            data-testid={`member-row-${member.id}`}
          >
            <div role="cell">
              <p className="text-sm font-medium text-foreground">{member.user_full_name}</p>
              <p className="text-xs text-muted-foreground">{member.user_email}</p>
            </div>
            <div role="cell">
              <Badge
                variant={ROLE_BADGE_VARIANTS[member.role_code]}
                aria-label={`Role: ${ROLE_LABELS[member.role_code]}`}
              >
                {ROLE_LABELS[member.role_code]}
              </Badge>
            </div>
            <div role="cell" className="flex items-center gap-1">
              {member.role_code !== 'owner' && (
                <>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Change role for ${member.user_full_name}`}
                    onClick={() => {
                      setSelectedRole(member.role_code);
                      setRoleDialogMember(member);
                    }}
                    data-testid={`btn-change-role-${member.id}`}
                  >
                    <Shield className="h-4 w-4" aria-hidden="true" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${member.user_full_name}`}
                    className="text-destructive hover:text-destructive"
                    onClick={() => setRemoveDialogMember(member)}
                    data-testid={`btn-remove-member-${member.id}`}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Change role dialog */}
      <Dialog
        open={!!roleDialogMember}
        onOpenChange={(o) => !o && setRoleDialogMember(null)}
      >
        <DialogContent aria-labelledby="role-dialog-title" aria-describedby="role-dialog-desc">
          <DialogHeader>
            <DialogTitle id="role-dialog-title">Change role</DialogTitle>
            <DialogDescription id="role-dialog-desc">
              Update the role for {roleDialogMember?.user_full_name ?? 'this member'}.
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <Select
              value={selectedRole}
              onValueChange={(v) => setSelectedRole(v as RoleCode)}
            >
              <SelectTrigger aria-label="Select new role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(['brand_admin', 'manager', 'analyst'] as RoleCode[]).map((code) => (
                  <SelectItem key={code} value={code}>
                    {ROLE_LABELS[code]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRoleDialogMember(null)}>
              Cancel
            </Button>
            <Button onClick={handleUpdateRole} disabled={isUpdatingRole}>
              {isUpdatingRole && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove member dialog */}
      <Dialog
        open={!!removeDialogMember}
        onOpenChange={(o) => !o && setRemoveDialogMember(null)}
      >
        <DialogContent aria-labelledby="remove-dialog-title" aria-describedby="remove-dialog-desc">
          <DialogHeader>
            <DialogTitle id="remove-dialog-title">Remove member</DialogTitle>
            <DialogDescription id="remove-dialog-desc">
              Are you sure you want to remove{' '}
              <strong>{removeDialogMember?.user_full_name}</strong> from the workspace? This
              cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveDialogMember(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleRemove}
              disabled={isRemoving}
              data-testid="btn-confirm-remove"
            >
              {isRemoving && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
              Remove member
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
