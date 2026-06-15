'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { InviteMemberDialog } from '@/components/members/invite-member-dialog';

export function InviteTeamForm() {
  const router = useRouter();

  function handleSkip() {
    router.push('/dashboard');
  }

  function handleDone() {
    router.push('/dashboard');
  }

  return (
    <div className="space-y-6">
      <div className="rounded-lg border bg-card p-6">
        <p className="text-sm text-muted-foreground mb-4">
          Invite your team members now, or skip this step and do it later from Settings.
        </p>
        <InviteMemberDialog onSuccess={handleDone} />
      </div>

      <div className="flex items-center justify-between">
        <Button variant="ghost" onClick={handleSkip}>
          Skip for now
        </Button>
        <Button onClick={handleDone}>Go to dashboard</Button>
      </div>
    </div>
  );
}
