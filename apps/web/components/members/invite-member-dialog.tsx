'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ErrorCard } from '@/components/ui/error-card';
import { inviteMemberSchema, type InviteMemberFormValues } from '@/lib/api/schemas';
import { useInviteMember } from '@/lib/hooks/use-members';
import { useWorkspaceList } from '@/lib/hooks/use-workspace';
import { useEmailVerified } from '@/lib/hooks/use-auth';
import { BffApiError } from '@/lib/api/client';
import { toast } from '@/components/ui/toaster';
import { ROLE_LABELS, type RoleCode } from '@/lib/api/types';
import { useState } from 'react';

/**
 * Role hierarchy — higher index = more authority.
 * Used to compute which roles the current actor can invite (D-6 UI side).
 */
const ROLE_HIERARCHY: RoleCode[] = ['analyst', 'manager', 'brand_admin', 'owner'];

/**
 * Returns the roles the actor may invite — strictly below their own authority.
 * Owner → brand_admin, manager, analyst.
 * Brand Admin → manager, analyst.
 * Manager / Analyst → [] (no invite permission; button hidden entirely).
 */
function invitableRoles(actorRole: RoleCode): RoleCode[] {
  const actorIdx = ROLE_HIERARCHY.indexOf(actorRole);
  return ROLE_HIERARCHY.filter((r) => ROLE_HIERARCHY.indexOf(r) < actorIdx);
}

interface InviteMemberDialogProps {
  onSuccess?: () => void;
  /** Current session user's role — gates which roles are offered and whether the button renders. */
  currentUserRole?: RoleCode;
}

/** Soft-gate reason copy for inviting members before email is verified. */
const VERIFY_TO_INVITE = 'Verify your email to invite members';

export function InviteMemberDialog({ onSuccess, currentUserRole = 'analyst' }: InviteMemberDialogProps) {
  const [open, setOpen] = useState(false);
  const { mutate: inviteMember, isPending, error } = useInviteMember();
  const { data: workspaces } = useWorkspaceList();
  const { emailVerified } = useEmailVerified();
  const organizationId = workspaces?.workspaces?.[0]?.id ?? '';

  const allowedRoles = invitableRoles(currentUserRole);
  // Manager and Analyst cannot invite anyone — hide the button entirely (D-6).
  const canInvite = allowedRoles.length > 0;

  const {
    register,
    handleSubmit,
    setValue,
    reset,
    formState: { errors },
  } = useForm<InviteMemberFormValues>({
    resolver: zodResolver(inviteMemberSchema),
    defaultValues: { email: '', role_code: (allowedRoles[0] ?? 'analyst') },
  });

  function onSubmit(data: InviteMemberFormValues) {
    if (!organizationId) return;
    inviteMember(
      { email: data.email, role_code: data.role_code, organization_id: organizationId },
      {
        onSuccess: () => {
          toast({ title: 'Invitation sent', description: `An invite was sent to ${data.email}.` });
          reset();
          setOpen(false);
          onSuccess?.();
        },
        onError: (err) => {
          // The server is the authoritative soft-gate (feat-onboarding-ux): an unverified
          // user gets 403 EMAIL_NOT_VERIFIED even if the UI hint was bypassed — surface a
          // clear, actionable message. Other 403s (role hierarchy) keep the generic copy.
          if (err instanceof BffApiError && err.code === 'EMAIL_NOT_VERIFIED') {
            toast({
              title: 'Verify your email first',
              description: `${VERIFY_TO_INVITE}. Check your inbox for the verification link.`,
              variant: 'destructive',
            });
            return;
          }
          const apiErr = err as { message?: string };
          toast({ title: 'Invite failed', description: apiErr.message ?? 'Unable to send invite.' });
        },
      },
    );
  }

  // Gate: Manager/Analyst cannot invite — render nothing (D-6).
  if (!canInvite) {
    return null;
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button data-testid="btn-invite-member">
          <UserPlus className="mr-2 h-4 w-4" aria-hidden="true" />
          Invite member
        </Button>
      </DialogTrigger>
      <DialogContent aria-labelledby="invite-dialog-title" aria-describedby="invite-dialog-desc">
        <DialogHeader>
          <DialogTitle id="invite-dialog-title">Invite a team member</DialogTitle>
          <DialogDescription id="invite-dialog-desc">
            They will receive an email invitation to join this workspace.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} noValidate>
          <div className="space-y-4 py-2">
            {error && <ErrorCard error={error} />}

            {/* Soft-gate reason hint — UX guidance only; the server gate is authoritative. */}
            {!emailVerified && (
              <p
                id="invite-verify-hint"
                role="note"
                data-testid="invite-verify-hint"
                className="rounded-md border border-warning/30 bg-warning-subtle px-3 py-2 text-xs text-warning-subtle-foreground"
              >
                {VERIFY_TO_INVITE}. We&apos;ll send the invite once your email is verified.
              </p>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="invite-email">Email address</Label>
              <Input
                id="invite-email"
                type="email"
                placeholder="colleague@company.com"
                aria-required="true"
                aria-invalid={!!errors.email}
                aria-describedby={errors.email ? 'invite-email-error' : undefined}
                data-testid="input-invite-email"
                {...register('email')}
              />
              {errors.email && (
                <p id="invite-email-error" className="text-xs text-destructive" role="alert">
                  {errors.email.message}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="invite-role">Role</Label>
              <Select
                defaultValue={allowedRoles[0] ?? 'analyst'}
                onValueChange={(v) => setValue('role_code', v as RoleCode)}
              >
                <SelectTrigger
                  id="invite-role"
                  aria-label="Select role for the invited member"
                  data-testid="select-invite-role"
                >
                  <SelectValue placeholder="Select a role" />
                </SelectTrigger>
                <SelectContent>
                  {allowedRoles.map((code) => (
                    <SelectItem key={code} value={code} data-testid={`invite-role-option-${code}`}>
                      {ROLE_LABELS[code]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.role_code && (
                <p className="text-xs text-destructive" role="alert">
                  {errors.role_code.message}
                </p>
              )}
            </div>
          </div>
          <DialogFooter className="mt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={isPending || !emailVerified}
              aria-describedby={!emailVerified ? 'invite-verify-hint' : undefined}
              title={!emailVerified ? VERIFY_TO_INVITE : undefined}
              data-testid="btn-send-invite"
            >
              {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
              {isPending ? 'Sending…' : 'Send invite'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
