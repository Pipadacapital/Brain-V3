'use client';

import { useState } from 'react';
import { Loader2, Trash2, Shield, Users, PauseCircle, PlayCircle } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { EmptyState } from '@/components/ui/empty-state';
import { BffApiError } from '@/lib/api/client';
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
import {
  useMemberList,
  useUpdateMemberRole,
  useRemoveMember,
  useSuspendMember,
  useReactivateMember,
} from '@/lib/hooks/use-members';
import { ROLE_LABELS, type RoleCode, type MemberResponse } from '@/lib/api/types';
import { toast } from '@/components/ui/toaster';

/**
 * Role hierarchy — higher index = more authority.
 * Owner (3) > Brand Admin (2) > Manager (1) > Analyst (0).
 * Used to gate which roles the current actor can assign.
 */
const ROLE_HIERARCHY: RoleCode[] = ['analyst', 'manager', 'brand_admin', 'owner'];

/**
 * Returns the list of roles a user with `actorRole` is permitted to assign.
 * Owner can assign any role below owner (brand_admin, manager, analyst).
 * Brand Admin can assign manager and analyst only.
 * Manager/Analyst cannot assign roles at all (empty set).
 */
function assignableRoles(actorRole: RoleCode): RoleCode[] {
  const actorIdx = ROLE_HIERARCHY.indexOf(actorRole);
  // Actor can only grant roles STRICTLY below their own index (D-6/D-7 mirror).
  return ROLE_HIERARCHY.filter((r) => ROLE_HIERARCHY.indexOf(r) < actorIdx);
}

/**
 * Returns true when the actor outranks the target (strictly).
 * Used to gate suspend/reactivate/remove affordances.
 */
function actorOutranks(actorRole: RoleCode, targetRole: RoleCode): boolean {
  return ROLE_HIERARCHY.indexOf(actorRole) > ROLE_HIERARCHY.indexOf(targetRole);
}

const ROLE_BADGE_VARIANTS: Record<RoleCode, 'default' | 'secondary' | 'outline'> = {
  owner: 'default',
  brand_admin: 'secondary',
  manager: 'secondary',
  analyst: 'outline',
};

interface MembersTableProps {
  /** The current session user's role. Resolved from LoginResponse/session. Defaults to 'analyst' (most restrictive). */
  currentUserRole?: RoleCode;
  /** The current session user's membership id — used to hide self-action buttons. */
  currentMemberId?: string;
}

