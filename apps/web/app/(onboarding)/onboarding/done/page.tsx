import { OnboardingDoneStep } from '@/components/onboarding/onboarding-done-step';
import { OnboardingGate } from '@/components/onboarding/onboarding-gate';

export const metadata = { title: 'Setup Complete — Brain' };

export default function OnboardingDonePage() {
  return (
    <OnboardingGate step="integration_selected">
      <div>
        <div className="mb-8">
          <p
            className="text-xs font-medium text-muted-foreground tracking-wide uppercase mb-1"
            aria-label="Step 3 of 3"
            data-testid="step-indicator"
          >
            Step 3 of 3
          </p>
          <h2 className="text-2xl font-bold text-foreground">Your workspace is ready</h2>
          <p className="text-muted-foreground mt-1">
            Brain will build your revenue truth as your store data and tracking come in. Here&apos;s what&apos;s set up so far.
          </p>
        </div>
        <OnboardingDoneStep />
      </div>
    </OnboardingGate>
  );
}
