import { CreateBrandWorkspaceForm } from '@/components/onboarding/create-brand-workspace-form';
import { OnboardingGate } from '@/components/onboarding/onboarding-gate';
import { WizardSteps, WizardHeader } from '@/components/onboarding/wizard-steps';

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
      <div className="space-y-8">
        <WizardSteps current={1} />
        <WizardHeader
          title="Set up your brand"
          description="Name your workspace and configure your first brand — we’ll provision both. This is the foundation Brain builds your revenue truth on."
        />
        <CreateBrandWorkspaceForm />
      </div>
    </OnboardingGate>
  );
}
