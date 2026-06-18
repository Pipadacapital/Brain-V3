import { CreateBrandWorkspaceForm } from '@/components/onboarding/create-brand-workspace-form';
import { OnboardingGate } from '@/components/onboarding/onboarding-gate';

export const metadata = { title: 'Create your brand — Brain' };

/**
 * Step 1 of 3 — the merged create step (workspace + first brand, feat-onboarding-ux).
 *
 * Replaces the old two pages (/workspace/new + /brand/new). The OnboardingGate forward-redirects
 * a user who already provisioned (status brand_created+) so browser Back never re-shows this
 * form. `step="pending"` because this page handles the pending/org_created statuses.
 */
export default function OnboardingStartPage() {
  return (
    <OnboardingGate step="pending">
      <div>
        <div className="mb-8">
          <p
            className="text-xs font-medium text-muted-foreground tracking-wide uppercase mb-1"
            aria-label="Step 1 of 3"
            data-testid="step-indicator"
          >
            Step 1 of 3
          </p>
          <h2 className="text-2xl font-bold text-foreground">Set up your brand</h2>
          <p className="text-muted-foreground mt-1">
            Name your workspace and configure your first brand. We&apos;ll set up both.
          </p>
        </div>
        <CreateBrandWorkspaceForm />
      </div>
    </OnboardingGate>
  );
}
