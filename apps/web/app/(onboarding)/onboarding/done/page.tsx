import { OnboardingDoneStep } from '@/components/onboarding/onboarding-done-step';
import { OnboardingGate } from '@/components/onboarding/onboarding-gate';
import { WizardSteps, WizardHeader } from '@/components/onboarding/wizard-steps';

export const metadata = { title: 'Setup Complete — Brain' };

export default function OnboardingDonePage() {
  return (
    <OnboardingGate step="integration_selected">
      <div className="space-y-8">
        <WizardSteps current={3} />
        <WizardHeader
          title="Your workspace is ready"
          description="Brain will build your revenue truth as your store data and tracking come in. Here’s what’s set up so far."
        />
        <OnboardingDoneStep />
      </div>
    </OnboardingGate>
  );
}
