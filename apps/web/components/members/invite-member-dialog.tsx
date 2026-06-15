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
import { toast } from '@/components/ui/toaster';
import { ROLE_LABELS, type RoleCode } from '@/lib/api/types';
import { useState } from 'react';

const INVITABLE_ROLES: RoleCode[] = ['brand_admin', 'manager', 'analyst'];

interface InviteMemberDialogProps {
  onSuccess?: () => void;
}

export function InviteMemberDialog({ onSuccess }: InviteMemberDialogProps) {
  const [open, setOpen] = useState(false);
  const { mutate: inviteMember, isPending, error } = useInviteMember();
  const { data: workspaces } = useWorkspaceList();
  const organizationId = workspaces?.workspaces?.[0]?.id ?? '';

  const {
    register,
    handleSubmit,
    setValue,
    reset,
    formState: { errors },
  } = useForm<InviteMemberFormValues>({
    resolver: zodResolver(inviteMemberSchema),
    defaultValues: { email: '', role_code: 'analyst' },
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
      },
    );
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
                defaultValue="analyst"
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
                  {INVITABLE_ROLES.map((code) => (
                    <SelectItem key={code} value={code}>
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
            <Button type="submit" disabled={isPending} data-testid="btn-send-invite">
              {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
              {isPending ? 'Sending…' : 'Send invite'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
