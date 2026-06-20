'use client';

import { useState } from 'react';
import { Loader2, Mail, RefreshCw, X } from 'lucide-react';
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
import { usePendingInvites, useResendInvite, useRevokeInvite } from '@/lib/hooks/use-members';
import { ROLE_LABELS, type InviteResponse, type RoleCode } from '@/lib/api/types';
import { BffApiError } from '@/lib/api/client';
import { toast } from '@/components/ui/toaster';

/** Format an ISO date string as a short human-readable date. */
function formatDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(iso));
  } catch {
    return iso;
  }
}

interface PendingInvitesSectionProps {
  /** Current user's role — visibility of resend/revoke actions matches what backend returns
   * (D-4: Owner sees all; Brand-Admin brand-scoped; Manager only own — backend enforces via RLS).
   * The UI just renders what the API returns. */
  currentUserRole?: RoleCode;
}

export function PendingInvitesSection({ currentUserRole = 'analyst' }: PendingInvitesSectionProps) {
  const { data, isLoading, error, refetch } = usePendingInvites();
  const { mutate: resendInvite, isPending: isResending } = useResendInvite();
  const { mutate: revokeInvite, isPending: isRevoking } = useRevokeInvite();

  const [revokeDialogInvite, setRevokeDialogInvite] = useState<InviteResponse | null>(null);
  const [resendingId, setResendingId] = useState<string | null>(null);

  // Manager and Analyst cannot see this section (they have no invite authority and
  // the backend returns an empty set for them per D-4). Hide to avoid a confusing empty section.
  if (currentUserRole === 'manager' || currentUserRole === 'analyst') {
    return null;
  }

  if (isLoading) {
    return (
      <div
        className="space-y-3"
        aria-busy="true"
        aria-label="Loading pending invites…"
        data-testid="pending-invites-section"
        data-state="loading"
      >
        {[1, 2].map((i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div data-testid="pending-invites-section" data-state="error">
        <ErrorCard error={error} retry={refetch} />
      </div>
    );
  }

  const invites = data?.data ?? [];

  if (invites.length === 0) {
    return (
      <EmptyState
        title="No pending invites"
        description="Invitations you send will appear here until accepted or expired."
        icon={<Mail className="h-8 w-8" />}
      />
    );
  }

  function handleResend(invite: InviteResponse) {
    setResendingId(invite.id);
    resendInvite(invite.id, {
      onSuccess: () => {
        toast({ title: 'Invite resent', description: `A new invite was sent to ${invite.email}.` });
        setResendingId(null);
      },
      onError: (err) => {
        const msg = err instanceof BffApiError ? err.message : "Couldn't resend the invite. Please try again.";
        toast({ title: "Couldn't resend the invite", description: msg, variant: 'destructive' });
        setResendingId(null);
      },
    });
  }

  function handleRevokeConfirm() {
    if (!revokeDialogInvite) return;
    const target = revokeDialogInvite;
    revokeInvite(target.id, {
      onSuccess: () => {
        toast({ title: 'Invite revoked', description: `The invite for ${target.email} has been revoked.` });
        setRevokeDialogInvite(null);
      },
      onError: (err) => {
        const msg = err instanceof BffApiError ? err.message : "Couldn't revoke the invite. Please try again.";
        toast({ title: "Couldn't revoke the invite", description: msg, variant: 'destructive' });
        setRevokeDialogInvite(null);
      },
    });
  }

  return (
    <>
      <div
        className="rounded-md border"
        role="table"
        aria-label="Pending invitations"
        data-testid="pending-invites-section"
      >
        <div
          className="grid grid-cols-[1fr_auto_auto_auto] gap-4 px-4 py-3 border-b bg-muted/50 text-xs font-medium text-muted-foreground uppercase tracking-wide"
          role="row"
        >
          <span role="columnheader">Email</span>
          <span role="columnheader">Role</span>
          <span role="columnheader">Expires</span>
          <span role="columnheader">
            <span className="sr-only">Actions</span>
          </span>
        </div>
        {invites.map((invite) => (
          <div
            key={invite.id}
            className="grid grid-cols-[1fr_auto_auto_auto] gap-4 items-center px-4 py-3 border-b last:border-0"
            role="row"
            data-testid={`pending-invite-row-${invite.id}`}
            aria-label={`Pending invite for ${invite.email}, role ${ROLE_LABELS[invite.role_code]}, expires ${formatDate(invite.expires_at)}`}
          >
            <div role="cell">
              <p className="text-sm font-medium text-foreground">{invite.email}</p>
            </div>
            <div role="cell">
              <Badge variant="outline" aria-label={`Invited as ${ROLE_LABELS[invite.role_code]}`}>
                {ROLE_LABELS[invite.role_code]}
              </Badge>
            </div>
            <div role="cell">
              <span className="text-xs text-muted-foreground">{formatDate(invite.expires_at)}</span>
            </div>
            <div role="cell" className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Resend invite to ${invite.email}`}
                onClick={() => handleResend(invite)}
                disabled={isResending && resendingId === invite.id}
                data-testid={`btn-resend-invite-${invite.id}`}
              >
                {isResending && resendingId === invite.id ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <RefreshCw className="h-4 w-4" aria-hidden="true" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Revoke invite for ${invite.email}`}
                className="text-destructive hover:text-destructive"
                onClick={() => setRevokeDialogInvite(invite)}
                data-testid={`btn-revoke-invite-${invite.id}`}
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
          </div>
        ))}
      </div>

      {/* Revoke invite confirmation dialog */}
      <Dialog
        open={!!revokeDialogInvite}
        onOpenChange={(o) => !o && setRevokeDialogInvite(null)}
      >
        <DialogContent aria-labelledby="revoke-dialog-title" aria-describedby="revoke-dialog-desc">
          <DialogHeader>
            <DialogTitle id="revoke-dialog-title">Revoke invitation</DialogTitle>
            <DialogDescription id="revoke-dialog-desc">
              Are you sure you want to revoke the invitation for{' '}
              <strong>{revokeDialogInvite?.email}</strong>? The invite link will stop working
              immediately.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevokeDialogInvite(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleRevokeConfirm}
              disabled={isRevoking}
              data-testid="btn-confirm-revoke"
            >
              {isRevoking && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
              Revoke invite
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