export function MembersTable({ currentUserRole = 'analyst', currentMemberId }: MembersTableProps) {
  const { data, isLoading, error, refetch } = useMemberList();
  const { mutate: updateRole, isPending: isUpdatingRole } = useUpdateMemberRole();
  const { mutate: removeMember, isPending: isRemoving } = useRemoveMember();
  const { mutate: suspendMember, isPending: isSuspending } = useSuspendMember();
  const { mutate: reactivateMember, isPending: isReactivating } = useReactivateMember();

  const [roleDialogMember, setRoleDialogMember] = useState<MemberResponse | null>(null);
  const [removeDialogMember, setRemoveDialogMember] = useState<MemberResponse | null>(null);
  const [suspendDialogMember, setSuspendDialogMember] = useState<MemberResponse | null>(null);
  const [selectedRole, setSelectedRole] = useState<RoleCode>('analyst');

  const rolesActorCanAssign = assignableRoles(currentUserRole);

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
    if (error instanceof BffApiError && error.status === 403) {
      return (
        <EmptyState
          title="Setup required"
          description="Complete onboarding to manage team members."
          icon={<Users className="h-8 w-8" />}
          action={
            <Link href="/workspace/new" className="text-sm text-primary underline-offset-4 hover:underline">
              Continue setup
            </Link>
          }
        />
      );
    }
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
          toast({
            title: 'Role updated',
            description: `${roleDialogMember.user_full_name} is now ${ROLE_LABELS[selectedRole]}.`,
          });
          setRoleDialogMember(null);
        },
        onError: (err) => {
          const msg = err instanceof BffApiError ? err.message : "Couldn't update the role. Please try again.";
          toast({ title: "Couldn't update the role", description: msg, variant: 'destructive' });
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
      onError: (err) => {
        const msg = err instanceof BffApiError ? err.message : "Couldn't remove the member. Please try again.";
        toast({ title: "Couldn't remove the member", description: msg, variant: 'destructive' });
      },
    });
  }

  function handleSuspendConfirm() {
    if (!suspendDialogMember) return;
    suspendMember(suspendDialogMember.id, {
      onSuccess: () => {
        toast({
          title: 'Member suspended',
          description: `${suspendDialogMember.user_full_name}'s sessions have been revoked.`,
        });
        setSuspendDialogMember(null);
      },
      onError: (err) => {
        const msg = err instanceof BffApiError ? err.message : "Couldn't suspend the member. Please try again.";
        toast({ title: "Couldn't suspend the member", description: msg, variant: 'destructive' });
        setSuspendDialogMember(null);
      },
    });
  }

  function handleReactivate(member: MemberResponse) {
    reactivateMember(member.id, {
      onSuccess: () => {
        toast({ title: 'Member reactivated', description: `${member.user_full_name} can now access the workspace.` });
      },
      onError: (err) => {
        const msg = err instanceof BffApiError ? err.message : "Couldn't reactivate the member. Please try again.";
        toast({ title: "Couldn't reactivate the member", description: msg, variant: 'destructive' });
      },
    });
  }

  return (
    <>
      {/* Members list */}
      <div className="rounded-md border" role="table" aria-label="Team members">
        <div
          className="grid grid-cols-[1fr_auto_auto_auto] gap-4 px-4 py-3 border-b bg-muted/50 text-xs font-medium text-muted-foreground uppercase tracking-wide"
          role="row"
        >
          <span role="columnheader">Member</span>
          <span role="columnheader">Status</span>
          <span role="columnheader">Role</span>
          <span role="columnheader">
            <span className="sr-only">Actions</span>
          </span>
        </div>
        {members.map((member) => {
          const isSelf = member.id === currentMemberId;
          const isOwner = member.role_code === 'owner';
          const isSuspended = member.user_status === 'suspended';
          const canActOnMember = !isSelf && !isOwner && actorOutranks(currentUserRole, member.role_code);
          const canChangeRole = canActOnMember && rolesActorCanAssign.length > 0;

          return (
            <div
              key={member.id}
              className={`grid grid-cols-[1fr_auto_auto_auto] gap-4 items-center px-4 py-3 border-b last:border-0 ${isSuspended ? 'bg-muted/30 opacity-75' : ''}`}
              role="row"
              data-testid={`member-row-${member.id}`}
              aria-label={`${member.user_full_name}, ${ROLE_LABELS[member.role_code]}, ${isSuspended ? 'suspended' : 'active'}`}
            >
              <div role="cell">
                <p className="text-sm font-medium text-foreground">{member.user_full_name}</p>
                <p className="text-xs text-muted-foreground">{member.user_email}</p>
              </div>
              <div role="cell">
                {isSuspended ? (
                  <Badge
                    variant="outline"
                    className="text-amber-700 border-amber-300 bg-amber-50"
                    aria-label="Status: Suspended"
                    data-testid={`badge-suspended-${member.id}`}
                  >
                    Suspended
                  </Badge>
                ) : (
                  <Badge
                    variant="outline"
                    className="text-green-700 border-green-300 bg-green-50"
                    aria-label="Status: Active"
                    data-testid={`badge-active-${member.id}`}
                  >
                    Active
                  </Badge>
                )}
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
                {canChangeRole && (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Change role for ${member.user_full_name}`}
                    onClick={() => {
                      // Pre-select a role the actor can actually assign (default to first available).
                      const preselect = rolesActorCanAssign.includes(member.role_code)
                        ? member.role_code
                        : (rolesActorCanAssign[0] ?? 'analyst');
                      setSelectedRole(preselect);
                      setRoleDialogMember(member);
                    }}
                    data-testid={`btn-change-role-${member.id}`}
                  >
                    <Shield className="h-4 w-4" aria-hidden="true" />
                  </Button>
                )}
                {canActOnMember && !isSuspended && (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Suspend ${member.user_full_name}`}
                    className="text-amber-600 hover:text-amber-700"
                    onClick={() => setSuspendDialogMember(member)}
                    data-testid={`btn-suspend-${member.id}`}
                  >
                    <PauseCircle className="h-4 w-4" aria-hidden="true" />
                  </Button>
                )}
                {canActOnMember && isSuspended && (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Reactivate ${member.user_full_name}`}
                    className="text-green-600 hover:text-green-700"
                    onClick={() => handleReactivate(member)}
                    disabled={isReactivating}
                    data-testid={`btn-reactivate-${member.id}`}
                  >
                    {isReactivating ? (
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <PlayCircle className="h-4 w-4" aria-hidden="true" />
                    )}
                  </Button>
                )}
                {canActOnMember && (
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
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Change role dialog — hierarchy-gated (D-6/D-7 UI side) */}
      <Dialog
        open={!!roleDialogMember}
        onOpenChange={(o) => !o && setRoleDialogMember(null)}
      >
        <DialogContent aria-labelledby="role-dialog-title" aria-describedby="role-dialog-desc">
          <DialogHeader>
            <DialogTitle id="role-dialog-title">Change role</DialogTitle>
            <DialogDescription id="role-dialog-desc">
              Update the role for {roleDialogMember?.user_full_name ?? 'this member'}. Only roles
              below your authority are shown.
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <Select
              value={selectedRole}
              onValueChange={(v) => setSelectedRole(v as RoleCode)}
            >
              <SelectTrigger aria-label="Select new role" data-testid="select-new-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {rolesActorCanAssign.map((code) => (
                  <SelectItem key={code} value={code} data-testid={`role-option-${code}`}>
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
            <Button
              onClick={handleUpdateRole}
              disabled={isUpdatingRole}
              data-testid="btn-confirm-role-change"
            >
              {isUpdatingRole && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Suspend confirmation dialog — warns sessions will be revoked immediately */}
      <Dialog
        open={!!suspendDialogMember}
        onOpenChange={(o) => !o && setSuspendDialogMember(null)}
      >
        <DialogContent aria-labelledby="suspend-dialog-title" aria-describedby="suspend-dialog-desc">
          <DialogHeader>
            <DialogTitle id="suspend-dialog-title">Suspend member</DialogTitle>
            <DialogDescription id="suspend-dialog-desc">
              Suspending <strong>{suspendDialogMember?.user_full_name}</strong> will immediately
              revoke all their active sessions. They will not be able to access the workspace until
              reactivated.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSuspendDialogMember(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleSuspendConfirm}
              disabled={isSuspending}
              data-testid="btn-confirm-suspend"
            >
              {isSuspending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
              Suspend member
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
