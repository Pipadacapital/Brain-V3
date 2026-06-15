import { InviteTeamForm } from '@/components/onboarding/invite-team-form';

export const metadata = { title: 'Invite Team — Brain' };

export default function InvitePage() {
  return (
    <div>
      <div className="mb-8">
        <p className="text-xs font-medium text-muted-foreground tracking-wide uppercase mb-1">
          Step 3 of 3
        </p>
        <h2 className="text-2xl font-bold text-foreground">Invite your team</h2>
        <p className="text-muted-foreground mt-1">
          You can always add more team members from the Settings page.
        </p>
      </div>
      <InviteTeamForm />
    </div>
  );
}
